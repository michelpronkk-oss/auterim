import { schemaTask, AbortTaskRunError } from "@trigger.dev/sdk";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import {
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
  relationEvidenceMatchesSource,
  type PersistedReadbackRun,
} from "@/lib/code-intelligence/readback";
import {
  CODE_INTELLIGENCE_PROFILE,
  CODE_INTELLIGENCE_VERSION,
  CODE_SCAN_LIMITS,
  isExactCommitSha,
} from "@/lib/code-intelligence/analyzer";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  GitHubAppInstallationError,
  GitHubAppRepositoryProvider,
} from "@/lib/preflight/github-provider";
import type { RepositoryTarget } from "@/lib/preflight/preflight";

const MAX_ROWS = 50_001;
const PAGE_SIZE = 1_000;
const MAX_SOURCE_FILES = 20;
const MAX_SOURCE_BYTES = 2_000_000;
const stableCompare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

const schema = z.object({ analysisRunId: z.string().uuid() }).strict();

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
  structural_fingerprint: string;
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
  structural_fingerprint: string;
};
type RelationRow = {
  id: string;
  analysis_run_id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: string;
  confidence_class: string;
  evidence_path: string | null;
  evidence_start_line: number | null;
  evidence_end_line: number | null;
  extractor_type: string | null;
  structural_fingerprint: string;
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
        stableCompare(
          `${left.path}\0${left.start_line}\0${left.normalized_value}\0${left.extractor_type}`,
          `${right.path}\0${right.start_line}\0${right.normalized_value}\0${right.extractor_type}`,
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

async function readRelationSourceMatch(
  root: string,
  relation: RelationRow,
  from: EntityRow | undefined,
  to: EntityRow | undefined,
  entities: EntityRow[],
  references: ExternalRow[],
  analysisRunId: string,
  cache: Map<string, string | null>,
  readState: { files: number; bytes: number },
) {
  if (
    !from ||
    !to ||
    !relation.evidence_path ||
    !relation.evidence_start_line ||
    !relation.evidence_end_line ||
    !relation.extractor_type ||
    !isSafeReadbackPath(relation.evidence_path)
  )
    return false;
  const sourcePath = relation.evidence_path;
  let source = cache.get(sourcePath);
  if (source === undefined) {
    if (readState.files >= MAX_SOURCE_FILES) return false;
    const rootReal = await realpath(root);
    const absolute = path.resolve(rootReal, ...sourcePath.split("/"));
    if (!absolute.startsWith(`${rootReal}${path.sep}`)) return false;
    const info = await lstat(absolute).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) return false;
    const resolved = await realpath(absolute).catch(() => null);
    if (!resolved || !resolved.startsWith(`${rootReal}${path.sep}`)) return false;
    const maxBytes = sourcePath === "package.json" ? 5_000_000 : CODE_SCAN_LIMITS.maxFileBytes;
    if (info.size > maxBytes || readState.bytes + info.size > MAX_SOURCE_BYTES) return false;
    const content = await readFile(absolute);
    readState.files += 1;
    readState.bytes += content.byteLength;
    source = content.toString("utf8").includes("\uFFFD") ? null : content.toString("utf8");
    cache.set(sourcePath, source);
  }
  if (!source) return false;
  const matchingExternalReference = references.some(
    (reference) =>
      reference.analysis_run_id === analysisRunId &&
      reference.entity_id === to.id &&
      reference.path === sourcePath &&
      reference.start_line === relation.evidence_start_line &&
      reference.end_line === relation.evidence_end_line &&
      reference.extractor_type === relation.extractor_type &&
      !reference.redacted &&
      safeSourceSpanMatch(
        reference.reference_type,
        reference.normalized_value,
        reference.path,
        source!,
        reference.start_line,
        reference.end_line,
      ),
  );
  return relationEvidenceMatchesSource({
    relationType: relation.relation_type,
    path: sourcePath,
    startLine: relation.evidence_start_line,
    endLine: relation.evidence_end_line,
    extractorType: relation.extractor_type,
    from,
    to,
    matchingTargetDeclarations: entities.filter(
      (entity) =>
        entity.path === to.path &&
        entity.entity_type === to.entity_type &&
        entity.name === to.name &&
        ["function", "method", "class"].includes(entity.entity_type),
    ).length,
    source,
    matchingExternalReference,
  });
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
        "id,workspace_id,product_id,repository_id,commit_sha,status,coverage_state,files_discovered,files_analyzed,files_skipped,parse_failures,bytes_analyzed,supported_files_discovered,supported_files_analyzed,supported_files_skipped_by_bound,unsupported_language_files,coverage_reason_counts,persisted_entity_count,persisted_relation_count,persisted_reference_count,persisted_skip_count,analyzer_version,language_profile,analysis_profile",
      )
      .eq("id", analysisRunId)
      .maybeSingle();
    if (runError || !run) throw new AbortTaskRunError("analysis_run_read_failed");
    const persistedRun = run as PersistedReadbackRun;
    if (
      !/^[0-9a-f-]{36}$/.test(persistedRun.id) ||
      persistedRun.workspace_id !== CODE_ANALYSIS_READBACK_WORKSPACE ||
      (persistedRun.product_id !== null &&
        persistedRun.product_id !== CODE_ANALYSIS_READBACK_PRODUCT) ||
      persistedRun.repository_id !== CODE_ANALYSIS_READBACK_REPOSITORY ||
      !isExactCommitSha(persistedRun.commit_sha) ||
      persistedRun.status !== "completed" ||
      persistedRun.analyzer_version !== CODE_INTELLIGENCE_VERSION ||
      persistedRun.language_profile !== CODE_INTELLIGENCE_PROFILE ||
      persistedRun.analysis_profile !== CODE_INTELLIGENCE_PROFILE
    )
      throw new AbortTaskRunError("analysis_identity_mismatch");

    const [entities, references, relations, skips] = await Promise.all([
      readBoundedRows<EntityRow>((from, to) =>
        supabase
          .from("code_entities")
          .select(
            "id,analysis_run_id,workspace_id,repository_id,commit_sha,entity_type,name,language,path,start_line,end_line,confidence_class,extractor_type,structural_fingerprint",
          )
          .eq("analysis_run_id", analysisRunId)
          .order("id")
          .range(from, to),
      ),
      readBoundedRows<ExternalRow>((from, to) =>
        supabase
          .from("code_external_references")
          .select(
            "id,analysis_run_id,entity_id,workspace_id,repository_id,commit_sha,reference_type,normalized_value,value_fingerprint,path,start_line,end_line,confidence_class,redacted,extractor_type,structural_fingerprint",
          )
          .eq("analysis_run_id", analysisRunId)
          .order("id")
          .range(from, to),
      ),
      readBoundedRows<RelationRow>((from, to) =>
        supabase
          .from("code_relations")
          .select(
            "id,analysis_run_id,from_entity_id,to_entity_id,relation_type,confidence_class,evidence_path,evidence_start_line,evidence_end_line,extractor_type,structural_fingerprint",
          )
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
    if (
      relations.some(
        (row) =>
          !row.evidence_path ||
          !row.evidence_start_line ||
          !row.evidence_end_line ||
          !row.extractor_type ||
          !isSafeReadbackPath(row.evidence_path),
      )
    )
      throw new AbortTaskRunError("relation_provenance_integrity_failed");
    const identityMismatches =
      entities.filter(
        (row) =>
          row.analysis_run_id !== analysisRunId ||
          row.workspace_id !== CODE_ANALYSIS_READBACK_WORKSPACE ||
          row.repository_id !== CODE_ANALYSIS_READBACK_REPOSITORY ||
          row.commit_sha !== persistedRun.commit_sha,
      ).length +
      (new Set(entities.map((row) => row.structural_fingerprint)).size !== entities.length
        ? 1
        : 0) +
      references.filter(
        (row) =>
          row.analysis_run_id !== analysisRunId ||
          !entityById.has(row.entity_id) ||
          row.workspace_id !== CODE_ANALYSIS_READBACK_WORKSPACE ||
          row.repository_id !== CODE_ANALYSIS_READBACK_REPOSITORY ||
          row.commit_sha !== persistedRun.commit_sha,
      ).length +
      (new Set(references.map((row) => row.structural_fingerprint)).size !== references.length
        ? 1
        : 0) +
      relations.filter((row) => row.analysis_run_id !== analysisRunId).length +
      (new Set(relations.map((row) => row.structural_fingerprint)).size !== relations.length
        ? 1
        : 0);
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
      stableCompare(
        `${left.reason}\0${left.classification}`,
        `${right.reason}\0${right.classification}`,
      ),
    );
    const partialAssessment = assessPartialCauses(
      skips.map((row) => ({ reason: row.skip_reason, path: row.path })),
    );

    const analyzedSourceFiles = persistedRun.supported_files_analyzed;
    const knownSourceCandidates = persistedRun.supported_files_discovered;
    const directlySkippedSourceFiles = persistedRun.supported_files_skipped_by_bound;
    const supportedSourceSkippedByBounds = persistedRun.supported_files_skipped_by_bound;
    const directorySkipCount = skips.filter((row) =>
      row.skip_reason.startsWith("generated_directory:"),
    ).length;
    const supportedSourceCoveragePercent = knownSourceCandidates
      ? Math.round((analyzedSourceFiles / knownSourceCandidates) * 10_000) / 100
      : null;
    const persistedCountMatches =
      entities.length === persistedRun.persisted_entity_count &&
      relations.length === persistedRun.persisted_relation_count &&
      references.length === persistedRun.persisted_reference_count &&
      skips.length === persistedRun.persisted_skip_count;
    if (!persistedCountMatches) throw new AbortTaskRunError("persisted_fact_count_mismatch");

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
      commitSha: persistedRun.commit_sha,
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
    const exactCommit = await provider.verifyExactCommit(target, persistedRun.commit_sha);
    if (!exactCommit.exactShaMatch) throw new AbortTaskRunError("github_exact_commit_unavailable");

    let temporaryRoot: string | null = null;
    const spotChecks: Array<Record<string, unknown>> = [];
    let sourceBytesRead = 0;
    let sourceFilesRead = 0;
    try {
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "auterim-m1576-readback-"));
      await provider.materializeRepository(target, persistedRun.commit_sha, temporaryRoot);
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
          commitSha: persistedRun.commit_sha,
          sourceMatch,
        });
      }
      const relationSamples = RELATION_TYPES.flatMap((type) =>
        relations
          .filter((row) => row.relation_type === type)
          .sort((left, right) =>
            stableCompare(
              `${left.evidence_path ?? ""}\0${left.evidence_start_line ?? 0}\0${left.structural_fingerprint}`,
              `${right.evidence_path ?? ""}\0${right.evidence_start_line ?? 0}\0${right.structural_fingerprint}`,
            ),
          )
          .slice(0, 1),
      ).map(async (row) => {
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
          commitSha: persistedRun.commit_sha,
          endpointsPersisted: Boolean(
            from &&
            to &&
            from.analysis_run_id === analysisRunId &&
            to.analysis_run_id === analysisRunId,
          ),
          evidencePath: row.evidence_path,
          evidenceStartLine: row.evidence_start_line,
          evidenceEndLine: row.evidence_end_line,
          extractorType: row.extractor_type,
          sourceMatch: await readRelationSourceMatch(
            temporaryRoot!,
            row,
            from,
            to,
            entities,
            references,
            analysisRunId,
            cache,
            readState,
          ),
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
        supportedFilesDiscovered: persistedRun.supported_files_discovered,
        supportedFilesAnalyzed: persistedRun.supported_files_analyzed,
        supportedFilesSkippedByBound: persistedRun.supported_files_skipped_by_bound,
        unsupportedLanguageFiles: persistedRun.unsupported_language_files,
        coverageReasonCounts: persistedRun.coverage_reason_counts,
        persistedFactCounts: {
          entities: persistedRun.persisted_entity_count,
          relations: persistedRun.persisted_relation_count,
          references: persistedRun.persisted_reference_count,
          skips: persistedRun.persisted_skip_count,
        },
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
          entities: entities.length === persistedRun.persisted_entity_count,
          externalReferences: references.length === persistedRun.persisted_reference_count,
          relations: relations.length === persistedRun.persisted_relation_count,
          skippedFiles: skips.length === persistedRun.persisted_skip_count,
          supportedFiles: analyzedSourceFiles === persistedRun.supported_files_analyzed,
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
          (item) => item.kind === "relation" && item.sourceMatch === true,
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
