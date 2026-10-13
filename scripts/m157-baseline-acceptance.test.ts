import { it } from "vitest";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { executeBaselinePreflight } from "@/lib/preflight/baseline-executor";

const TARGET = Object.freeze({
  workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
  productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
  repositoryOwner: "michelpronkk-oss",
  repositoryName: "auterim",
});

function assertProductionAuterimTarget() {
  if (process.env.AUTERIM_M157_BASELINE_ACCEPTANCE !== "1")
    throw new Error("m157_acceptance_runner_not_explicitly_enabled");
  if (process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1")
    throw new Error("m157_acceptance_runner_rejects_local_integration_mode");
  let ref = "";
  try {
    ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname.split(".")[0] ?? "";
  } catch {
    throw new Error("m157_acceptance_runner_supabase_target_unavailable");
  }
  if (ref !== "lnljaacbptrubppoypaz")
    throw new Error("m157_acceptance_runner_wrong_supabase_project");
}

it("runs only the fixed M15.7 Test baseline acceptance target", async () => {
  assertProductionAuterimTarget();
  const service = createSupabaseServerClient();
  const { data: workspace, error: workspaceError } = await service
    .from("workspaces")
    .select("name")
    .eq("id", TARGET.workspaceId)
    .maybeSingle();
  if (workspaceError || workspace?.name !== "Test")
    throw new Error("m157_acceptance_runner_workspace_identity_mismatch");
  const { data: owners, error: ownersError } = await service
    .from("workspace_members")
    .select("user_id,role")
    .eq("workspace_id", TARGET.workspaceId)
    .in("role", ["owner", "admin"])
    .order("role", { ascending: false })
    .order("user_id", { ascending: true })
    .limit(1);
  if (ownersError || !Array.isArray(owners) || owners.length !== 1)
    throw new Error("m157_acceptance_runner_owner_check_failed");
  const actorUserId = owners[0]?.user_id;
  if (typeof actorUserId !== "string" || !["owner", "admin"].includes(owners[0]?.role)) {
    throw new Error("m157_acceptance_runner_owner_check_failed");
  }

  const { data: mappings, error: mappingError } = await service
    .from("workspace_product_repositories")
    .select("repository_id")
    .eq("workspace_id", TARGET.workspaceId)
    .eq("protected_product_id", TARGET.productId)
    .eq("status", "active")
    .limit(2);
  if (mappingError || !Array.isArray(mappings) || mappings.length !== 1)
    throw new Error("m157_acceptance_runner_product_mapping_check_failed");
  const repositoryId = mappings[0]?.repository_id;
  if (typeof repositoryId !== "string")
    throw new Error("m157_acceptance_runner_product_mapping_check_failed");

  const { data: repository, error: repositoryError } = await service
    .from("repositories")
    .select("id,owner,name")
    .eq("id", repositoryId)
    .eq("workspace_id", TARGET.workspaceId)
    .maybeSingle();
  if (
    repositoryError ||
    !repository ||
    repository.id !== repositoryId ||
    repository.owner?.toLowerCase() !== TARGET.repositoryOwner ||
    repository.name?.toLowerCase() !== TARGET.repositoryName
  ) {
    throw new Error("m157_acceptance_runner_repository_identity_mismatch");
  }

  const result = await executeBaselinePreflight({
    service,
    actorUserId,
    workspaceId: TARGET.workspaceId,
    productId: TARGET.productId,
    repositoryId,
  });
  if (
    result.mode !== "baseline" ||
    result.verificationState !== "verified" ||
    result.repository !== "michelpronkk-oss/auterim"
  ) {
    throw new Error("m157_acceptance_runner_result_invariant_failed");
  }
  console.log(
    `[M15.7 baseline acceptance] ${JSON.stringify({
      workspace: "Test",
      productId: TARGET.productId,
      repository: result.repository,
      preflightRunId: result.preflightRunId,
      baselineEvidenceId: result.evidenceId,
      verifiedCommitSha: result.verifiedCommitSha,
      verificationState: result.verificationState,
      replayed: result.replayed,
    })}`,
  );
});
