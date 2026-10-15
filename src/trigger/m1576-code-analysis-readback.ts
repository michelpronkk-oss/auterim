import { schemaTask, AbortTaskRunError } from "@trigger.dev/sdk";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import {
  CODE_ANALYSIS_READBACK_COMMIT,
  CODE_ANALYSIS_READBACK_ID,
  CODE_ANALYSIS_READBACK_PRODUCT,
  CODE_ANALYSIS_READBACK_REPOSITORY,
  CODE_ANALYSIS_READBACK_WORKSPACE,
  EXTERNAL_REFERENCE_TYPES,
  RELATION_TYPES,
  assessPartialCauses,
  histogram,
  isSafeReadbackPath,
  persistedCredentialLikeValueCount,
  safeReadbackValue,
  safeSourceSpanMatch,
  type PersistedReadbackRun,
} from "@/lib/code-intelligence/readback";
import { CODE_SCAN_LIMITS } from "@/lib/code-intelligence/analyzer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  GitHubAppInstallationError,
  GitHubAppRepositoryProvider,
} from "@/lib/preflight/github-provider";
import type { RepositoryTarget } from "@/lib/preflight/preflight";

const MAX_ROWS = 20_000;
const PAGE_SIZE = 1_000;
const MAX_SOURCE_FILES = 20;
const MAX_SOURCE_BYTES = 2_000_000;

const schema = z.object({ analysisRunId: z.literal(CODE_ANALYSIS_READBACK_ID) }).strict();

type ExternalRow = {
  id: string;
  analysis_run_id: string;
  entity_id: string;
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  reference_type: string;
  normalized_value: string;
  path: string;
  start_line: number;
  end_line: number;
  confidence_class: string;
  redacted: boolean;
  value_fingerprint: string | null;
  extractor_type: string;
};
type EntityRow = {
  id: string;
  analysis_run_id: string;
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  entity_type: string;
  name: string;
  language: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
  confidence_class: string;
  extractor_type: string;
};
type RelationRow = {
  id: string;
  analysis_run_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  confidence_class: string;
};
type SkipRow = { path: string; skip_reason: string; byte_size: number };

