import { schemaTask } from "@trigger.dev/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment } from "@/lib/env/schema";
import {
  GitHubAppInstallationError,
  GitHubAppRepositoryProvider,
} from "@/lib/preflight/github-provider";
import type { RepositoryTarget } from "@/lib/preflight/preflight";

const schema = z.object({}).strict();

// This bounded Production probe is pinned to the approved Test workspace mapping.
// It cannot be redirected to another tenant or repository.
const TARGET = {
  workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
  productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
  repositoryId: "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4",
} as const;

function failed(stage: string, category: string, upstreamStatus?: number) {
  return {
    ok: false as const,
    stage,
    category,
    ...(upstreamStatus ? { upstreamStatus } : {}),
  };
}

/** Internal, bounded auth/materialization probe for the canonical protected repository only. */
export const m1576GitHubRepositoryAccessProbe = schemaTask({
  id: "m1576-github-repository-access-probe",
  schema,
  retry: { maxAttempts: 1 },
  maxDuration: 180,
  concurrency: { total: 1 },
  run: async () => {
    const supabase = createSupabaseServerClient();
    const { data: mapping, error: mappingError } = await supabase
      .from("workspace_product_repositories")
      .select("workspace_id,protected_product_id,repository_id,status")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("repository_id", TARGET.repositoryId)
      .eq("status", "active")
      .maybeSingle();
    if (mappingError || !mapping)
      return failed("canonical_mapping", "repository_mapping_unavailable");

    const { data: product, error: productError } = await supabase
      .from("workspace_products")
      .select("id,workspace_id,status")
      .eq("id", TARGET.productId)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("status", "protected")
      .maybeSingle();
    if (productError || !product)
      return failed("canonical_mapping", "protected_product_unavailable");

    const { data: repository, error: repositoryError } = await supabase
      .from("repositories")
      .select("id,workspace_id,connection_id,external_id,owner,name,default_branch,status")
      .eq("id", TARGET.repositoryId)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("status", "available")
      .maybeSingle();
    if (repositoryError || !repository)
      return failed("canonical_mapping", "repository_unavailable");
    if (`${repository.owner}/${repository.name}`.toLowerCase() !== "michelpronkk-oss/auterim")
      return failed("canonical_mapping", "repository_identity_mismatch");

    const { data: connection, error: connectionError } = await supabase
      .from("repository_connections")
      .select("id,workspace_id,installation_id,status,provider")
      .eq("id", repository.connection_id)
      .eq("workspace_id", TARGET.workspaceId)
      .eq("provider", "github")
      .eq("status", "connected")
      .maybeSingle();
    if (connectionError || !connection)
      return failed("canonical_mapping", "github_connection_unavailable");

    const externalId = Number(repository.external_id);
    const installationId = Number(connection.installation_id);
    if (
      !Number.isSafeInteger(externalId) ||
      externalId <= 0 ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0
    )
      return failed("canonical_mapping", "repository_identity_invalid");

    let environment: ReturnType<typeof getEnvironment>;
    try {
      environment = getEnvironment();
    } catch {
      return failed("github_provider_setup", "environment_invalid");
    }
    if (!environment.GITHUB_APP_ID || !environment.GITHUB_APP_PRIVATE_KEY)
      return failed("github_provider_setup", "github_config_unavailable");
    const configuredCommitSha = environment.AUTERIM_M1576_GITHUB_PROBE_COMMIT_SHA;
    if (!configuredCommitSha) return failed("exact_commit", "approved_commit_not_configured");
    const expectedCommitSha = configuredCommitSha.toLowerCase();

    const target: RepositoryTarget = {
      id: repository.id,
      workspaceId: repository.workspace_id,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.default_branch,
      externalId,
      installationId,
      commitSha: "",
    };

    let provider: GitHubAppRepositoryProvider;
    try {
      provider = new GitHubAppRepositoryProvider({
        appId: environment.GITHUB_APP_ID,
        privateKey: environment.GITHUB_APP_PRIVATE_KEY,
      });
    } catch {
      return failed("github_provider_setup", "github_config_unavailable");
    }

    let temporaryRoot: string | null = null;
    let primaryFailure: ReturnType<typeof failed> | null = null;
    let completed: {
      commitSha: string;
      appIdentityMatches: boolean;
      installationValid: boolean;
      repositoryAuthorized: boolean;
      exactCommitMatch: boolean;
      archiveFileCount: number;
      archiveMaterializedBytes: number;
      archiveCompressedBytes: number;
      archiveExpandedBytes: number;
    } | null = null;
    try {
      const app = await provider.verifyAppIdentity();
      if (!app.matchesConfiguredAppId) {
        primaryFailure = failed("app_identity", "app_identity_mismatch");
      } else {
        const installation = await provider.verifyInstallation(installationId);
        const readOnly =
          installation.id === installationId &&
          installation.accountLogin.toLowerCase() === "michelpronkk-oss" &&
          installation.repositorySelection === "selected" &&
          installation.permissions.contents === "read" &&
          installation.permissions.metadata === "read" &&
          Object.values(installation.permissions).every((permission) => permission === "read");
        if (!readOnly) {
          primaryFailure = failed("installation", "installation_permissions_unexpected");
        } else {
          const repositoryAccess = await provider.verifyRepositoryAccess(target);
          if (!repositoryAccess.matchesCanonicalRepository) {
            primaryFailure = failed("repository_access", "repository_identity_mismatch");
          } else {
            // Resolve the default branch to an immutable SHA and require it to
            // match the separately configured, non-secret approved merge SHA.
            const commitSha = await provider.resolveDefaultBranchCommit(target);
            if (commitSha.toLowerCase() !== expectedCommitSha.toLowerCase()) {
              primaryFailure = failed("exact_commit", "approved_commit_not_current_head");
            } else {
              const commit = await provider.verifyExactCommit(target, expectedCommitSha);
              if (!commit.exactShaMatch) {
                primaryFailure = failed("exact_commit", "commit_unavailable");
              } else {
                temporaryRoot = await mkdtemp(
                  path.join(os.tmpdir(), "auterim-m1576-github-probe-"),
                );
                const archive = await provider.materializeRepository(
                  target,
                  expectedCommitSha,
                  temporaryRoot,
                );
                completed = {
                  commitSha: expectedCommitSha,
                  appIdentityMatches: true,
                  installationValid: true,
                  repositoryAuthorized: true,
                  exactCommitMatch: true,
                  archiveFileCount: archive.files,
                  archiveMaterializedBytes: archive.bytes,
                  archiveCompressedBytes: archive.compressedBytes,
                  archiveExpandedBytes: archive.expandedBytes,
                };
              }
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof GitHubAppInstallationError) {
        primaryFailure = failed(error.stage, error.category, error.upstreamStatus);
      } else {
        primaryFailure = failed("probe", "probe_failed");
      }
    }

    let cleanupFailed = false;
    if (temporaryRoot) {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch {
        cleanupFailed = true;
      }
    }
    if (primaryFailure) return { ...primaryFailure, cleanupFailed };
    if (cleanupFailed) return failed("cleanup", "temporary_cleanup_failed");
    return { ok: true as const, ...completed!, cleanupFailed: false as const };
  },
});
