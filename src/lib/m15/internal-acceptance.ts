import "server-only";
import { serverConnectors } from "@/lib/connectors/service";
import {
  BaselinePreflightError,
  executeBaselinePreflight,
  type BaselinePreflightResult,
} from "@/lib/preflight/baseline-executor";
import { runM157DeploymentAcceptance } from "@/lib/m15/deployment-acceptance";
import { M157_FIXED_TARGET as TARGET } from "../../../scripts/m157-deployment-acceptance.ts";

type QueryError = { message?: string } | null;
type RepositoryCandidate = {
  id: string;
  workspace_id: string;
  owner: string;
  name: string;
  status: string;
  selected_for_protection: boolean;
};

function requireRows<T>(data: T[] | null, error: QueryError, stage: string): T[] {
  if (error || data === null) throw new Error(`m157_acceptance_${stage}`);
  return data;
}

function requireCondition(condition: unknown, stage: string): asserts condition {
  if (!condition) throw new Error(`m157_acceptance_${stage}`);
}

function safeFailureCategory(error: unknown) {
  if (error instanceof Error && /^m157_acceptance_[a-z0-9_]+$/.test(error.message))
    return error.message.slice("m157_acceptance_".length);
  return "unknown_safe";
}

/**
 * Fixed-target internal acceptance orchestration. It resolves the sole
 * protected Auterim repository, runs the shared baseline domain operation,
 * and passes that exact persisted evidence into deployment acceptance.
 */
export async function runM157InternalAcceptance(actorUserId: string) {
  const service = serverConnectors();
  const repositoryResult = await service
    .from("repositories")
    .select("id,workspace_id,owner,name,status,selected_for_protection")
    .eq("workspace_id", TARGET.workspaceId)
    .eq("owner", TARGET.repositoryOwner)
    .eq("name", TARGET.repositoryName)
    .eq("status", "available")
    .eq("selected_for_protection", true)
    .limit(10);
  const candidates = requireRows<RepositoryCandidate>(
    repositoryResult.data,
    repositoryResult.error,
    "fixed_repository_lookup_unavailable",
  );
  requireCondition(candidates.length < 10, "fixed_repository_lookup_ambiguous");
  const protectedRepositories: RepositoryCandidate[] = [];
  for (const repository of candidates) {
    const mapping = await service
      .from("workspace_product_repositories")
      .select("repository_id")
      .eq("workspace_id", TARGET.workspaceId)
      .eq("protected_product_id", TARGET.productId)
      .eq("repository_id", repository.id)
      .eq("status", "active")
      .maybeSingle();
    if (mapping.error) throw new Error("m157_acceptance_fixed_repository_mapping_unavailable");
    if (mapping.data) protectedRepositories.push(repository);
  }
  requireCondition(protectedRepositories.length === 1, "fixed_repository_not_unique");
  const repository = protectedRepositories[0]!;

  let baseline: BaselinePreflightResult;
  try {
    baseline = await executeBaselinePreflight({
      service,
      actorUserId,
      workspaceId: TARGET.workspaceId,
      productId: TARGET.productId,
      repositoryId: repository.id,
    });
  } catch (error) {
    if (error instanceof BaselinePreflightError) {
      throw new Error(`m157_acceptance_baseline_${error.code}`);
    }
    if (error instanceof Error && error.message.startsWith("m157_acceptance_")) throw error;
    throw new Error(`m157_acceptance_baseline_${safeFailureCategory(error)}`);
  }
  requireCondition(
    baseline.mode === "baseline" &&
      baseline.verificationState === "verified" &&
      baseline.repositoryId === repository.id &&
      baseline.repository === `${TARGET.repositoryOwner}/${TARGET.repositoryName}`,
    "fresh_baseline_result_invalid",
  );
  return runM157DeploymentAcceptance({ freshBaseline: baseline });
}