async function readBoundedRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: unknown;
  }>,
) {
  const rows: T[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await fetchPage(offset, offset + PAGE_SIZE - 1);
    if (error || !data) throw new AbortTaskRunError("readback_query_failed");
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
  throw new AbortTaskRunError("readback_row_bound_exceeded");
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function referenceSamples(rows: ExternalRow[]) {
  const limits: Record<string, number> = {
    package: 2,
    import: 3,
    sdk_call: 2,
    event: 2,
    endpoint: 2,
    dynamic_endpoint: 2,
    environment_variable: 2,
    schema: 2,
  };
  return EXTERNAL_REFERENCE_TYPES.flatMap((type) =>
    rows
      .filter((row) => row.reference_type === type && !row.redacted)
      .filter((row) => safeReadbackValue(type, row.normalized_value) !== null)
      .filter((row) => isSafeReadbackPath(row.path))
      .sort((left, right) =>
        `${left.path}\0${left.start_line}\0${left.id}`.localeCompare(
          `${right.path}\0${right.start_line}\0${right.id}`,
        ),
      )
      .slice(0, limits[type] ?? 0),
  );
}

async function readSourceSpan(
  root: string,
  reference: ExternalRow,
  cache: Map<string, string | null>,
  readState: { files: number; bytes: number },
) {
  if (!isSafeReadbackPath(reference.path)) return false;
  let source = cache.get(reference.path);
  if (source === undefined) {
    if (readState.files >= MAX_SOURCE_FILES) return false;
    const rootReal = await realpath(root);
    const absolute = path.resolve(rootReal, ...reference.path.split("/"));
    if (!absolute.startsWith(`${rootReal}${path.sep}`)) return false;
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) return false;
    const resolved = await realpath(absolute).catch(() => null);
    if (!resolved || !resolved.startsWith(`${rootReal}${path.sep}`)) return false;
    const maxBytes = reference.path === "package.json" ? 5_000_000 : CODE_SCAN_LIMITS.maxFileBytes;
    if (info.size > maxBytes || readState.bytes + info.size > MAX_SOURCE_BYTES) return false;
    const content = await readFile(absolute);
    readState.files += 1;
    readState.bytes += content.byteLength;
    source = content.toString("utf8").includes("\uFFFD") ? null : content.toString("utf8");
    cache.set(reference.path, source);
  }
  return source
    ? safeSourceSpanMatch(
        reference.reference_type,
        reference.normalized_value,
        reference.path,
        source,
        reference.start_line,
        reference.end_line,
      )
    : false;
}

async function readEntitySpan(
  root: string,
  entity: EntityRow | undefined,
  cache: Map<string, string | null>,
  readState: { files: number; bytes: number },
) {
  if (!entity || !isSafeReadbackPath(entity.path) || !entity.start_line || !entity.end_line)
    return false;
  const reference: ExternalRow = {
    id: entity.id,
    analysis_run_id: entity.analysis_run_id,
    entity_id: entity.id,
    workspace_id: entity.workspace_id,
    repository_id: entity.repository_id,
    commit_sha: entity.commit_sha,
    reference_type: "schema",
    normalized_value: entity.name,
    value_fingerprint: null,
    path: entity.path,
    start_line: entity.start_line,
    end_line: entity.end_line,
    confidence_class: entity.confidence_class,
    redacted: false,
    extractor_type: entity.extractor_type,
  };
  if (!isSafeReadbackPath(reference.path)) return false;
  let source = cache.get(reference.path);
  if (source === undefined) {
    if (readState.files >= MAX_SOURCE_FILES) return false;
    const rootReal = await realpath(root);
    const absolute = path.resolve(rootReal, ...reference.path.split("/"));
    if (!absolute.startsWith(`${rootReal}${path.sep}`)) return false;
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) return false;
    const resolved = await realpath(absolute).catch(() => null);
    if (!resolved || !resolved.startsWith(`${rootReal}${path.sep}`)) return false;
    const maxBytes = reference.path === "package.json" ? 5_000_000 : CODE_SCAN_LIMITS.maxFileBytes;
    if (info.size > maxBytes || readState.bytes + info.size > MAX_SOURCE_BYTES) return false;
    const content = await readFile(absolute);
    readState.files += 1;
    readState.bytes += content.byteLength;
    source = content.toString("utf8").includes("\uFFFD") ? null : content.toString("utf8");
    cache.set(reference.path, source);
  }
  if (!source) return false;
  const span = source
    .split(/\r?\n/)
    .slice(entity.start_line - 1, entity.end_line)
    .join("\n");
  return Boolean(span && entity.name && span.includes(entity.name));
}

