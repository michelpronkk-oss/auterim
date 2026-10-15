import { schemaTask, AbortTaskRunError, logger, tasks } from "@trigger.dev/sdk";
import { mkdtemp, opendir, readFile, rm, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  analyzeCodeSnapshot,
  CODE_SCAN_LIMITS,
  isExactCommitSha,
  type SnapshotFile,
} from "@/lib/code-intelligence/analyzer";
import {
  failCodeAnalysisRun,
  persistCodeAnalysis,
  claimCodeAnalysisRun,
} from "@/lib/code-intelligence/service";
import { executeCodeAnalysisStages } from "@/lib/code-intelligence/failures";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment } from "@/lib/env/schema";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import type { RepositoryTarget } from "@/lib/preflight/preflight";
import type { buildProviderImpactGraphTask } from "@/trigger/build-provider-impact-graph";

const schema = z.object({
  workspaceId: z.string().uuid(),
  productId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
  routeIntentId: z.string().uuid().optional(),
});

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".mp3",
  ".svgz",
  ".wasm",
  ".map",
]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts"]);
const SPECIAL_FILES = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "vendor",
]);

const stableCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export async function collectSnapshotFiles(root: string): Promise<SnapshotFile[]> {
  const results: SnapshotFile[] = [];
  const maxEntries = 5_000;
  let visitedEntries = 0;
  let bytesCollected = 0;
  let truncated = false;
  const visit = async (directory: string, depth = 0) => {
    if (depth > 128) {
      results.push({
        path: path.relative(root, directory).replaceAll("\\", "/"),
        text: "",
        size: 0,
        directorySkipReason: "traversal_depth_limit",
      });
      return;
    }
    const handle = await opendir(directory);
    const entries: Dirent[] = [];
    let overflow = false;
    const remainingEntries = maxEntries - visitedEntries;
    try {
      for await (const entry of handle) {
        if (entries.length >= remainingEntries) {
          overflow = true;
          break;
        }
        entries.push(entry);
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (overflow) {
      truncated = true;
      results.push({
        path: path.relative(root, directory).replaceAll("\\", "/") || "[repository]",
        text: "",
        size: 0,
        directorySkipReason: "traversal_entry_limit",
      });
      return;
    }
    entries.sort((a, b) => stableCompare(a.name, b.name));
    visitedEntries += entries.length;
    for (const entry of entries) {
      if (truncated) return;
      const absolute = path.resolve(directory, entry.name);
      if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) {
          results.push({
            path: path.relative(root, absolute).replaceAll("\\", "/"),
            text: "",
            size: 0,
            directorySkipReason: `generated_directory:${entry.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
          });
          continue;
        }
        await visit(absolute, depth + 1);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const relative = path.relative(root, absolute).replaceAll("\\", "/");
        results.push({
          path: relative,
          text: "",
          size: 0,
          skipReason: "symlink_excluded",
        });
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      const basename = entry.name.toLowerCase();
      const extension = path.extname(entry.name).toLowerCase();
      const fileStat = await stat(absolute);
      const size = fileStat.size;
      const sensitiveFile = basename === ".env" || basename.startsWith(".env.");
      const binary = BINARY_EXTENSIONS.has(extension);
      const isSource = SOURCE_EXTENSIONS.has(extension);
      const isSpecial = SPECIAL_FILES.has(relative);
      if (sensitiveFile || binary || (!isSource && !isSpecial)) {
        results.push({ path: relative, text: "", size, binary });
        continue;
      }
      const max = isSpecial ? CODE_SCAN_LIMITS.maxManifestBytes : CODE_SCAN_LIMITS.maxFileBytes;
      if (size > max) {
        results.push({ path: relative, text: "", size });
        continue;
      }
      if (bytesCollected + size > CODE_SCAN_LIMITS.maxRepositoryBytes) {
        results.push({ path: relative, text: "", size, skipReason: "repository_byte_limit" });
        continue;
      }
      const bytes = await readFile(absolute);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        results.push({ path: relative, text: "", size, skipReason: "invalid_encoding" });
        bytesCollected += size;
        continue;
      }
      results.push({ path: relative, text, size });
      bytesCollected += size;
    }
  };
  await visit(root);
  if (truncated) results.push({ path: "[repository]", text: "", collectionTruncated: true });
  return results;
}

export const analyzeProtectedRepositoryCodeTask = schemaTask({
  id: "analyze-protected-repository-code",
  schema,
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 20_000,
    factor: 2,
    randomize: true,
  },
  maxDuration: 300,
  concurrency: { total: 2 },
  run: async (payload) => {
    if (!isExactCommitSha(payload.commitSha))
      throw new AbortTaskRunError("Exact commit SHA required");
    const supabase = createSupabaseServerClient();
    const { data: mapping, error: mappingError } = await supabase
      .from("workspace_product_repositories")
      .select("workspace_id,protected_product_id,repository_id,status")
      .eq("workspace_id", payload.workspaceId)
      .eq("protected_product_id", payload.productId)
      .eq("repository_id", payload.repositoryId)
      .eq("status", "active")
      .maybeSingle();
    if (mappingError || !mapping)
      throw new AbortTaskRunError("Protected repository mapping unavailable");

    const { data: product, error: productError } = await supabase
      .from("workspace_products")
      .select("id,workspace_id,status")
      .eq("id", payload.productId)
      .eq("workspace_id", payload.workspaceId)
      .eq("status", "protected")
      .maybeSingle();
    if (productError || !product) throw new AbortTaskRunError("Protected product unavailable");

    const { data: repository, error: repositoryError } = await supabase
      .from("repositories")
      .select("id,workspace_id,connection_id,external_id,owner,name,default_branch,status")
      .eq("id", payload.repositoryId)
      .eq("workspace_id", payload.workspaceId)
      .eq("status", "available")
      .maybeSingle();
    if (repositoryError || !repository) throw new AbortTaskRunError("Repository unavailable");

    const { data: connection, error: connectionError } = await supabase
      .from("repository_connections")
      .select("id,workspace_id,installation_id,status,provider")
      .eq("id", repository.connection_id)
      .eq("workspace_id", payload.workspaceId)
      .eq("provider", "github")
      .eq("status", "connected")
      .maybeSingle();
    if (connectionError || !connection)
      throw new AbortTaskRunError("GitHub connection unavailable");

    const target: RepositoryTarget = {
      id: repository.id,
      workspaceId: repository.workspace_id,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.default_branch,
      externalId: Number(repository.external_id),
      installationId: Number(connection.installation_id),
      commitSha: payload.commitSha,
    };
    const claim = await claimCodeAnalysisRun({
      workspaceId: payload.workspaceId,
      productId: payload.productId,
      repositoryId: payload.repositoryId,
      commitSha: payload.commitSha,
      routeIntentId: payload.routeIntentId,
    });
    const dispatchGraph = async () => {
      if (!payload.routeIntentId) return null;
      const graphRun = await tasks.trigger<typeof buildProviderImpactGraphTask>(
        "build-provider-impact-graph",
        {
          routeIntentId: payload.routeIntentId,
          analysisRunId: claim.analysisRunId,
          productId: payload.productId,
          repositoryId: payload.repositoryId,
        },
        { idempotencyKey: `m1577-graph:${payload.routeIntentId}:${claim.analysisRunId}:${payload.productId}:${payload.repositoryId}` },
      );
      return graphRun.id;
    };
    if (claim.status === "completed") {
      const graphRunId = await dispatchGraph();
      return { analysisRunId: claim.analysisRunId, status: "completed", replayed: true, graphRunId };
    }
    if (claim.status === "busy") throw new Error("code_analysis_claim_busy");
    if (claim.status !== "claimed" || !claim.claimToken)
      throw new AbortTaskRunError("Code analysis attempt unavailable");

    let temporaryRoot: string | null = null;
    let skippedArchiveLinks: string[] = [];
    let archiveLinkCount = 0;
    const outcome = await executeCodeAnalysisStages({
      validateEnvironment: () => getEnvironment(),
      setupProvider: (environment) =>
        new GitHubAppRepositoryProvider({
          appId: environment.GITHUB_APP_ID,
          privateKey: environment.GITHUB_APP_PRIVATE_KEY,
        }),
      materialize: async (provider) => {
        temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "auterim-code-intel-"));
        const archive = await provider.materializeRepository(
          target,
          payload.commitSha,
          temporaryRoot,
        );
        skippedArchiveLinks = archive.skippedLinkPaths;
        archiveLinkCount = archive.skippedLinks;
      },
      collectSnapshot: async () => {
        if (!temporaryRoot) throw new Error("code_analysis_snapshot_root_unavailable");
        const files = await collectSnapshotFiles(temporaryRoot);
        for (const linkPath of skippedArchiveLinks)
          files.push({ path: linkPath, text: "", size: 0, skipReason: "symlink_excluded" });
        if (archiveLinkCount > skippedArchiveLinks.length)
          files.push({
            path: "[archive-symlink-entries-truncated]",
            text: "",
            size: 0,
            skipReason: "symlink_excluded",
          });
        return files;
      },
      analysisWatchdogMs: 240_000,
      analyze: (files) => analyzeCodeSnapshot(files),
      persist: (result) =>
        persistCodeAnalysis({
          analysisRunId: claim.analysisRunId,
          workspaceId: payload.workspaceId,
          repositoryId: payload.repositoryId,
          commitSha: payload.commitSha,
          claimToken: claim.claimToken!,
          result,
        }),
      cleanup: async () => {
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      },
    });

    if (outcome.cleanupFailed) {
      logger.warn("Code analysis temporary cleanup failed", {
        analysisRunId: claim.analysisRunId,
        failureCategory: "cleanup_failed",
        primaryFailureStage: outcome.ok ? null : outcome.failure.stage,
      });
    }
    if (!outcome.ok) {
      try {
        await failCodeAnalysisRun({
          analysisRunId: claim.analysisRunId,
          claimToken: claim.claimToken,
          failureStage: outcome.failure.stage,
          failureCategory: outcome.failure.category,
          retryable: outcome.failure.retryable,
          cleanupFailureCategory: outcome.cleanupFailed ? "cleanup_failed" : undefined,
        });
      } catch {
        logger.error("Code analysis failure state could not be persisted", {
          analysisRunId: claim.analysisRunId,
          failureStage: outcome.failure.stage,
          failureCategory: "failure_state_persistence_failed",
        });
      }
      if (outcome.failure.retryable) throw new Error("code_analysis_retryable_failure");
      throw new AbortTaskRunError("Code analysis failed safely");
    }

    const result = outcome.analysis;
    const graphRunId = await dispatchGraph();
    return {
      analysisRunId: claim.analysisRunId,
      status: "completed",
      coverageState: result.coverageState,
      filesDiscovered: result.filesDiscovered,
      filesAnalyzed: result.filesAnalyzed,
      filesSkipped: result.filesSkipped,
      parseFailures: result.parseFailures,
      supportedFilesDiscovered: result.supportedFilesDiscovered,
      supportedFilesAnalyzed: result.supportedFilesAnalyzed,
      supportedFilesSkippedByBound: result.supportedFilesSkippedByBound,
      unsupportedLanguageFiles: result.unsupportedLanguageFiles,
      packageFacts: result.externalReferences.filter((item) => item.referenceType === "package")
        .length,
      importFacts: result.externalReferences.filter((item) => item.referenceType === "import")
        .length,
      externalReferences: result.externalReferences.length,
      relations: result.relations.length,
      graphRunId,
    };
  },
});
