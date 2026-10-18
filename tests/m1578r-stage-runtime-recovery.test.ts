import { beforeEach, describe, expect, it, vi } from "vitest";
import { runPersistedFixStage } from "@/lib/fix-engine/stage-runtime";
import {
  terminalRunnerFailure,
  withVerificationRunnerCorrelation,
} from "@/lib/fix-engine/verification-retry";

const mocks = vi.hoisted(() => ({ createSupabaseServerClient: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));

const fixRunId = "10000000-0000-4000-8000-000000000001";
const stageId = "20000000-0000-4000-8000-000000000002";
const workspaceId = "30000000-0000-4000-8000-000000000003";
const productId = "40000000-0000-4000-8000-000000000004";
const repositoryId = "50000000-0000-4000-8000-000000000005";
const decisionId = "60000000-0000-4000-8000-000000000006";
const routeIntentId = "70000000-0000-4000-8000-000000000007";
const dependencyId = "80000000-0000-4000-8000-000000000008";
const mappingId = "90000000-0000-4000-8000-000000000009";
const sourceChangeId = "a0000000-0000-4000-8000-00000000000a";
const analysisRunId = "b0000000-0000-4000-8000-00000000000b";
const graphBuildId = "c0000000-0000-4000-8000-00000000000c";
const evidenceId = "d0000000-0000-4000-8000-00000000000d";
const claimToken = "e0000000-0000-4000-8000-00000000000e";

const run = {
  id: fixRunId,
  workspace_id: workspaceId,
  product_id: productId,
  repository_id: repositoryId,
  provider_repository_identity: "example/fix-engine-test-repository",
  workspace_dependency_id: dependencyId,
  product_repository_mapping_id: mappingId,
  source_change_id: sourceChangeId,
  source_mode: "internal_test",
  processing_mode: "evidence_only",
  provenance_mode: "evidence_only",
  intelligence_decision_id: decisionId,
  route_intent_id: routeIntentId,
  semantic_route: "deprecation",
  route_target: "dependency_product_impact",
  analysis_run_id: analysisRunId,
  graph_build_id: graphBuildId,
  commit_sha: "f".repeat(40),
  identity_fingerprint: "a".repeat(64),
  idempotency_key: "b".repeat(64),
  positive_graph_evidence_ids: [evidenceId],
  evidence_fingerprint: "c".repeat(64),
  review_disposition: "review_required",
  review_reason: "critical_change",
  preflight_required: false,
  draft_pr_policy_allowed: false,
  risk_level: null,
  production_exposure_state: "unknown",
  status: "validating",
  current_stage: "verify_patch",
};

function makeQuery(data: unknown) {
  type Query = {
    select: () => Query;
    eq: () => Query;
    limit: () => Query;
    maybeSingle: () => Promise<{ data: unknown; error: null }>;
  };
  const query = {} as Query;
  query.select = () => query;
  query.eq = () => query;
  query.limit = () => query;
  query.maybeSingle = async () => ({ data, error: null });
  return query;
}

function makeClient(options: {
  claim?: { data: unknown; error: unknown };
  diagnostic?: { data: unknown; error: unknown };
  diagnosticV2?: { data: unknown; error: unknown };
  transition?: { data: unknown; error: unknown };
  queueAfterBusy?: unknown;
}) {
  const rpc = vi.fn(async (name: string, ..._args: unknown[]) => {
    if (name === "claim_fix_stage")
      return (
        options.claim ?? {
          data: {
            status: "claimed",
            stageId,
            fixRunId,
            claimToken,
            stage: "verify_patch",
            attemptNumber: 4,
            recoveryGeneration: 3,
          },
          error: null,
        }
      );
    if (name === "complete_fix_stage_with_runner_diagnostics")
      return options.diagnostic ?? { data: null, error: { code: "PGRST000" } };
    if (name === "complete_fix_stage_with_runner_diagnostics_v2")
      return options.diagnosticV2 ?? { data: null, error: { code: "PGRST000" } };
    if (name === "record_fix_verification_runner_result")
      return {
        data: { status: "recorded", recordId: "f0000000-0000-4000-8000-00000000000f" },
        error: null,
      };
    if (name === "complete_fix_stage")
      return options.transition ?? { data: { status: "validation_failed" }, error: null };
    return { data: null, error: { code: "unexpected_rpc" } };
  });
  let queueReads = 0;
  const from = vi.fn((table: string) => {
    if (table === "fix_stage_queue") {
      queueReads += 1;
      return makeQuery(
        queueReads === 1 ? { id: stageId } : (options.queueAfterBusy ?? { status: "claimed" }),
      );
    }
    if (table === "fix_runs") return makeQuery(run);
    return makeQuery(null);
  });
  mocks.createSupabaseServerClient.mockReturnValue({ from, rpc });
  return { from, rpc };
}

beforeEach(() => mocks.createSupabaseServerClient.mockReset());

describe("M15.78R stage runtime recovery reporting", () => {
  it("returns terminal failure after fallback persistence instead of retrying into busy", async () => {
    const client = makeClient({});
    const result = await runPersistedFixStage({
      fixRunId,
      stage: "verify_patch",
      processor: async () => {
        throw terminalRunnerFailure("runner_result_invalid", {
          phase: "result_validation",
          httpStatus: 200,
          responseCategory: null,
          reason: "result_identity_mismatch",
          identityField: "patchFingerprint",
        });
      },
    });

    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_fix_stage",
      "complete_fix_stage_with_runner_diagnostics",
      "complete_fix_stage",
    ]);
    expect(result).toMatchObject({ status: "validation_failed", nextStage: null });
    expect(result).toMatchObject({
      failureCategory: "runner_result_invalid",
      diagnosticPersistence: "unavailable",
      diagnosticPersistenceErrorCode: "PGRST000",
    });
  });

  it("returns the persisted terminal diagnostic transition without throwing a Trigger retry", async () => {
    const client = makeClient({
      diagnostic: {
        data: { status: "recorded", transition: { status: "validation_failed" } },
        error: null,
      },
    });
    const result = await runPersistedFixStage({
      fixRunId,
      stage: "verify_patch",
      processor: async () => {
        throw terminalRunnerFailure("runner_result_invalid", {
          phase: "result_validation",
          httpStatus: 200,
          responseCategory: null,
          reason: "result_identity_mismatch",
          identityField: "patchFingerprint",
        });
      },
    });

    expect(result).toMatchObject({
      status: "validation_failed",
      diagnosticPersistence: "recorded",
    });
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_fix_stage",
      "complete_fix_stage_with_runner_diagnostics",
    ]);
  });

  it("persists bounded runner correlation atomically through the v2 diagnostic RPC", async () => {
    const client = makeClient({
      diagnosticV2: {
        data: { status: "recorded", transition: { status: "validation_failed" } },
        error: null,
      },
    });
    const failure = withVerificationRunnerCorrelation(
      terminalRunnerFailure("runner_result_invalid", {
        phase: "admission",
        httpStatus: 400,
        responseCategory: "verification_artifact_unavailable",
        reason: "http_error",
      }),
      {
        jobId: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        admissionState: "rejected",
      },
    );
    const result = await runPersistedFixStage({
      fixRunId,
      stage: "verify_patch",
      processor: async () => {
        throw failure;
      },
    });
    const diagnosticCall = client.rpc.mock.calls.find(
      ([name]) => name === "complete_fix_stage_with_runner_diagnostics_v2",
    );
    expect(diagnosticCall?.[1]).toMatchObject({
      p_failure_category: "runner_result_invalid",
      p_correlation: {
        jobId: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        admissionState: "rejected",
      },
    });
    expect(result).toMatchObject({
      status: "validation_failed",
      diagnosticPersistence: "recorded",
    });
  });

  it("persists signed remote result identity before completing verification", async () => {
    const client = makeClient({});
    const record = {
      patchId: "f0000000-0000-4000-8000-000000000010",
      patchFingerprint: "c".repeat(64),
      profileId: "javascript-typescript-v1",
      status: "passed",
      checks: [],
      diagnosticSummary: "",
      durationMs: 12,
      attemptNumber: 1,
      runnerEvidence: {
        jobId: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        resultFingerprint: "d".repeat(64),
        protocolVersion: "m1578-verification-runner-v1",
        runnerVersion: "m1578-runner-v1",
        runtimeImage:
          "node:24.8.0-alpine3.22@sha256:3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17",
        resultSignatureValidated: true,
      },
    };
    const result = await runPersistedFixStage({
      fixRunId,
      stage: "verify_patch",
      processor: async () => ({ recordKind: "verification", record }),
    });
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "claim_fix_stage",
      "record_fix_verification_runner_result",
      "complete_fix_stage",
    ]);
    expect(client.rpc.mock.calls[1]?.[1]).toMatchObject({ p_payload: record });
    expect(result).toMatchObject({ status: "completed", replayed: false });
  });

  it("does not classify a claim RPC error as ordinary contention", async () => {
    makeClient({ claim: { data: null, error: { code: "08006" } } });
    await expect(
      runPersistedFixStage({
        fixRunId,
        stage: "verify_patch",
        processor: async () => ({ recordKind: "verification", record: {} }),
      }),
    ).rejects.toThrow("fix_stage_claim_unavailable");
  });

  it("reports an already-failed stage instead of returning busy after a replay", async () => {
    makeClient({
      claim: { data: { status: "busy" }, error: null },
      queueAfterBusy: { status: "failed", failure_category: "runner_result_invalid" },
    });
    const result = await runPersistedFixStage({
      fixRunId,
      stage: "verify_patch",
      processor: async () => ({ recordKind: "verification", record: {} }),
    });

    expect(result).toMatchObject({
      status: "failed",
      nextStage: null,
      failureCategory: "runner_result_invalid",
    });
  });

  it("keeps busy for a stage that is still claimed by another worker", async () => {
    makeClient({
      claim: { data: { status: "busy" }, error: null },
      queueAfterBusy: { status: "claimed", failure_category: null },
    });
    const result = await runPersistedFixStage({
      fixRunId,
      stage: "verify_patch",
      processor: async () => ({ recordKind: "verification", record: {} }),
    });

    expect(result).toEqual({ status: "busy", nextStage: null });
  });
});