export const m1576CodeAnalysisReadback = schemaTask({
  id: "m1576-code-analysis-readback",
  schema,
  retry: { maxAttempts: 1 },
  maxDuration: 180,
  concurrency: { total: 1 },
  run: async ({ analysisRunId }) => {
    if (process.env.NODE_ENV !== "production" || process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1")
      throw new AbortTaskRunError("production_readback_runtime_required");
    const supabase = createSupabaseServerClient();
    const { data: run, error: runError } = await supabase
      .from("code_analysis_runs")
      .select(
        "id,workspace_id,product_id,repository_id,commit_sha,status,coverage_state,files_discovered,files_analyzed,files_skipped,parse_failures,bytes_analyzed,analyzer_version,language_profile,analysis_profile",
      )
      .eq("id", analysisRunId)
      .maybeSingle();
    if (runError || !run) throw new AbortTaskRunError("analysis_run_read_failed");
    const persistedRun = run as PersistedReadbackRun;
    if (
      persistedRun.id !== CODE_ANALYSIS_READBACK_ID ||
      persistedRun.workspace_id !== CODE_ANALYSIS_READBACK_WORKSPACE ||
      (persistedRun.product_id !== null &&
        persistedRun.product_id !== CODE_ANALYSIS_READBACK_PRODUCT) ||
      persistedRun.repository_id !== CODE_ANALYSIS_READBACK_REPOSITORY ||
      persistedRun.commit_sha !== CODE_ANALYSIS_READBACK_COMMIT ||
      persistedRun.status !== "completed"
    )
      throw new AbortTaskRunError("analysis_identity_mismatch");

    const [entities, references, relations, skips] = await Promise.all([
      readBoundedRows<EntityRow>((from, to) =>
        supabase
          .from("code_entities")
          .select(
            "id,analysis_run_id,workspace_id,repository_id,commit_sha,entity_type,name,language,path,start_line,end_line,confidence_class,extractor_type",
          )
          .eq("analysis_run_id", analysisRunId)
          .order("id")
          .range(from, to),
      ),
      readBoundedRows<ExternalRow>((from, to) =>
        supabase
          .from("code_external_references")
          .select(
            "id,analysis_run_id,entity_id,workspace_id,repository_id,commit_sha,reference_type,normalized_value,value_fingerprint,path,start_line,end_line,confidence_class,redacted,extractor_type",
          )
          .eq("analysis_run_id", analysisRunId)
          .order("id")
          .range(from, to),
      ),
      readBoundedRows<RelationRow>((from, to) =>
        supabase
          .from("code_relations")
          .select("id,analysis_run_id,from_entity_id,to_entity_id,relation_type,confidence_class")
          .eq("analysis_run_id", analysisRunId)
          .order("id")
          .range(from, to),
      ),
      readBoundedRows<SkipRow>((from, to) =>
        supabase
          .from("code_analysis_skipped_files")
          .select("path,skip_reason,byte_size")
          .eq("analysis_run_id", analysisRunId)
          .order("path")
          .order("skip_reason")
          .range(from, to),
      ),
    ]);

    const entityById = new Map(entities.map((row) => [row.id, row]));
    const relationEndpointIntegrity = relations.every((row) => {
      const from = entityById.get(row.from_entity_id);
      const to = entityById.get(row.to_entity_id);
      return Boolean(
        row.analysis_run_id === analysisRunId &&
        from?.analysis_run_id === analysisRunId &&
        to?.analysis_run_id === analysisRunId,
      );
    });
    if (!relationEndpointIntegrity)
      throw new AbortTaskRunError("relation_endpoint_integrity_failed");
    const identityMismatches =
      entities.filter(
        (row) =>
          row.analysis_run_id !== analysisRunId ||
          row.workspace_id !== CODE_ANALYSIS_READBACK_WORKSPACE ||
          row.repository_id !== CODE_ANALYSIS_READBACK_REPOSITORY ||
          row.commit_sha !== CODE_ANALYSIS_READBACK_COMMIT,
      ).length +
      references.filter(
        (row) =>
          row.analysis_run_id !== analysisRunId ||
          !entityById.has(row.entity_id) ||
          row.workspace_id !== CODE_ANALYSIS_READBACK_WORKSPACE ||
          row.repository_id !== CODE_ANALYSIS_READBACK_REPOSITORY ||
          row.commit_sha !== CODE_ANALYSIS_READBACK_COMMIT,
      ).length +
      relations.filter((row) => row.analysis_run_id !== analysisRunId).length;
    if (identityMismatches !== 0) throw new AbortTaskRunError("fact_identity_mismatch");

    const referenceCounts = Object.fromEntries(
      EXTERNAL_REFERENCE_TYPES.map((type) => [type, 0]),
    ) as Record<(typeof EXTERNAL_REFERENCE_TYPES)[number], number>;
    for (const row of references) {
      if (row.reference_type in referenceCounts) increment(referenceCounts, row.reference_type);
    }
    const relationCounts = Object.fromEntries(RELATION_TYPES.map((type) => [type, 0])) as Record<
      (typeof RELATION_TYPES)[number],
      number
    >;
    for (const row of relations) {
      if (row.relation_type in relationCounts) increment(relationCounts, row.relation_type);
    }
    const skipGroups = new Map<
      string,
      { reason: string; count: number; totalBytes: number; classification: string }
    >();
    for (const row of skips) {
      const classification =
        assessPartialCauses([{ reason: row.skip_reason, path: row.path }]).causes[0]
          ?.classification ?? "OTHER_INCOMPLETE";
      const key = `${row.skip_reason}\0${classification}`;
      const current = skipGroups.get(key) ?? {
        reason: row.skip_reason,
        count: 0,
        totalBytes: 0,
        classification,
      };
      current.count += 1;
      current.totalBytes += Number(row.byte_size) || 0;
      skipGroups.set(key, current);
    }
    const skipReasonBreakdown = [...skipGroups.values()].sort((left, right) =>
      `${left.reason}\0${left.classification}`.localeCompare(
        `${right.reason}\0${right.classification}`,
      ),
    );
    const partialAssessment = assessPartialCauses(
      skips.map((row) => ({ reason: row.skip_reason, path: row.path })),
    );

    const sourceLike = (value: string) => /\.(?:[cm]?js|jsx|tsx?|cts|mts)$/i.test(value);
    const analyzedSourceFiles = entities.filter(
      (row) => row.entity_type === "file" && ["javascript", "typescript"].includes(row.language),
    ).length;
    const directlySkippedSourceFiles = skips.filter((row) => sourceLike(row.path)).length;
    const knownSourceCandidates = analyzedSourceFiles + directlySkippedSourceFiles;
    const bounds = new Set([
      "file_count_limit",
      "parse_time_budget",
      "file_size_limit",
      "repository_byte_limit",
      "traversal_entry_limit",
      "fact_count_limit",
    ]);
    const supportedSourceSkippedByBounds = skips.filter(
      (row) => sourceLike(row.path) && bounds.has(row.skip_reason),
    ).length;
    const directorySkipCount = skips.filter((row) =>
      row.skip_reason.startsWith("generated_directory:"),
    ).length;
    const supportedSourceCoveragePercent = knownSourceCandidates
      ? Math.round((analyzedSourceFiles / knownSourceCandidates) * 10_000) / 100
      : null;

    const credentialLikeCount = persistedCredentialLikeValueCount([
      ...entities.flatMap((row) => [row.name, row.path]),
      ...references.flatMap((row) => [row.normalized_value, row.path]),
      ...skips.map((row) => row.path),
    ]);
    const invalidRedactions = references.filter(
      (row) =>
        row.redacted &&
        (row.normalized_value !== "[redacted]" ||
          !/^[a-f0-9]{64}$/.test(row.value_fingerprint ?? "")),
    ).length;
    if (credentialLikeCount > 0 || invalidRedactions > 0)
      throw new AbortTaskRunError("persisted_sensitive_fact_detected");

    const repository = await supabase
      .from("repositories")
      .select("id,workspace_id,connection_id,external_id,owner,name,default_branch,status")
      .eq("id", CODE_ANALYSIS_READBACK_REPOSITORY)
      .eq("workspace_id", CODE_ANALYSIS_READBACK_WORKSPACE)
      .eq("status", "available")
      .maybeSingle();
    if (
      repository.error ||
      !repository.data ||
      `${repository.data.owner}/${repository.data.name}`.toLowerCase() !==
        "michelpronkk-oss/auterim"
    )
      throw new AbortTaskRunError("canonical_repository_read_failed");
    const connection = await supabase
      .from("repository_connections")
      .select("id,workspace_id,installation_id,status,provider")
      .eq("id", repository.data.connection_id)
      .eq("workspace_id", CODE_ANALYSIS_READBACK_WORKSPACE)
      .eq("provider", "github")
      .eq("status", "connected")
      .maybeSingle();
    const externalId = Number(repository.data.external_id);
    const installationId = Number(connection.data?.installation_id);
    if (
      connection.error ||
      !connection.data ||
      !Number.isSafeInteger(externalId) ||
      !Number.isSafeInteger(installationId)
    )
      throw new AbortTaskRunError("canonical_installation_read_failed");

    if (persistedRun.product_id !== null) {
      const productMapping = await supabase
        .from("workspace_product_repositories")
        .select("workspace_id,protected_product_id,repository_id,status")
        .eq("workspace_id", CODE_ANALYSIS_READBACK_WORKSPACE)
        .eq("protected_product_id", CODE_ANALYSIS_READBACK_PRODUCT)
        .eq("repository_id", CODE_ANALYSIS_READBACK_REPOSITORY)
        .eq("status", "active")
        .maybeSingle();
      if (productMapping.error || !productMapping.data)
        throw new AbortTaskRunError("canonical_product_mapping_read_failed");
    }

    const environment = getEnvironment();
    if (!environment.GITHUB_APP_ID || !environment.GITHUB_APP_PRIVATE_KEY)
      throw new AbortTaskRunError("github_config_unavailable");
    const provider = new GitHubAppRepositoryProvider({
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
    });
    const target: RepositoryTarget = {
      id: CODE_ANALYSIS_READBACK_REPOSITORY,
      workspaceId: CODE_ANALYSIS_READBACK_WORKSPACE,
      owner: repository.data.owner,
      name: repository.data.name,
      defaultBranch: repository.data.default_branch,
      externalId,
      installationId,
      commitSha: CODE_ANALYSIS_READBACK_COMMIT,
    };
    const app = await provider.verifyAppIdentity();
    if (!app.matchesConfiguredAppId) throw new AbortTaskRunError("github_app_identity_mismatch");
    const install = await provider.verifyInstallation(installationId);
    if (
      install.id !== installationId ||
      install.accountLogin.toLowerCase() !== "michelpronkk-oss" ||
      install.repositorySelection !== "selected" ||
      install.permissions.contents !== "read" ||
      install.permissions.metadata !== "read" ||
      !Object.values(install.permissions).every((permission) => permission === "read")
    )
      throw new AbortTaskRunError("github_installation_scope_unexpected");
    const access = await provider.verifyRepositoryAccess(target);
    if (!access.matchesCanonicalRepository)
      throw new AbortTaskRunError("github_repository_identity_mismatch");
    const exactCommit = await provider.verifyExactCommit(target, CODE_ANALYSIS_READBACK_COMMIT);
    if (!exactCommit.exactShaMatch) throw new AbortTaskRunError("github_exact_commit_unavailable");

    let temporaryRoot: string | null = null;
    const spotChecks: Array<Record<string, unknown>> = [];
    let sourceBytesRead = 0;
    let sourceFilesRead = 0;
    try {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "auterim-m1576-readback-"));
      await provider.materializeRepository(target, CODE_ANALYSIS_READBACK_COMMIT, temporaryRoot);
      const cache = new Map<string, string | null>();
      const readState = { files: 0, bytes: 0 };
      const samples = referenceSamples(references);
      for (const row of samples) {
        let sourceMatch = false;
        try {
          sourceMatch = await readSourceSpan(temporaryRoot, row, cache, readState);
        } catch {
          sourceMatch = false;
        }
        spotChecks.push({
          kind: "reference",
          type: row.reference_type,
          value: safeReadbackValue(row.reference_type, row.normalized_value),
          path: row.path,
          startLine: row.start_line,
          endLine: row.end_line,
          extractorType: row.extractor_type,
          confidenceClass: row.confidence_class,
          commitSha: CODE_ANALYSIS_READBACK_COMMIT,
          sourceMatch,
        });
      }
      const relationSamples = [...new Set(relations.map((row) => row.relation_type).sort())]
        .slice(0, 3)
        .map((type) => relations.find((row) => row.relation_type === type)!)
        .map(async (row) => {
          const from = entityById.get(row.from_entity_id);
          const to = entityById.get(row.to_entity_id);
          return {
            kind: "relation",
            type: row.relation_type,
            fromPath: from && isSafeReadbackPath(from.path) ? from.path : "[withheld]",
            fromLine: from?.start_line ?? null,
            toPath: to && isSafeReadbackPath(to.path) ? to.path : "[withheld]",
            toLine: to?.start_line ?? null,
            confidenceClass: row.confidence_class,
            commitSha: CODE_ANALYSIS_READBACK_COMMIT,
            endpointsPersisted: Boolean(
              from &&
              to &&
              from.analysis_run_id === analysisRunId &&
              to.analysis_run_id === analysisRunId,
            ),
            endpointSourceMatches: [
              await readEntitySpan(temporaryRoot!, from, cache, readState),
              await readEntitySpan(temporaryRoot!, to, cache, readState),
            ],
          };
        });
      spotChecks.push(...(await Promise.all(relationSamples)));
      sourceBytesRead = readState.bytes;
      sourceFilesRead = readState.files;
    } catch (error) {
      if (error instanceof GitHubAppInstallationError)
        throw new AbortTaskRunError("github_source_spot_check_failed");
      if (error instanceof AbortTaskRunError) throw error;
      throw new AbortTaskRunError("github_source_spot_check_failed");
    } finally {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
    }

    const redactedCount = references.filter((row) => row.redacted).length;
    return {
      analysisRun: {
        id: persistedRun.id,
        workspaceId: persistedRun.workspace_id,
        repositoryId: persistedRun.repository_id,
        productId: persistedRun.product_id,
        commitSha: persistedRun.commit_sha,
        status: persistedRun.status,
        coverageState: persistedRun.coverage_state,
        filesDiscovered: persistedRun.files_discovered,
        filesAnalyzed: persistedRun.files_analyzed,
        filesSkipped: persistedRun.files_skipped,
        parseFailures: persistedRun.parse_failures,
        bytesAnalyzed: persistedRun.bytes_analyzed,
        analyzerVersion: persistedRun.analyzer_version,
        languageProfile: persistedRun.language_profile,
        analysisProfile: persistedRun.analysis_profile,
      },
      persistedCounts: {
        entities: entities.length,
        externalReferences: references.length,
        relations: relations.length,
        skippedFiles: skips.length,
        referenceTypes: referenceCounts,
        relationTypes: relationCounts,
        entityTypes: histogram(entities, "entity_type"),
        referenceIdentityMismatches: 0,
        relationEndpointIntegrity,
        matchesCompletionCounters: {
          packageFacts: referenceCounts.package === 26,
          importFacts: referenceCounts.import === 122,
          externalReferences: references.length === 334,
          relations: relations.length === 1430,
          skippedFiles: skips.length === persistedRun.files_skipped,
          parsedFiles: analyzedSourceFiles === persistedRun.files_analyzed,
        },
      },
      skipReasonBreakdown,
      partialCoverage: {
        primaryCause: partialAssessment.partialPrimary,
        reasons: partialAssessment.causes,
        supportedSourceFilesAnalyzed: analyzedSourceFiles,
        supportedSourceFilesDirectlySkipped: directlySkippedSourceFiles,
        supportedSourceFilesSkippedByBounds: supportedSourceSkippedByBounds,
        supportedSourceFilesSkippedForOtherReasons:
          directlySkippedSourceFiles - supportedSourceSkippedByBounds,
        supportedSourceCandidatesIdentified: knownSourceCandidates,
        identifiedSourceCoveragePercent: supportedSourceCoveragePercent,
        generatedDirectorySkipMarkers: directorySkipCount,
        generatedDirectoryContentsCounted: false,
        parseFailureCount: persistedRun.parse_failures,
        absenceCanBeClaimed: false,
        semantics: "EVIDENCE_PRESENT for found facts; UNKNOWN_INCOMPLETE for uncovered areas",
      },
      spotChecks,
      spotCheckSummary: {
        referenceSamples: spotChecks.filter((item) => item.kind === "reference").length,
        referenceSamplesMatched: spotChecks.filter(
          (item) => item.kind === "reference" && item.sourceMatch === true,
        ).length,
        relationSamples: spotChecks.filter((item) => item.kind === "relation").length,
        relationEndpointsPersisted: spotChecks.filter(
          (item) => item.kind === "relation" && item.endpointsPersisted === true,
        ).length,
        relationSamplesWithSourceMatches: spotChecks.filter(
          (item) =>
            item.kind === "relation" &&
            Array.isArray(item.endpointSourceMatches) &&
            item.endpointSourceMatches.every((matched) => matched === true),
        ).length,
        sourceFilesRead,
        sourceBytesRead,
        temporaryCleanup: "completed",
      },
      privacy: {
        credentialLikePersistedValues: credentialLikeCount,
        invalidRedactedRows: invalidRedactions,
        redactedReferenceCount: redactedCount,
        sourceContentColumnsPresent: false,
        jwtPersisted: false,
        installationTokenPersisted: false,
        privateKeyPersisted: false,
      },
      sideEffects: {
        customerImpact: false,
        productionExposure: false,
        preflight: false,
        notification: false,
        remediation: false,
        autoPr: false,
        billing: false,
      },
    };
  },
});
