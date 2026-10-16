import "server-only";
import { tasks } from "@trigger.dev/sdk";
import { resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import { runPreflight } from "@/lib/preflight/preflight-service";
import { getEnvironment } from "@/lib/env/schema";
import type { PreflightResult } from "@/lib/preflight/preflight";
import type { runPreflightTask } from "@/trigger/run-preflight";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type CanonicalFixPreflightResult = {
  status: "passed" | "failed" | "ineligible";
  preflightRunId: string | null;
  category: string | null;
};

function configuredProvider() {
  const environment = getEnvironment();
  return new GitHubAppRepositoryProvider({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
}

function exactPreflightResult(input: {
  outcome: Awaited<ReturnType<typeof runPreflight>>;
  repositoryId: string;
  baseSha: string;
}): CanonicalFixPreflightResult {
  if (input.outcome.status === "ineligible")
    return { status: "ineligible", preflightRunId: null, category: "preflight_ineligible" };
  const runId = input.outcome.runId;
  const result = input.outcome.result as PreflightResult | null;
  if (!runId || !result)
    return {
      status: "failed",
      preflightRunId: runId ?? null,
      category: "preflight_result_unavailable",
    };
  if (result.status !== "completed" || result.verifiedImpact !== "verified")
    return { status: "failed", preflightRunId: runId, category: "preflight_not_verified" };
  const exactFinding = result.findings.some(
    (finding) =>
      finding.repositoryId === input.repositoryId &&
      finding.commitSha.toLowerCase() === input.baseSha.toLowerCase() &&
      finding.verification === "verified",
  );
  if (!exactFinding)
    return { status: "failed", preflightRunId: runId, category: "preflight_snapshot_mismatch" };
  return { status: "passed", preflightRunId: runId, category: null };
}

/**
 * Dispatches through the existing entitlement-guarded Preflight queue and
 * validates its persisted result against this Fix Engine's exact repository
 * commit. This never treats repository verification as Preflight.
 */
export async function runCanonicalFixPreflight(input: {
  workspaceId: string;
  workspaceDependencyId: string;
  classificationId: string;
  repositoryId: string;
  baseSha: string;
  provenanceMode: "customer" | "evidence_only";
}): Promise<CanonicalFixPreflightResult> {
  if (input.provenanceMode === "evidence_only")
    throw new Error("evidence_only_preflight_forbidden");
  if (!/^[a-f0-9]{40,64}$/.test(input.baseSha)) throw new Error("invalid_preflight_base_sha");

  // Read current entitlement/usage before any dispatch. The canonical queue
  // RPC and run-preflight task independently recheck the same boundary.
  const entitlement = await resolveWorkspaceEntitlementsForService(input.workspaceId);
  if (
    !entitlement.capabilities.automaticPreflight ||
    entitlement.usage.preflightRuns >= entitlement.limits.preflightRuns
  ) {
    return { status: "ineligible", preflightRunId: null, category: "preflight_not_entitled" };
  }

  const client = createSupabaseServerClient();
  const { data: assessment, error: assessmentError } = await client
    .from("impact_assessments")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("workspace_dependency_id", input.workspaceDependencyId)
    .eq("source_change_classification_id", input.classificationId)
    .eq("status", "assessed")
    .eq("relevant", true)
    .maybeSingle();
  if (assessmentError) throw new Error("fix_preflight_assessment_read_failed");
  if (!assessment)
    return {
      status: "ineligible",
      preflightRunId: null,
      category: "preflight_assessment_unavailable",
    };

  const { data: queue, error: queueError } = await client
    .from("preflight_dispatch_queue")
    .select("id,workspace_id,impact_assessment_id,status,attempt_count")
    .eq("workspace_id", input.workspaceId)
    .eq("impact_assessment_id", assessment.id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (queueError) throw new Error("fix_preflight_queue_read_failed");
  if (
    !queue ||
    queue.workspace_id !== input.workspaceId ||
    queue.impact_assessment_id !== assessment.id
  )
    return { status: "ineligible", preflightRunId: null, category: "preflight_queue_unavailable" };

  if (queue.status !== "complete" && queue.status !== "superseded") {
    const { data: attempt, error: markError } = await client.rpc("mark_preflight_dispatch", {
      p_queue_id: queue.id,
      p_status: "dispatched",
    });
    if (markError || typeof attempt !== "number" || attempt <= 0)
      return {
        status: "ineligible",
        preflightRunId: null,
        category: "preflight_not_entitled_or_not_current",
      };
    const child = await tasks.triggerAndWait<typeof runPreflightTask>(
      "run-preflight",
      {
        queueId: queue.id,
        workspaceId: input.workspaceId,
        impactAssessmentId: assessment.id,
        attempt,
      },
      { idempotencyKey: `preflight:${queue.id}:${attempt}` },
    );
    const { data: identitySaved, error: identityError } = await client.rpc(
      "mark_preflight_dispatch_run",
      { p_queue_id: queue.id, p_attempt: attempt, p_trigger_run_id: child.id },
    );
    if (identityError || identitySaved !== true)
      throw new Error("fix_preflight_dispatch_identity_failed");
    if (!child.ok)
      return { status: "failed", preflightRunId: null, category: "preflight_task_failed" };
  } else if (queue.status === "superseded") {
    return { status: "ineligible", preflightRunId: null, category: "preflight_superseded" };
  }

  // Re-enter the canonical service in replay mode to read and validate its
  // stored assessment result. The entitlement check above prevents new runs
  // when this request is not entitled; get-or-create preserves idempotency.
  const outcome = await runPreflight({
    impactAssessmentId: assessment.id,
    provider: configuredProvider(),
  });
  return exactPreflightResult({
    outcome,
    repositoryId: input.repositoryId,
    baseSha: input.baseSha,
  });
}
