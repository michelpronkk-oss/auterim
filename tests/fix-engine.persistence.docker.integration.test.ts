import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import {
  createPersistedFixRun,
  runPersistedFixStage,
  type FixStageProcessor,
} from "@/lib/fix-engine/stage-runtime";
import type { FixStage } from "@/lib/fix-engine/contracts";

const enabled = process.env.AUTERIM_M1578_DOCKER_ACCEPTANCE === "1";
const url = process.env.AUTERIM_M1578_EXPECTED_URL;
const serviceKey = process.env.AUTERIM_M1578_SERVICE_KEY;
const workspaceId = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const productId = "de1f2a12-de3c-4644-8892-b6c2d458a300";
const repositoryId = "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

describe.skipIf(!enabled)("M15.78 canonical persistence on isolated Docker Supabase", () => {
  it("runs exact-commit evidence-only stages through risk without Preflight or external writes", async () => {
    expect(url).toBe("http://127.0.0.1:54970");
    expect(serviceKey?.length).toBeGreaterThan(20);
    const client = createClient(url!, serviceKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: sources, error: sourceError } = await client
      .from("source_changes")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("scope_product_id", productId)
      .eq("source_mode", "internal_test")
      .eq("processing_mode", "evidence_only");
    expect(sourceError).toBeNull();
    const sourceIds = (sources ?? []).map((source) => source.id);
    expect(sourceIds.length).toBeGreaterThan(0);

    const { data: graph, error: graphError } = await client
      .from("impact_graph_builds")
      .select(
        "id,source_change_id,workspace_id,product_id,repository_id,commit_sha,status,assessment_state",
      )
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .eq("repository_id", repositoryId)
      .eq("status", "completed")
      .eq("assessment_state", "evidence_present")
      .in("source_change_id", sourceIds)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    expect(graphError).toBeNull();
    expect(graph).not.toBeNull();
    expect(graph?.commit_sha).toMatch(/^[a-f0-9]{40,64}$/);

    const { data: edge, error: edgeError } = await client
      .from("impact_graph_edges")
      .select(
        "id,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column",
      )
      .eq("graph_build_id", graph!.id)
      .eq("edge_kind", "observed")
      .not("evidence_path", "is", null)
      .not("evidence_start_line", "is", null)
      .not("evidence_start_column", "is", null)
      .not("evidence_end_line", "is", null)
      .not("evidence_end_column", "is", null)
      .order("edge_fingerprint", { ascending: true })
      .limit(1)
      .single();
    expect(edgeError).toBeNull();
    if (!edge) throw new Error("fix_fixture_observed_edge_missing");
    expect(edge.evidence_path).toBeTruthy();

    const first = await createPersistedFixRun(graph!.id);
    const second = await createPersistedFixRun(graph!.id);
    expect(second.fixRunId).toBe(first.fixRunId);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);

    const { data: fixRun, error: fixRunError } = await client
      .from("fix_runs")
      .select(
        "id,workspace_id,product_id,repository_id,classification_id,source_mode,processing_mode,provenance_mode,graph_build_id,analysis_run_id,commit_sha,review_disposition,review_reason,production_exposure_state,positive_graph_evidence_ids",
      )
      .eq("id", first.fixRunId)
      .single();
    expect(fixRunError).toBeNull();
    expect(fixRun).toMatchObject({
      workspace_id: workspaceId,
      product_id: productId,
      repository_id: repositoryId,
      source_mode: "internal_test",
      processing_mode: "evidence_only",
      provenance_mode: "evidence_only",
      graph_build_id: graph!.id,
      analysis_run_id: expect.any(String),
      commit_sha: graph!.commit_sha,
      review_disposition: "review_required",
      review_reason: "critical_change",
      production_exposure_state: "unknown",
    });
    expect(fixRun?.positive_graph_evidence_ids).toContain(edge.id);

    for (const stage of ["preflight", "create_draft_pr"] as const) {
      const attempt = await client.from("fix_stage_queue").insert({
        fix_run_id: first.fixRunId,
        workspace_id: workspaceId,
        stage,
        idempotency_key: sha256(`${first.fixRunId}:${stage}`),
      });
      expect(attempt.error).not.toBeNull();
    }

    const attemptId = "c0000000-0000-4000-8000-000000000001";
    const patchText = [
      `diff --git a/${edge.evidence_path} b/${edge.evidence_path}`,
      `--- a/${edge.evidence_path}`,
      `+++ b/${edge.evidence_path}`,
      "@@ -1,1 +1,1 @@",
      "-old endpoint call",
      "+new endpoint call",
      "",
    ].join("\n");
    const patchFingerprint = sha256(patchText);
    const artifactPath = `${first.fixRunId}/${attemptId}.diff`;
    const upload = await client.storage
      .from("fix-engine-artifacts")
      .upload(artifactPath, patchText, {
        contentType: "text/x-diff",
        upsert: false,
      });
    expect(upload.error).toBeNull();

    let planId: string | null = null;
    let patchId: string | null = null;
    const stages: FixStage[] = [];
    const processor: FixStageProcessor = async ({
      run,
      stage,
      stageId,
      claimToken,
      attemptNumber,
    }) => {
      stages.push(stage);
      if (stage === "diagnose") {
        const lease = await client
          .from("fix_stage_queue")
          .select("lease_expires_at")
          .eq("id", stageId)
          .single();
        expect(lease.error).toBeNull();
        expect(Date.parse(lease.data!.lease_expires_at) - Date.now()).toBeGreaterThan(250_000);
      }
      if (stage === "diagnose") {
        const inputFingerprint = sha256(`${run.id}:model-input`);
        const started = await client.rpc("begin_fix_model_attempt", {
          p_stage_id: stageId,
          p_claim_token: claimToken,
          p_attempt_number: attemptNumber,
          p_provider: "fixture",
          p_model: "m1578-deterministic-fixture-v1",
          p_schema_version: "fix-engine-v1",
          p_prompt_contract_version: "fix-coding-contract-v1",
          p_input_fingerprint: inputFingerprint,
        });
        expect(started.error).toBeNull();
        const attemptId = started.data?.attemptId;
        expect(typeof attemptId).toBe("string");
        const completedModelAttempt = await client.rpc("finish_fix_model_attempt", {
          p_stage_id: stageId,
          p_claim_token: claimToken,
          p_attempt_id: attemptId,
          p_status: "succeeded",
          p_model_version: "fixture-v1",
          p_output_fingerprint: sha256(`${run.id}:model-output`),
          p_latency_ms: 0,
          p_input_tokens: 0,
          p_output_tokens: 0,
          p_cost_microusd: 0,
          p_failure_category: null,
        });
        expect(completedModelAttempt.error).toBeNull();
        return {
          recordKind: "diagnosis",
          record: {
            diagnosis: {
              rootCauseCategory: "endpoint_contract_changed",
              affectedLocations: [
                {
                  evidenceId: edge.id,
                  span: {
                    path: edge.evidence_path,
                    startLine: edge.evidence_start_line,
                    startColumn: edge.evidence_start_column,
                    endLine: edge.evidence_end_line,
                    endColumn: edge.evidence_end_column,
                  },
                  symbol: "http_call",
                  externalEntity: "fixture endpoint",
                },
              ],
              recommendedTransformationClass: "endpoint_replacement",
              confidenceClass: "exact",
              changeFamily: "endpoint",
            },
            changeFamily: "endpoint",
            evidenceIds: [edge.id],
            provider: "fixture",
            model: "m1578-deterministic-fixture-v1",
            modelVersion: "v1",
            schemaVersion: "fix-diagnosis-v1",
            promptContractVersion: "fix-diagnosis-fixture-v1",
            inputFingerprint: sha256(`${run.id}:diagnosis:input`),
            outputFingerprint: sha256(`${run.id}:diagnosis:output`),
            latencyMs: 0,
            inputTokens: 0,
            outputTokens: 0,
            costMicrousd: 0,
          },
        };
      }
      if (stage === "plan") {
        const plan = {
          allowedFiles: [
            {
              path: edge.evidence_path,
              evidenceIds: [edge.id],
              transformations: ["endpoint_replacement"],
            },
          ],
          preconditions: ["the pinned endpoint fact is present"],
          postconditions: ["the planned endpoint fact is present"],
          dependencyChanges: [],
          apiSchemaConfigChanges: ["api"],
          expectedTests: [],
          verificationProfile: "javascript-typescript-v1",
          preflightApplicability: "not_applicable",
          riskFactors: [],
          humanReviewRequired: true,
        };
        return {
          recordKind: "plan",
          record: {
            plan,
            planVersion: 1,
            planFingerprint: sha256(`${run.id}:plan`),
            provider: "fixture",
            model: "m1578-deterministic-fixture-v1",
            schemaVersion: "fix-plan-v1",
            promptContractVersion: "fix-plan-fixture-v1",
          },
        };
      }
      if (stage === "generate_patch") {
        const { data } = await client
          .from("fix_plans")
          .select("id")
          .eq("fix_run_id", run.id)
          .single();
        planId = data?.id ?? null;
        if (!planId) throw new Error("fixture_plan_missing");
        return {
          recordKind: "patch",
          record: {
            planId,
            attemptNumber: 1,
            baseSha: run.commit_sha,
            patchFingerprint,
            artifactPath,
            changedPaths: [edge.evidence_path],
            lineCount: 2,
            byteCount: Buffer.byteLength(patchText),
            provider: "fixture",
            model: "m1578-deterministic-fixture-v1",
          },
        };
      }
      if (stage === "apply_patch") {
        const { data } = await client
          .from("fix_patches")
          .select("id")
          .eq("fix_run_id", run.id)
          .single();
        patchId = data?.id ?? null;
        if (!planId || !patchId) throw new Error("fixture_patch_missing");
        return { recordKind: "patch", record: { planId, patchId } };
      }
      if (stage === "verify_patch") {
        if (!patchId) throw new Error("fixture_patch_missing");
        return {
          recordKind: "verification",
          record: {
            patchId,
            patchFingerprint,
            profileId: "fixture-verify-v1",
            status: "passed",
            checks: [{ commandClass: "targeted_test", status: "passed", durationMs: 0 }],
            diagnosticSummary: "",
            durationMs: 0,
            attemptNumber: 1,
          },
        };
      }
      if (stage === "risk_assess") {
        return {
          recordKind: "risk",
          record: {
            riskVersion: "fix-risk-v1",
            riskLevel: "LOW",
            factors: [],
            inputFingerprint: sha256(`${run.id}:risk`),
          },
        };
      }
      throw new Error("unexpected_evidence_only_stage");
    };

    let stage: FixStage | null = "diagnose";
    while (stage) {
      if (stages.length >= 8) throw new Error("fix_stage_bound_exceeded");
      let result;
      try {
        result = await runPersistedFixStage({ fixRunId: first.fixRunId, stage, processor });
      } catch (error) {
        const category =
          error instanceof Error && /^fix_[a-z0-9_]{1,100}$/.test(error.message)
            ? error.message
            : "fix_stage_failed";
        throw new Error(`${stage}_${category}`);
      }
      expect(result.status).toBe("completed");
      stage = result.nextStage;
    }
    expect(stages).toEqual([
      "diagnose",
      "plan",
      "generate_patch",
      "apply_patch",
      "verify_patch",
      "risk_assess",
    ]);
    let duplicateProcessorCalls = 0;
    const duplicate = await runPersistedFixStage({
      fixRunId: first.fixRunId,
      stage: "diagnose",
      processor: async () => {
        duplicateProcessorCalls += 1;
        throw new Error("completed_fix_stage_reexecuted");
      },
    });
    expect(duplicate).toMatchObject({ status: "completed", nextStage: null, replayed: true });
    expect(duplicateProcessorCalls).toBe(0);

    const { data: completedRun, error: completedError } = await client
      .from("fix_runs")
      .select(
        "status,current_stage,risk_level,review_disposition,review_reason,production_exposure_state",
      )
      .eq("id", first.fixRunId)
      .single();
    expect(completedError).toBeNull();
    expect(completedRun).toMatchObject({
      status: "candidate_validated",
      current_stage: "risk_assess",
      risk_level: "LOW",
      review_disposition: "review_required",
      review_reason: "critical_change",
      production_exposure_state: "unknown",
    });

    const { data: queues, error: queueError } = await client
      .from("fix_stage_queue")
      .select("stage,status")
      .eq("fix_run_id", first.fixRunId)
      .order("created_at", { ascending: true });
    expect(queueError).toBeNull();
    expect(queues?.every((queue) => queue.status === "completed")).toBe(true);
    expect(queues?.map((queue) => queue.stage)).not.toContain("preflight");
    expect(queues?.map((queue) => queue.stage)).not.toContain("create_draft_pr");

    const [preflight, external, pr] = await Promise.all([
      client.from("fix_preflight_results").select("id").eq("fix_run_id", first.fixRunId),
      client.from("fix_external_operations").select("id").eq("fix_run_id", first.fixRunId),
      client.from("fix_pr_outcomes").select("id").eq("fix_run_id", first.fixRunId),
    ]);
    expect(preflight.data).toEqual([]);
    expect(external.data).toEqual([]);
    expect(pr.data).toEqual([]);
    const modelAttempts = await client
      .from("fix_model_attempts")
      .select("stage,attempt_number,status,input_fingerprint,output_fingerprint")
      .eq("fix_run_id", first.fixRunId);
    expect(modelAttempts.error).toBeNull();
    expect(modelAttempts.data).toEqual([
      expect.objectContaining({
        stage: "diagnose",
        attempt_number: 1,
        status: "succeeded",
        input_fingerprint: sha256(`${first.fixRunId}:model-input`),
        output_fingerprint: sha256(`${first.fixRunId}:model-output`),
      }),
    ]);
    await client.storage.from("fix-engine-artifacts").remove([artifactPath]);
  });
});
