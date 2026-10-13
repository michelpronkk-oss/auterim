import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnvironment } from "@/lib/env/schema";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";

const PREFLIGHT_BASELINE_VERSION = "baseline-v1";

export type BaselinePreflightResult = {
  preflightRunId: string;
  mode: "baseline";
  evidenceId: string;
  repositoryId: string;
  repository: string;
  verifiedCommitSha: string;
  verificationState: "verified";
  observedAt: string;
  replayed: boolean;
};

export type BaselineRepositoryProvider = {
  getHead(target: {
    id: string;
    workspaceId: string;
    owner: string;
    name: string;
    defaultBranch: string;
    externalId: number;
    installationId: number;
  }): Promise<string>;
};

export class BaselinePreflightError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "forbidden"
      | "baseline_preflight_ineligible"
      | "repository_unavailable"
      | "workspace_access_unavailable"
      | "repository_verification_unavailable"
      | "baseline_preflight_persist_failed",
  ) {
    super(code);
    this.name = "BaselinePreflightError";
  }
}

/**
 * Shared server-only baseline domain operation. It independently rechecks the
 * workspace role and protected Product/repository relationship, resolves HEAD
 * through the authorized GitHub App installation, and persists only through
 * the canonical idempotent RPC. Callers must never provide a commit SHA.
 */
export async function executeBaselinePreflight(input: {
  service: SupabaseClient;
  actorUserId: string;
  workspaceId: string;
  productId: string;
  repositoryId: string;
  repositoryProvider?: BaselineRepositoryProvider;
}): Promise<BaselinePreflightResult> {
  const { service, actorUserId, workspaceId, productId, repositoryId } = input;
  const { data: membership, error: membershipError } = await service
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", actorUserId)
    .maybeSingle();
  if (membershipError) throw new BaselinePreflightError("workspace_access_unavailable");
  if (!membership || !["owner", "admin"].includes(membership.role))
    throw new BaselinePreflightError("forbidden");

  const [
    { data: product, error: productError },
    { data: repository, error: repositoryError },
    { data: mapping, error: mappingError },
  ] = await Promise.all([
    service
      .from("workspace_products")
      .select("id,status")
      .eq("id", productId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    service
      .from("repositories")
      .select(
        "id,workspace_id,connection_id,external_id,owner,name,default_branch,status,selected_for_protection",
      )
      .eq("id", repositoryId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    service
      .from("workspace_product_repositories")
      .select("repository_id")
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId)
      .eq("repository_id", repositoryId)
      .eq("status", "active")
      .maybeSingle(),
  ]);
  if (productError || repositoryError || mappingError)
    throw new BaselinePreflightError("repository_verification_unavailable");
  if (!product || !repository) throw new BaselinePreflightError("not_found");
  if (
    product.status !== "protected" ||
    !mapping ||
    repository.workspace_id !== workspaceId ||
    repository.status !== "available" ||
    repository.selected_for_protection !== true
  ) {
    throw new BaselinePreflightError("baseline_preflight_ineligible");
  }

  const { data: connection, error: connectionError } = await service
    .from("repository_connections")
    .select("installation_id,status")
    .eq("id", repository.connection_id)
    .eq("workspace_id", workspaceId)
    .eq("status", "connected")
    .maybeSingle();
  if (connectionError) throw new BaselinePreflightError("repository_verification_unavailable");
  if (!connection || !Number.isSafeInteger(Number(connection.installation_id)))
    throw new BaselinePreflightError("repository_unavailable");

  try {
    const provider =
      input.repositoryProvider ??
      (() => {
        const environment = getEnvironment();
        return new GitHubAppRepositoryProvider({
          appId: environment.GITHUB_APP_ID,
          privateKey: environment.GITHUB_APP_PRIVATE_KEY,
        });
      })();
    const target = {
      id: repository.id,
      workspaceId,
      owner: repository.owner,
      name: repository.name,
      defaultBranch: repository.default_branch,
      externalId: Number(repository.external_id),
      installationId: Number(connection.installation_id),
    };
    if (
      !Number.isSafeInteger(target.externalId) ||
      target.externalId <= 0 ||
      !target.owner ||
      !target.name ||
      !target.defaultBranch
    ) {
      throw new Error("repository_identity_invalid");
    }
    const commitSha = await provider.getHead(target);
    if (!/^[a-f0-9]{40,64}$/.test(commitSha)) throw new Error("repository_head_invalid");
    const repositorySetFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          mode: "baseline",
          productId,
          repositoryId: repository.id,
          externalRepositoryId: target.externalId,
          owner: repository.owner.toLowerCase(),
          name: repository.name.toLowerCase(),
          defaultBranch: repository.default_branch,
          commitSha,
        }),
      )
      .digest("hex");
    const { data, error } = await service.rpc("persist_baseline_preflight", {
      p_actor_id: actorUserId,
      p_workspace_id: workspaceId,
      p_product_id: productId,
      p_repository_id: repository.id,
      p_external_repository_id: target.externalId,
      p_repository_owner: repository.owner,
      p_repository_name: repository.name,
      p_default_branch: repository.default_branch,
      p_commit_sha: commitSha,
      p_repository_set_fingerprint: repositorySetFingerprint,
      p_preflight_version: PREFLIGHT_BASELINE_VERSION,
    });
    if (error?.message?.startsWith("forbidden")) throw new BaselinePreflightError("forbidden");
    if (error?.message?.startsWith("baseline_preflight_ineligible"))
      throw new BaselinePreflightError("baseline_preflight_ineligible");
    if (error || !Array.isArray(data) || !data[0])
      throw new BaselinePreflightError("baseline_preflight_persist_failed");
    const result = data[0] as {
      preflight_run_id: string;
      baseline_evidence_id: string;
      created: boolean;
      observed_at: string;
    };
    return {
      preflightRunId: result.preflight_run_id,
      mode: "baseline",
      evidenceId: result.baseline_evidence_id,
      repositoryId: repository.id,
      repository: `${repository.owner}/${repository.name}`,
      verifiedCommitSha: commitSha,
      verificationState: "verified",
      observedAt: result.observed_at,
      replayed: !result.created,
    };
  } catch (error) {
    if (error instanceof BaselinePreflightError) throw error;
    throw new BaselinePreflightError("repository_verification_unavailable");
  }
}
