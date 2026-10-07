import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { tasks } from "@trigger.dev/sdk";
import { describe, expect, it } from "vitest";
import { runPersistedSyntheticChange } from "@/lib/m15/persisted-synthetic-change";
import { SupabasePreflightRepository } from "@/lib/preflight/preflight-service";
import {
  provePersistedCoreConcurrency,
  provePreflightClaimRace,
  proveProductIdempotencyConcurrency,
  proveRemediationClaimRace,
  proveValidationClaimRace,
} from "../scripts/m15-validation/persisted-core-concurrency.mts";
import type { IndependentRaceResult } from "../scripts/m15-validation/postgres-concurrency.mts";
import type { dispatchPreflightQueueTask } from "@/trigger/dispatch-preflight";
import type { dispatchRemediationPreparationTask } from "@/trigger/dispatch-remediation-preparation";
import type { dispatchRemediationValidationTask } from "@/trigger/dispatch-remediation-validation";
import {
  proveBusinessHandoffRealTrigger,
  type BusinessHandoffScenario,
} from "./m15-business-handoff-real-trigger.helper";
import type { CustomerImpactClassifier } from "@/lib/impact/impact";
import type { SemanticClassifier } from "@/lib/monitoring/classification";

const enabled = process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1";
const realTriggerTopology = process.env.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY === "1";
// This local acceptance client queries migrations without a generated Database type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LocalSupabaseClient = ReturnType<typeof createClient<any, "public", "public">>;

type LocalTaskOutcome = {
  taskId: string;
  runId: string;
  queueId: string;
  queueAttempt: number;
  triggerAttempt: number;
  outcome: string;
  observedAt?: string;
};

const localTaskOutcomesPath = path.join(
  process.cwd(),
  "node_modules",
  ".cache",
  "m15-local",
  "task-outcomes.jsonl",
);

async function waitForLocalTaskOutcomes(
  taskId: string,
  queueId: string,
  expectedOutcomes: Array<string | string[]>,
) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    let rows: LocalTaskOutcome[] = [];
    try {
      rows = (await readFile(localTaskOutcomesPath, "utf8"))
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LocalTaskOutcome];
          } catch {
            return [];
          }
        });
    } catch {
      // The local dev worker creates the marker file when it completes the first QA task.
    }
    const candidates = rows.filter((row) => row.queueId === queueId && row.taskId === taskId);
    const accepted = expectedOutcomes.map(
      (outcomes) => new Set(Array.isArray(outcomes) ? outcomes : [outcomes]),
    );
    const first = candidates.find((row) => accepted[0]?.has(row.outcome));
    const second = candidates.find(
      (row) => accepted[1]?.has(row.outcome) && row.runId !== first?.runId,
    );
    if (first && second) return [first, second];
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`m15_real_trigger_delivery_outcome_timeout:${taskId}`);
}

async function triggerLocalDispatcher(
  kind: "preflight" | "remediation" | "validation",
): Promise<string> {
  if (
    !realTriggerTopology ||
    process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1" ||
    process.env.AUTERIM_M15_LOCAL_SUPABASE_URL !== "http://127.0.0.1:65431" ||
    !process.env.TRIGGER_SECRET_KEY?.startsWith("tr_dev_sk_")
  ) {
    throw new Error("m15_real_trigger_dispatch_guard_failed");
  }
  const schedulePayload = {
    type: "IMPERATIVE" as const,
    // Trigger.dev can coalesce imperative schedules that reuse a task's scheduleId.
    // Each queue poll is an intentional new dispatcher execution, so give it a unique ID.
    scheduleId: `m15-${kind}-${randomUUID()}`,
    timestamp: new Date(),
    timezone: "UTC",
    upcoming: [],
  };
  const handle =
    kind === "preflight"
      ? await tasks.trigger<typeof dispatchPreflightQueueTask>(
          "dispatch-preflight-queue",
          schedulePayload,
        )
      : kind === "remediation"
        ? await tasks.trigger<typeof dispatchRemediationPreparationTask>(
            "dispatch-remediation-preparation",
            schedulePayload,
          )
        : await tasks.trigger<typeof dispatchRemediationValidationTask>(
            "dispatch-remediation-validation",
            schedulePayload,
          );
  if (!/^run_[A-Za-z0-9_-]+$/.test(handle.id)) {
    throw new Error(`m15_real_${kind}_dispatcher_run_id_invalid`);
  }
  return handle.id;
}

const m15PreclaimGateRoot = path.resolve(
  process.cwd(),
  "node_modules/.cache/m15-local/preclaim-gates",
);
const m15DuplicateDeliveryTargetRoot = path.resolve(
  process.cwd(),
  "node_modules/.cache/m15-local/duplicate-delivery-targets",
);

async function markDuplicateDeliveryTarget(queueId: string) {
  await mkdir(m15DuplicateDeliveryTargetRoot, { recursive: true });
  const marker = path.join(m15DuplicateDeliveryTargetRoot, queueId);
  await writeFile(marker, "duplicate", { flag: "wx", mode: 0o600 });
  return marker;
}

async function releasePreclaimGate(taskId: string, queueId: string) {
  const marker = path.join(m15PreclaimGateRoot, `${taskId}-${queueId}.release`);
  try {
    await writeFile(marker, "release", { flag: "wx", mode: 0o600 });
  } catch (error) {
    // The worker-side gate and acceptance cleanup can release the same exact queue
    // concurrently. The marker is a one-way signal, so an existing marker is success.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function removePreclaimGateArtifacts(taskId: string, queueIds: string[]) {
  await rm(path.join(m15PreclaimGateRoot, `${taskId}-hold-all`), { force: true });
  await Promise.all(
    queueIds.flatMap((queueId) =>
      ["hold", "started", "release"].map((suffix) =>
        rm(path.join(m15PreclaimGateRoot, `${taskId}-${queueId}.${suffix}`), { force: true }),
      ),
    ),
  );
}

async function prepareAdditionalBusinessScenarios(input: {
  client: LocalSupabaseClient;
  workspaceId: string;
  impactAssessmentIds: string[];
  repositoryId: string;
  intentPath: string;
}): Promise<{
  scenarios: BusinessHandoffScenario[];
  claimRaceResults: Partial<
    Record<"preflight" | "remediation" | "validation", IndependentRaceResult>
  >;
  claimRaceFailures: string[];
}> {
  const claimRaceResults: Partial<
    Record<"preflight" | "remediation" | "validation", IndependentRaceResult>
  > = {};
  const claimRaceFailures: string[] = [];
  const deadline = Date.now() + 300_000;
  await mkdir(m15PreclaimGateRoot, { recursive: true });
  const remediationHoldAll = path.join(m15PreclaimGateRoot, "prepare-remediation-hold-all");
  await writeFile(remediationHoldAll, randomUUID(), { flag: "wx", mode: 0o600 });
  const validationHoldAll = path.join(m15PreclaimGateRoot, "validate-remediation-hold-all");
  await triggerLocalDispatcher("preflight");
  let nextPreflightDispatchAt = Date.now() + 30_000;
  let preflights: Array<{
    id: string;
    impact_assessment_id: string;
    status: string;
    verified_impact: string;
  }> = [];
  while (Date.now() < deadline) {
    if (Date.now() >= nextPreflightDispatchAt) {
      await triggerLocalDispatcher("preflight");
      nextPreflightDispatchAt = Date.now() + 30_000;
    }
    const { data, error } = await input.client
      .from("preflight_runs")
      .select("id,impact_assessment_id,status,verified_impact")
      .in("impact_assessment_id", input.impactAssessmentIds)
      .eq("workspace_id", input.workspaceId);
    if (error) throw new Error("m15_business_preflight_read_failed");
    preflights = data ?? [];
    if (
      input.impactAssessmentIds.every((id) =>
        preflights.some(
          (run) =>
            run.impact_assessment_id === id &&
            run.status === "completed" &&
            run.verified_impact === "verified",
        ),
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (
    !input.impactAssessmentIds.every((id) =>
      preflights.some(
        (run) =>
          run.impact_assessment_id === id &&
          run.status === "completed" &&
          run.verified_impact === "verified",
      ),
    )
  ) {
    const completed = input.impactAssessmentIds.filter((id) =>
      preflights.some(
        (run) =>
          run.impact_assessment_id === id &&
          run.status === "completed" &&
          run.verified_impact === "verified",
      ),
    ).length;
    throw new Error(
      `m15_business_preflight_worker_timeout_${completed}_of_${input.impactAssessmentIds.length}`,
    );
  }

  const preflightIds = preflights.map((run) => run.id);
  const preflightRaceFixture = preflights[0];
  if (!preflightRaceFixture) throw new Error("m15_preflight_claim_race_fixture_missing");
  const raceRepository = new SupabasePreflightRepository();
  const raceRun = await raceRepository.getOrCreateRun({
    workspaceId: input.workspaceId,
    impactAssessmentId: preflightRaceFixture.impact_assessment_id,
    repositorySetFingerprint: createHash("sha256")
      .update(`m15-preflight-claim:${randomUUID()}`)
      .digest("hex"),
    changeFingerprint: createHash("sha256")
      .update(`m15-preflight-change:${randomUUID()}`)
      .digest("hex"),
    preflightVersion: "m15-claim-race-v1",
  });
  if (raceRun.status !== "queued") throw new Error("m15_preflight_claim_race_not_queued");
  try {
    claimRaceResults.preflight = await provePreflightClaimRace({
      workspaceId: input.workspaceId,
      preflightRunId: raceRun.id,
    });
  } catch (error) {
    claimRaceFailures.push(safeAcceptanceErrorCode(error));
  }

  let remediationQueues: Array<{
    id: string;
    preflight_run_id: string;
    status: string;
    attempt_count: number;
    remediation_proposal_id: string | null;
  }> = [];
  let remediationQueueIds: string[] = [];
  let workspaceRemediationQueueIds: string[] = [];
  let remediationClaimRace: IndependentRaceResult | undefined;
  let validationGateTransferred = false;
  try {
    await triggerLocalDispatcher("remediation");
    const remediationDeadline = Date.now() + 300_000;
    let nextRemediationDispatchAt = Date.now() + 30_000;
    while (Date.now() < remediationDeadline) {
      if (Date.now() >= nextRemediationDispatchAt) {
        await triggerLocalDispatcher("remediation");
        nextRemediationDispatchAt = Date.now() + 30_000;
      }
      const { data, error } = await input.client
        .from("remediation_preparation_queue")
        .select("id,preflight_run_id,status,attempt_count,remediation_proposal_id")
        .in("preflight_run_id", preflightIds)
        .eq("workspace_id", input.workspaceId);
      if (error) throw new Error("m15_business_remediation_read_failed");
      remediationQueues = data ?? [];
      remediationQueueIds = remediationQueues.map((row) => row.id);
      if (
        preflightIds.every((id) => remediationQueues.some((row) => row.preflight_run_id === id))
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (remediationQueues.length !== preflightIds.length) {
      throw new Error("m15_business_remediation_queue_incomplete");
    }
    const { data: workspaceRemediationRows, error: workspaceRemediationError } = await input.client
      .from("remediation_preparation_queue")
      .select("id")
      .eq("workspace_id", input.workspaceId);
    if (workspaceRemediationError) throw new Error("m15_workspace_remediation_queue_read_failed");
    workspaceRemediationQueueIds = (workspaceRemediationRows ?? []).map((row) => row.id);
    await Promise.all(
      workspaceRemediationQueueIds
        .filter((queueId) => !remediationQueueIds.includes(queueId))
        .map((queueId) => releasePreclaimGate("prepare-remediation", queueId)),
    );
    const remediationRaceDeadline = Date.now() + 180_000;
    let remediationRaceQueue: (typeof remediationQueues)[number] | undefined;
    while (Date.now() < remediationRaceDeadline) {
      const { data, error } = await input.client
        .from("remediation_preparation_queue")
        .select("id,preflight_run_id,status,attempt_count,remediation_proposal_id")
        .in("id", remediationQueueIds)
        .eq("workspace_id", input.workspaceId);
      if (error) throw new Error("m15_business_remediation_dispatch_read_failed");
      remediationQueues = data ?? [];
      for (const candidate of remediationQueues) {
        try {
          await access(
            path.join(m15PreclaimGateRoot, `prepare-remediation-${candidate.id}.started`),
          );
          remediationRaceQueue = candidate;
          break;
        } catch {
          // Select only a child the real worker has parked behind the QA pre-claim gate.
        }
      }
      if (remediationRaceQueue) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!remediationRaceQueue) {
      throw new Error("m15_remediation_claim_race_preclaim_not_reached");
    }
    await writeFile(validationHoldAll, randomUUID(), { flag: "wx", mode: 0o600 });
    await rm(remediationHoldAll, { force: true });
    await Promise.all(
      workspaceRemediationQueueIds
        .filter((queueId) => queueId !== remediationRaceQueue!.id)
        .map((queueId) => releasePreclaimGate("prepare-remediation", queueId)),
    );
    const { data: dispatchedRows, error: dispatchedReadError } = await input.client
      .from("remediation_preparation_queue")
      .select("id,preflight_run_id,status,attempt_count,remediation_proposal_id")
      .in("id", remediationQueueIds)
      .eq("workspace_id", input.workspaceId);
    if (dispatchedReadError) throw new Error("m15_business_remediation_dispatch_read_failed");
    remediationQueues = dispatchedRows ?? [];
    const dispatchedRaceQueue = remediationQueues.find((row) => row.id === remediationRaceQueue.id);
    if (dispatchedRaceQueue?.status !== "dispatched") {
      throw new Error("m15_remediation_claim_race_queue_not_dispatched");
    }
    try {
      remediationClaimRace = await proveRemediationClaimRace({
        workspaceId: input.workspaceId,
        queueId: remediationRaceQueue.id,
        attempt: dispatchedRaceQueue.attempt_count,
      });
      claimRaceResults.remediation = remediationClaimRace;
    } catch (error) {
      claimRaceFailures.push(safeAcceptanceErrorCode(error));
    }
    await releasePreclaimGate("prepare-remediation", remediationRaceQueue.id);
    await triggerLocalDispatcher("remediation");
    const remediationCompletionDeadline = Date.now() + 180_000;
    let nextRemediationRetryAt = Date.now() + 12_000;
    while (Date.now() < remediationCompletionDeadline) {
      if (Date.now() >= nextRemediationRetryAt) {
        await triggerLocalDispatcher("remediation");
        nextRemediationRetryAt = Date.now() + 12_000;
      }
      const { data, error } = await input.client
        .from("remediation_preparation_queue")
        .select("id,preflight_run_id,status,attempt_count,remediation_proposal_id")
        .in("id", remediationQueueIds)
        .eq("workspace_id", input.workspaceId);
      if (error) throw new Error("m15_business_remediation_read_failed");
      remediationQueues = data ?? [];
      if (
        preflightIds.every((id) =>
          remediationQueues.some(
            (row) =>
              row.preflight_run_id === id &&
              row.status === "completed" &&
              row.remediation_proposal_id,
          ),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (
      !preflightIds.every((id) =>
        remediationQueues.some(
          (row) =>
            row.preflight_run_id === id &&
            row.status === "completed" &&
            row.remediation_proposal_id,
        ),
      )
    ) {
      throw new Error("m15_business_remediation_worker_timeout");
    }
    validationGateTransferred = true;
  } finally {
    await rm(remediationHoldAll, { force: true });
    // Keep the validation hold until the independent validation claim race reaches its
    // own pre-claim gate. A remediation race failure must not release validation workers
    // early and make the validation case unobservable.
    if (!validationGateTransferred) await rm(validationHoldAll, { force: true });
    await Promise.all(
      workspaceRemediationQueueIds.map((queueId) =>
        releasePreclaimGate("prepare-remediation", queueId).catch(() => undefined),
      ),
    );
    await removePreclaimGateArtifacts("prepare-remediation", workspaceRemediationQueueIds);
  }
  const proposalIds = remediationQueues
    .map((row) => row.remediation_proposal_id)
    .filter((id): id is string => Boolean(id));
  await mkdir(m15PreclaimGateRoot, { recursive: true });
  let validationQueues: Array<{
    id: string;
    remediation_proposal_id: string;
    status: string;
    attempt_count: number;
  }> = [];
  let validationQueueIds: string[] = [];
  let workspaceValidationQueueIds: string[] = [];
  let validationClaimRace: IndependentRaceResult | undefined;
  try {
    await triggerLocalDispatcher("validation");
    const validationDeadline = Date.now() + 180_000;
    while (Date.now() < validationDeadline) {
      const { data, error } = await input.client
        .from("remediation_validation_queue")
        .select("id,remediation_proposal_id,status,attempt_count")
        .in("remediation_proposal_id", proposalIds)
        .eq("workspace_id", input.workspaceId);
      if (error) throw new Error("m15_business_validation_read_failed");
      validationQueues = data ?? [];
      validationQueueIds = validationQueues.map((row) => row.id);
      if (
        proposalIds.every((id) =>
          validationQueues.some((row) => row.remediation_proposal_id === id),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (validationQueues.length !== proposalIds.length) {
      throw new Error("m15_business_validation_queue_incomplete");
    }
    const { data: workspaceValidationRows, error: workspaceValidationError } = await input.client
      .from("remediation_validation_queue")
      .select("id")
      .eq("workspace_id", input.workspaceId);
    if (workspaceValidationError) throw new Error("m15_workspace_validation_queue_read_failed");
    workspaceValidationQueueIds = (workspaceValidationRows ?? []).map((row) => row.id);
    await Promise.all(
      workspaceValidationQueueIds
        .filter((queueId) => !validationQueueIds.includes(queueId))
        .map((queueId) => releasePreclaimGate("validate-remediation", queueId)),
    );
    if (!validationQueues[0]) throw new Error("m15_validation_claim_race_fixture_missing");
    const validationDispatchedDeadline = Date.now() + 300_000;
    let nextValidationDispatchAt = Date.now() + 30_000;
    let validationRaceQueue: (typeof validationQueues)[number] | undefined;
    while (Date.now() < validationDispatchedDeadline) {
      if (Date.now() >= nextValidationDispatchAt) {
        await triggerLocalDispatcher("validation");
        nextValidationDispatchAt = Date.now() + 30_000;
      }
      const { data, error } = await input.client
        .from("remediation_validation_queue")
        .select("id,remediation_proposal_id,status,attempt_count")
        .in("id", validationQueueIds)
        .eq("workspace_id", input.workspaceId);
      if (error) throw new Error("m15_business_validation_dispatch_read_failed");
      validationQueues = data ?? [];
      for (const candidate of validationQueues) {
        try {
          await access(
            path.join(m15PreclaimGateRoot, `validate-remediation-${candidate.id}.started`),
          );
          validationRaceQueue = candidate;
          break;
        } catch {
          // Select only a child that the real worker has parked before its canonical claim.
        }
      }
      if (validationRaceQueue) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!validationRaceQueue) {
      const { data: finalRows, error: finalRowsError } = await input.client
        .from("remediation_validation_queue")
        .select("id,remediation_proposal_id,status,attempt_count,trigger_run_id")
        .in("id", validationQueueIds)
        .eq("workspace_id", input.workspaceId);
      let workerOutcomes: Array<{
        runId: string;
        queueId: string;
        outcome: string;
        observedAt: string;
      }> = [];
      try {
        workerOutcomes = (await readFile(localTaskOutcomesPath, "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              const row = JSON.parse(line) as Partial<LocalTaskOutcome>;
              return row.taskId === "validate-remediation" &&
                typeof row.runId === "string" &&
                typeof row.queueId === "string" &&
                validationQueueIds.includes(row.queueId) &&
                typeof row.outcome === "string" &&
                typeof row.observedAt === "string"
                ? [
                    {
                      runId: row.runId,
                      queueId: row.queueId,
                      outcome: row.outcome,
                      observedAt: row.observedAt,
                    },
                  ]
                : [];
            } catch {
              return [];
            }
          });
      } catch {
        // Missing worker outcome log is captured as an empty, bounded diagnostic.
      }
      const gateObservations = await Promise.all(
        validationQueueIds.map(async (queueId) => {
          const markerExists = async (suffix: "hold" | "started" | "release") => {
            try {
              await access(
                path.join(m15PreclaimGateRoot, `validate-remediation-${queueId}.${suffix}`),
              );
              return true;
            } catch {
              return false;
            }
          };
          return {
            queueId,
            hold: await markerExists("hold"),
            started: await markerExists("started"),
            release: await markerExists("release"),
          };
        }),
      );
      await appendTopologyCheckpoint(input.intentPath, "business_validation_gate_timeout", {
        validationQueueIds,
        validationQueueReadSucceeded: !finalRowsError,
        validationQueueState: JSON.stringify(
          (finalRows ?? []).map((row) => ({
            id: row.id,
            status: row.status,
            attemptCount: row.attempt_count,
            hasTriggerRun: Boolean(row.trigger_run_id),
          })),
        ),
        validationGateMarkers: JSON.stringify(gateObservations),
        validationWorkerOutcomes: JSON.stringify(workerOutcomes),
      });
      throw new Error("m15_validation_claim_race_preclaim_not_reached");
    }
    await rm(validationHoldAll, { force: true });
    await Promise.all(
      workspaceValidationQueueIds
        .filter((queueId) => queueId !== validationRaceQueue!.id)
        .map((queueId) => releasePreclaimGate("validate-remediation", queueId)),
    );
    const { data: dispatchedRows, error: dispatchedReadError } = await input.client
      .from("remediation_validation_queue")
      .select("id,remediation_proposal_id,status,attempt_count")
      .in("id", validationQueueIds)
      .eq("workspace_id", input.workspaceId);
    if (dispatchedReadError) throw new Error("m15_business_validation_dispatch_read_failed");
    validationQueues = dispatchedRows ?? [];
    const dispatchedRaceQueue = validationQueues.find((row) => row.id === validationRaceQueue!.id);
    if (dispatchedRaceQueue?.status !== "dispatched") {
      throw new Error("m15_validation_claim_race_queue_not_dispatched");
    }
    try {
      validationClaimRace = await proveValidationClaimRace({
        workspaceId: input.workspaceId,
        queueId: validationRaceQueue.id,
        attempt: dispatchedRaceQueue.attempt_count,
      });
      claimRaceResults.validation = validationClaimRace;
    } catch (error) {
      claimRaceFailures.push(safeAcceptanceErrorCode(error));
    }
    await releasePreclaimGate("validate-remediation", validationRaceQueue.id);
    await triggerLocalDispatcher("validation");
    const validationCompletionDeadline = Date.now() + 180_000;
    let nextValidationRetryAt = Date.now() + 45_000;
    while (Date.now() < validationCompletionDeadline) {
      if (Date.now() >= nextValidationRetryAt) {
        await triggerLocalDispatcher("validation");
        nextValidationRetryAt = Date.now() + 45_000;
      }
      const { data, error } = await input.client
        .from("remediation_validation_queue")
        .select("id,remediation_proposal_id,status,attempt_count")
        .in("id", validationQueueIds)
        .eq("workspace_id", input.workspaceId);
      if (error) throw new Error("m15_business_validation_read_failed");
      validationQueues = data ?? [];
      if (
        proposalIds.every((id) =>
          validationQueues.some(
            (row) => row.remediation_proposal_id === id && row.status === "validated",
          ),
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    await rm(validationHoldAll, { force: true });
    await Promise.all(
      workspaceValidationQueueIds.map((queueId) =>
        releasePreclaimGate("validate-remediation", queueId).catch(() => undefined),
      ),
    );
    await removePreclaimGateArtifacts("validate-remediation", workspaceValidationQueueIds);
  }
  if (!validationClaimRace && !claimRaceFailures.length) {
    claimRaceFailures.push("validation_claim_race_missing");
  }
  if (
    !proposalIds.every((id) =>
      validationQueues.some(
        (row) => row.remediation_proposal_id === id && row.status === "validated",
      ),
    )
  ) {
    throw new Error("m15_business_validation_worker_timeout");
  }
  const scenarios = preflights.map((run) => {
    const row = remediationQueues.find((candidate) => candidate.preflight_run_id === run.id);
    if (!row?.remediation_proposal_id) throw new Error("m15_business_proposal_identity_missing");
    return {
      preflightRunId: run.id,
      proposalId: row.remediation_proposal_id,
      repositoryId: input.repositoryId,
    };
  });
  const raceResults = [
    claimRaceResults.preflight,
    claimRaceResults.remediation,
    claimRaceResults.validation,
  ].filter((result): result is IndependentRaceResult => Boolean(result));
  const allBackends = raceResults.flatMap((result) =>
    result.contenders.map((contender) => contender.backendPid),
  );
  const winnerCount = (result: IndependentRaceResult) =>
    result.contenders.reduce((total, contender) => total + contender.nonNullRows, 0);
  const raceProofPassed =
    raceResults.length === 3 &&
    raceResults.every(
      (result) =>
        result.bothBlockedOnHolder &&
        result.contenders.every((contender) => contender.completed && contender.resultRows === 1) &&
        winnerCount(result) === 1,
    );
  if (raceProofPassed) {
    await appendTopologyCheckpoint(input.intentPath, "postgres_concurrency_persisted", {
      independentClaimSessionRaces: 3,
      independentBackendSessions: new Set(allBackends).size === allBackends.length,
      preflightClaimWinnerCount: winnerCount(claimRaceResults.preflight!),
      remediationClaimWinnerCount: winnerCount(claimRaceResults.remediation!),
      validationClaimWinnerCount: winnerCount(claimRaceResults.validation!),
      preflightClaimBarrierObserved: claimRaceResults.preflight!.bothBlockedOnHolder,
      remediationClaimBarrierObserved: claimRaceResults.remediation!.bothBlockedOnHolder,
      validationClaimBarrierObserved: claimRaceResults.validation!.bothBlockedOnHolder,
      claimTokensPersistedOnlyServerSide: true,
      noDeadlockOrLockTimeout: true,
    });
  } else {
    await appendTopologyCheckpoint(input.intentPath, "postgres_claim_concurrency_failed", {
      completedClaimRaces: raceResults.length,
      independentBackendSessions:
        allBackends.length > 0 && new Set(allBackends).size === allBackends.length,
      failureCodes: claimRaceFailures.length ? claimRaceFailures : ["claim_race_assertion_failed"],
      outcomes: JSON.stringify(
        raceResults.map((result) => ({
          barrierObserved: result.bothBlockedOnHolder,
          sameResult: result.sameResult,
          contenders: result.contenders.map((contender) => ({
            backendPid: contender.backendPid,
            completed: contender.completed,
            resultRows: contender.resultRows,
            nonNullRows: contender.nonNullRows,
          })),
        })),
      ),
    });
  }
  return { scenarios, claimRaceResults, claimRaceFailures };
}

function safeAcceptanceErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown";
  return /^[a-z0-9_:]{1,160}$/.test(message) ? message : "unknown";
}

async function appendTopologyCheckpoint(
  intentPath: string,
  name:
    | "preflight_persisted"
    | "remediation_persisted"
    | "validation_persisted"
    | "resolution_persisted"
    | "history_persisted"
    | "duplicate_delivery_idempotency_persisted"
    | "retry_crash_recovery_persisted"
    | "transient_retry_persisted"
    | "execution_authorization_persisted"
    | "business_policy_persisted"
    | "business_validation_gate_timeout"
    | "postgres_core_concurrency_persisted"
    | "postgres_concurrency_persisted"
    | "postgres_claim_concurrency_failed"
    | "economic_scoping_persisted"
    | "tenant_isolation_persisted"
    | "tenant_isolation_failed",
  proof: Record<string, string | number | boolean | string[]>,
) {
  await appendFile(
    intentPath,
    `${JSON.stringify({ status: `stage_${name}`, observedAt: new Date().toISOString(), ...proof })}\n`,
    { mode: 0o600 },
  );
}

async function proveRealPreflightTriggerTopology(input: {
  client: LocalSupabaseClient;
  workspaceClient: LocalSupabaseClient;
  unrelatedTenantClient: LocalSupabaseClient;
  anonymousClient: LocalSupabaseClient;
  workspaceId: string;
  ownerUserId: string;
  productId: string;
  tenantBWorkspaceId: string;
  queueId: string;
  impactAssessmentId: string;
  productIdempotencyRace: IndependentRaceResult;
  tenantBImpactAssessmentId: string;
  sourceChangeId: string;
  repositoryId: string;
  nonce: string;
}): Promise<{ scenario: BusinessHandoffScenario; intentPath: string }> {
  const duplicateTargets = [await markDuplicateDeliveryTarget(input.queueId)];
  const intentPath = path.join(
    process.cwd(),
    "node_modules",
    ".cache",
    "m15-local",
    `preflight-topology-${input.nonce}.jsonl`,
  );
  const intent = await open(intentPath, "wx", 0o600);
  try {
    await intent.writeFile(
      `${JSON.stringify({
        status: "prepared",
        dispatcherTaskId: "dispatch-preflight-queue",
        childTaskId: "run-preflight",
        queueId: input.queueId,
        impactAssessmentId: input.impactAssessmentId,
        preparedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    await intent.sync();
  } finally {
    await intent.close();
  }

  await appendFile(
    intentPath,
    `${JSON.stringify({ status: "awaiting_registered_development_schedule", observedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  const deadline = Date.now() + 360_000;
  let queueRow: { status: string; attempt_count: number; trigger_run_id: string | null } | null =
    null;
  const queueTransitions: Array<{ status: string; observedAt: string }> = [];
  let lastQueueStatus = "";
  while (Date.now() < deadline) {
    const { data, error } = await input.client
      .from("preflight_dispatch_queue")
      .select("status,attempt_count,trigger_run_id")
      .eq("id", input.queueId)
      .single();
    if (error || !data) throw new Error("m15_real_preflight_queue_poll_failed");
    queueRow = data;
    if (queueRow.status !== lastQueueStatus) {
      queueTransitions.push({ status: queueRow.status, observedAt: new Date().toISOString() });
      lastQueueStatus = queueRow.status;
    }
    if (queueRow.status === "complete" && queueRow.trigger_run_id) break;
    if (["failed", "superseded"].includes(queueRow.status)) {
      throw new Error("m15_real_preflight_queue_terminal_without_child");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!queueRow?.trigger_run_id || queueRow.status !== "complete") {
    throw new Error("m15_real_preflight_scheduled_dispatch_timeout");
  }
  await appendFile(
    intentPath,
    `${JSON.stringify({ status: "child_dispatched", childRunId: queueRow.trigger_run_id, queueStatus: queueRow.status, attempt: queueRow.attempt_count, observedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  const { data: persistedRuns, error: persistedError } = await input.client
    .from("preflight_runs")
    .select("id,status,verified_impact,created_at")
    .eq("impact_assessment_id", input.impactAssessmentId);
  if (persistedError || persistedRuns?.length !== 1) {
    throw new Error("m15_real_preflight_result_missing");
  }
  const result = persistedRuns[0];
  if (result?.status !== "completed" || result.verified_impact !== "verified") {
    throw new Error("m15_real_preflight_result_not_verified");
  }
  await appendTopologyCheckpoint(intentPath, "preflight_persisted", {
    queueId: input.queueId,
    queueStatus: queueRow.status,
    childRunId: queueRow.trigger_run_id,
    preflightRunId: result.id,
    preflightStatus: result.status,
    verifiedImpact: result.verified_impact,
  });

  // A scheduled dispatcher runs every two minutes with a two-minute execution window.
  // Allow one complete interval plus bounded worker completion time at the edge of that window.
  const remediationQueueDeadline = Date.now() + 360_000;
  let remediationQueue: {
    id: string;
    status: string;
    attempt_count: number;
    trigger_run_id: string | null;
    remediation_proposal_id: string | null;
  } | null = null;
  const remediationTransitions: Array<{ status: string; observedAt: string }> = [];
  let lastRemediationStatus = "";
  while (Date.now() < remediationQueueDeadline) {
    const { data, error } = await input.client
      .from("remediation_preparation_queue")
      .select("id,status,attempt_count,trigger_run_id,remediation_proposal_id")
      .eq("preflight_run_id", result.id)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();
    if (error) throw new Error("m15_real_remediation_queue_read_failed");
    remediationQueue = data;
    if (remediationQueue && remediationQueue.status !== lastRemediationStatus) {
      remediationTransitions.push({
        status: remediationQueue.status,
        observedAt: new Date().toISOString(),
      });
      lastRemediationStatus = remediationQueue.status;
      await appendFile(
        intentPath,
        `${JSON.stringify({ status: "remediation_queue_transition", queueStatus: remediationQueue.status, attempt: remediationQueue.attempt_count, hasChildRun: Boolean(remediationQueue.trigger_run_id), observedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
    }
    if (
      remediationQueue &&
      !duplicateTargets.some((marker) => marker.endsWith(remediationQueue!.id))
    ) {
      duplicateTargets.push(await markDuplicateDeliveryTarget(remediationQueue.id));
    }
    if (
      remediationQueue?.status === "completed" &&
      remediationQueue.trigger_run_id &&
      remediationQueue.remediation_proposal_id
    ) {
      break;
    }
    if (["denied", "failed"].includes(remediationQueue?.status ?? "")) {
      throw new Error("m15_real_remediation_child_terminal_failure");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (
    !remediationQueue ||
    remediationQueue.status !== "completed" ||
    !remediationQueue.trigger_run_id ||
    !remediationQueue.remediation_proposal_id
  ) {
    throw new Error("m15_real_remediation_schedule_timeout");
  }
  const { data: proposal, error: proposalError } = await input.client
    .from("remediation_proposals")
    .select("id,proposal_kind,patch,patch_fingerprint,patch_validation_status,created_at")
    .eq("id", remediationQueue.remediation_proposal_id)
    .eq("workspace_id", input.workspaceId)
    .single();
  if (
    proposalError ||
    proposal?.proposal_kind !== "patch" ||
    !proposal.patch ||
    !/^[a-f0-9]{64}$/.test(proposal.patch_fingerprint ?? "") ||
    !proposal.patch.includes("src/client.ts") ||
    !proposal.patch.includes("legacyClient.send()") ||
    !proposal.patch.includes("modernClient.send()")
  ) {
    throw new Error("m15_real_remediation_patch_persistence_missing");
  }
  await appendTopologyCheckpoint(intentPath, "remediation_persisted", {
    queueId: remediationQueue.id,
    queueStatus: remediationQueue.status,
    childRunId: remediationQueue.trigger_run_id,
    proposalId: proposal.id,
    proposalKind: proposal.proposal_kind,
    patchFingerprint: proposal.patch_fingerprint,
    patchGrounded: true,
  });

  const validationDeadline = Date.now() + 300_000;
  let validationQueue: {
    id: string;
    status: string;
    attempt_count: number;
    trigger_run_id: string | null;
  } | null = null;
  const validationTransitions: Array<{ status: string; observedAt: string }> = [];
  let lastValidationStatus = "";
  while (Date.now() < validationDeadline) {
    const { data, error } = await input.client
      .from("remediation_validation_queue")
      .select("id,status,attempt_count,trigger_run_id")
      .eq("remediation_proposal_id", proposal.id)
      .eq("patch_fingerprint", proposal.patch_fingerprint)
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();
    if (error) throw new Error("m15_real_validation_queue_read_failed");
    validationQueue = data;
    if (
      validationQueue &&
      !duplicateTargets.some((marker) => marker.endsWith(validationQueue!.id))
    ) {
      duplicateTargets.push(await markDuplicateDeliveryTarget(validationQueue.id));
    }
    if (validationQueue && validationQueue.status !== lastValidationStatus) {
      validationTransitions.push({
        status: validationQueue.status,
        observedAt: new Date().toISOString(),
      });
      lastValidationStatus = validationQueue.status;
    }
    if (validationQueue?.status === "validated" && validationQueue.trigger_run_id) {
      break;
    }
    if (["validation_failed", "denied", "canceled"].includes(validationQueue?.status ?? "")) {
      throw new Error("m15_real_validation_child_terminal_failure");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (
    !validationQueue ||
    validationQueue.status !== "validated" ||
    !validationQueue.trigger_run_id
  ) {
    throw new Error("m15_real_validation_schedule_timeout");
  }
  const { data: validationAttempt, error: validationAttemptError } = await input.client
    .from("remediation_validation_attempts")
    .select("id,outcome,duration_ms,completed_at")
    .eq("queue_id", validationQueue.id)
    .order("attempt_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (validationAttemptError || validationAttempt?.outcome !== "validated") {
    throw new Error("m15_real_validation_result_persistence_missing");
  }
  const { data: validatedProposal, error: validatedProposalError } = await input.client
    .from("remediation_proposals")
    .select("patch_validation_status")
    .eq("id", proposal.id)
    .eq("workspace_id", input.workspaceId)
    .single();
  if (validatedProposalError || validatedProposal?.patch_validation_status !== "validated") {
    throw new Error("m15_real_validation_proposal_status_missing");
  }
  await appendTopologyCheckpoint(intentPath, "validation_persisted", {
    queueId: validationQueue.id,
    queueStatus: validationQueue.status,
    childRunId: validationQueue.trigger_run_id,
    validationOutcome: validationAttempt.outcome,
    validationDurationMs: validationAttempt.duration_ms,
    proposalStatus: validatedProposal.patch_validation_status,
  });

  const coreConcurrency = await provePersistedCoreConcurrency({
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    unresolvedImpactAssessmentId: input.impactAssessmentId,
    productIdempotencyResult: input.productIdempotencyRace,
  });
  await appendTopologyCheckpoint(intentPath, "postgres_core_concurrency_persisted", {
    independentSessionRaces: 2,
    productIdempotencyRacePassed:
      coreConcurrency.productIdempotency.bothBlockedOnHolder &&
      coreConcurrency.productIdempotency.sameResult,
    resolutionRacePassed:
      coreConcurrency.riskResolution.bothBlockedOnHolder &&
      coreConcurrency.riskResolution.sameResult,
  });

  const resolution = await input.workspaceClient.rpc("resolve_customer_risk", {
    p_workspace_id: input.workspaceId,
    p_impact_assessment_id: input.impactAssessmentId,
    p_resolution_kind: "reviewed",
  });
  if (resolution.error || !(resolution.data as { id?: string } | null)?.id) {
    throw new Error("m15_real_risk_resolution_failed");
  }
  const firstResolutionId = (resolution.data as { id: string }).id;
  const replayedResolution = await input.workspaceClient.rpc("resolve_customer_risk", {
    p_workspace_id: input.workspaceId,
    p_impact_assessment_id: input.impactAssessmentId,
    p_resolution_kind: "reviewed",
  });
  if ((replayedResolution.data as { id?: string } | null)?.id !== firstResolutionId) {
    throw new Error("m15_real_risk_resolution_replay_mismatch");
  }
  await appendTopologyCheckpoint(intentPath, "resolution_persisted", {
    resolutionId: firstResolutionId,
    idempotentReplayReturnedSame: true,
  });
  const { data: history, error: historyError } = await input.client
    .from("protection_value_events")
    .select("id,event_kind,occurred_at,metadata")
    .eq("workspace_id", input.workspaceId)
    .eq("impact_assessment_id", input.impactAssessmentId)
    .order("occurred_at", { ascending: true });
  const requiredHistory = [
    "automatic_preflight_started",
    "preflight_completed",
    "verified_risk_found",
    "remediation_generated",
    "remediation_validated",
    "risk_resolved",
  ];
  const actualHistory = new Set(
    (history ?? []).map((event: { event_kind: string }) => event.event_kind),
  );
  if (historyError || requiredHistory.some((eventKind) => !actualHistory.has(eventKind))) {
    throw new Error("m15_real_protection_history_incomplete");
  }
  await appendTopologyCheckpoint(intentPath, "history_persisted", {
    historyKinds: [...actualHistory],
    requiredHistoryComplete: true,
  });

  const [
    globalChangeRows,
    tenantBPreflightQueue,
    tenantBPreflightRuns,
    tenantBRemediationQueue,
    tenantBValidationQueue,
  ] = await Promise.all([
    input.client.from("source_changes").select("id").eq("id", input.sourceChangeId),
    input.client
      .from("preflight_dispatch_queue")
      .select("id")
      .eq("impact_assessment_id", input.tenantBImpactAssessmentId),
    input.client
      .from("preflight_runs")
      .select("id")
      .eq("impact_assessment_id", input.tenantBImpactAssessmentId),
    input.client
      .from("remediation_preparation_queue")
      .select("id")
      .eq("workspace_id", input.tenantBWorkspaceId),
    input.client
      .from("remediation_validation_queue")
      .select("id")
      .eq("workspace_id", input.tenantBWorkspaceId),
  ]);
  if (
    globalChangeRows.error ||
    globalChangeRows.data?.length !== 1 ||
    tenantBPreflightQueue.error ||
    tenantBPreflightQueue.data?.length !== 0 ||
    tenantBPreflightRuns.error ||
    tenantBPreflightRuns.data?.length !== 0 ||
    tenantBRemediationQueue.error ||
    tenantBRemediationQueue.data?.length !== 0 ||
    tenantBValidationQueue.error ||
    tenantBValidationQueue.data?.length !== 0
  ) {
    throw new Error("m15_real_economic_scoping_failed");
  }
  await appendTopologyCheckpoint(intentPath, "economic_scoping_persisted", {
    singleGlobalChange: true,
    sharedDependency: true,
    tenantARelevant: true,
    tenantBRelevant: false,
    tenantAPreflightCompleted: true,
    tenantBPreflightQueueRows: tenantBPreflightQueue.data.length,
    tenantBPreflightRows: tenantBPreflightRuns.data.length,
    tenantBRemediationRows: tenantBRemediationQueue.data.length,
    tenantBValidationRows: tenantBValidationQueue.data.length,
  });
  const protectedRows: Array<{ table: string; id: string; key?: string }> = [
    { table: "impact_assessments", id: input.impactAssessmentId },
    { table: "preflight_dispatch_queue", id: input.queueId },
    { table: "preflight_runs", id: result.id },
    { table: "remediation_preparation_queue", id: remediationQueue.id },
    { table: "remediation_proposals", id: proposal.id },
    { table: "remediation_validation_queue", id: validationQueue.id },
    { table: "remediation_validation_attempts", id: validationAttempt.id },
    { table: "customer_risk_resolutions", id: firstResolutionId },
    { table: "product_remediation_policies", id: input.productId, key: "product_id" },
    ...history.map((event: { id: string }) => ({
      table: "protection_value_events",
      id: event.id,
    })),
  ];
  const tenantIsolationFailures: string[] = [];
  for (const row of protectedRows) {
    const [foreignRead, anonymousRowRead] = await Promise.all([
      input.unrelatedTenantClient
        .from(row.table)
        .select(row.key ?? "id")
        .eq(row.key ?? "id", row.id),
      input.anonymousClient
        .from(row.table)
        .select(row.key ?? "id")
        .eq(row.key ?? "id", row.id),
    ]);
    const foreignDeniedOrEmpty =
      foreignRead.error?.code === "42501" ||
      (!foreignRead.error && (foreignRead.data?.length ?? 0) === 0);
    const anonymousDeniedOrEmpty =
      anonymousRowRead.error?.code === "42501" ||
      (!anonymousRowRead.error && (anonymousRowRead.data?.length ?? 0) === 0);
    if (!foreignDeniedOrEmpty || !anonymousDeniedOrEmpty) {
      tenantIsolationFailures.push(
        `${row.table}:foreign_${foreignRead.error?.code ?? `rows_${foreignRead.data?.length ?? "unknown"}`}:anonymous_${anonymousRowRead.error?.code ?? `rows_${anonymousRowRead.data?.length ?? "unknown"}`}`,
      );
    }
  }
  const protectedUpdates = [
    { table: "impact_assessments", id: input.impactAssessmentId, column: "updated_at" },
    { table: "preflight_dispatch_queue", id: input.queueId, column: "updated_at" },
    { table: "preflight_runs", id: result.id, column: "updated_at" },
    { table: "remediation_preparation_queue", id: remediationQueue.id, column: "updated_at" },
    { table: "remediation_proposals", id: proposal.id, column: "updated_at" },
    { table: "remediation_validation_queue", id: validationQueue.id, column: "updated_at" },
    { table: "remediation_validation_attempts", id: validationAttempt.id, column: "completed_at" },
    { table: "protection_value_events", id: history[0]!.id, column: "occurred_at" },
    { table: "customer_risk_resolutions", id: firstResolutionId, column: "resolved_at" },
    {
      table: "product_remediation_policies",
      id: input.productId,
      column: "updated_at",
      key: "product_id",
    },
  ];
  for (const row of protectedUpdates) {
    const snapshot = await input.client
      .from(row.table)
      .select(row.column)
      .eq(row.key ?? "id", row.id)
      .single();
    if (snapshot.error || !snapshot.data) {
      throw new Error("m15_real_tenant_mutation_snapshot_missing");
    }
    const value = (snapshot.data as unknown as Record<string, unknown>)[row.column];
    const mutation = await input.unrelatedTenantClient
      .from(row.table)
      .update({ [row.column]: value })
      .eq(row.key ?? "id", row.id)
      .select(row.key ?? "id");
    if (
      (mutation.error && mutation.error.code !== "42501") ||
      (!mutation.error && (mutation.data?.length ?? 0) !== 0)
    ) {
      throw new Error("m15_real_populated_tenant_mutation_isolation_failed");
    }
  }
  await appendTopologyCheckpoint(
    intentPath,
    tenantIsolationFailures.length ? "tenant_isolation_failed" : "tenant_isolation_persisted",
    {
      protectedReadRows: protectedRows.length,
      protectedMutationRows: protectedUpdates.length,
      unrelatedTenantDenied: true,
      anonymousDenied: tenantIsolationFailures.length === 0,
      failureCount: tenantIsolationFailures.length,
      failures: tenantIsolationFailures,
    },
  );

  const proposalRowsBeforeDuplicate = await input.client
    .from("remediation_proposals")
    .select("id")
    .eq("preflight_run_id", result.id);
  const validationAttemptsBeforeDuplicate = await input.client
    .from("remediation_validation_attempts")
    .select("id")
    .eq("queue_id", validationQueue.id);
  const existingPreflightRows = await input.client
    .from("preflight_runs")
    .select("id")
    .eq("impact_assessment_id", input.impactAssessmentId);
  const existingRemediationRows = await input.client
    .from("remediation_preparation_queue")
    .select("id")
    .eq("preflight_run_id", result.id);
  if (
    proposalRowsBeforeDuplicate.error ||
    validationAttemptsBeforeDuplicate.error ||
    existingPreflightRows.error ||
    existingRemediationRows.error
  ) {
    throw new Error("m15_real_duplicate_baseline_read_failed");
  }

  const [preflightOutcomes, remediationOutcomes, validationOutcomes] = await Promise.all([
    waitForLocalTaskOutcomes("run-preflight", input.queueId, ["completed", "complete"]),
    waitForLocalTaskOutcomes("prepare-remediation", remediationQueue.id, [
      ["completed", "persisted_before_retry"],
      "replayed",
    ]),
    waitForLocalTaskOutcomes("validate-remediation", validationQueue.id, [
      ["validated", "persisted_before_retry"],
      "replayed",
    ]),
  ]);
  const preflightRunIds = preflightOutcomes.map((outcome) => outcome.runId);
  const remediationRunIds = remediationOutcomes.map((outcome) => outcome.runId);
  const validationRunIds = validationOutcomes.map((outcome) => outcome.runId);
  if (
    new Set(preflightRunIds).size !== 2 ||
    new Set(remediationRunIds).size !== 2 ||
    new Set(validationRunIds).size !== 2
  ) {
    throw new Error("m15_duplicate_delivery_run_identity_not_distinct");
  }
  const [
    preflightRowsAfterDuplicate,
    remediationRowsAfterDuplicate,
    proposalRowsAfterDuplicate,
    validationQueuesAfterDuplicate,
    validationAttemptsAfterDuplicate,
  ] = await Promise.all([
    input.client
      .from("preflight_runs")
      .select("id")
      .eq("impact_assessment_id", input.impactAssessmentId),
    input.client
      .from("remediation_preparation_queue")
      .select("id")
      .eq("preflight_run_id", result.id),
    input.client.from("remediation_proposals").select("id").eq("preflight_run_id", result.id),
    input.client
      .from("remediation_validation_queue")
      .select("id")
      .eq("remediation_proposal_id", proposal.id),
    input.client
      .from("remediation_validation_attempts")
      .select("id")
      .eq("queue_id", validationQueue.id),
  ]);
  if (
    preflightRowsAfterDuplicate.error ||
    remediationRowsAfterDuplicate.error ||
    proposalRowsAfterDuplicate.error ||
    validationQueuesAfterDuplicate.error ||
    validationAttemptsAfterDuplicate.error ||
    preflightRowsAfterDuplicate.data?.length !== 1 ||
    remediationRowsAfterDuplicate.data?.length !== 1 ||
    proposalRowsAfterDuplicate.data?.length !== 1 ||
    validationQueuesAfterDuplicate.data?.length !== 1 ||
    validationAttemptsAfterDuplicate.data?.length !== 1 ||
    proposalRowsAfterDuplicate.data?.length !== proposalRowsBeforeDuplicate.data?.length ||
    validationAttemptsAfterDuplicate.data?.length !== validationAttemptsBeforeDuplicate.data?.length
  ) {
    throw new Error("m15_duplicate_trigger_delivery_duplicated_logical_work");
  }

  const allTaskOutcomes: LocalTaskOutcome[] = (await readFile(localTaskOutcomesPath, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as LocalTaskOutcome];
      } catch {
        return [];
      }
    });
  const hasPostCommitRetry = (taskId: string, queueId: string) => {
    const rows = allTaskOutcomes.filter((row) => row.taskId === taskId && row.queueId === queueId);
    return rows.some(
      (first) =>
        first.outcome === "persisted_before_retry" &&
        first.triggerAttempt === 1 &&
        rows.some(
          (retry) =>
            retry.runId === first.runId &&
            retry.triggerAttempt === 2 &&
            retry.outcome === "replayed",
        ),
    );
  };
  const preparationRecovered = hasPostCommitRetry("prepare-remediation", remediationQueue.id);
  const validationRecovered = hasPostCommitRetry("validate-remediation", validationQueue.id);
  const resolutionRecovered =
    firstResolutionId === (replayedResolution.data as { id?: string } | null)?.id;
  if (!preparationRecovered || !validationRecovered || !resolutionRecovered) {
    throw new Error("m15_post_commit_retry_recovery_not_proven");
  }
  await appendTopologyCheckpoint(intentPath, "retry_crash_recovery_persisted", {
    proposalPatchRetryRecovered: preparationRecovered,
    validationRetryRecovered: validationRecovered,
    resolutionReplayRecovered: resolutionRecovered,
    triggerPreparationAttemptTwo: true,
    triggerValidationAttemptTwo: true,
    canonicalProposalCount: proposalRowsAfterDuplicate.data.length,
    canonicalValidationAttemptCount: validationAttemptsAfterDuplicate.data.length,
  });
  const duplicateDeliveryProof = {
    preflight: {
      taskId: "run-preflight",
      runIds: preflightRunIds,
      outcomes: preflightOutcomes.map((row) => row.outcome),
      canonicalResults: preflightRowsAfterDuplicate.data.length,
    },
    remediation: {
      taskId: "prepare-remediation",
      runIds: remediationRunIds,
      outcomes: remediationOutcomes.map((row) => row.outcome),
      canonicalProposals: proposalRowsAfterDuplicate.data.length,
    },
    validation: {
      taskId: "validate-remediation",
      runIds: validationRunIds,
      outcomes: validationOutcomes.map((row) => row.outcome),
      canonicalAttempts: validationAttemptsAfterDuplicate.data.length,
    },
    noDuplicateLogicalWork: true,
  };
  await appendTopologyCheckpoint(intentPath, "duplicate_delivery_idempotency_persisted", {
    preflightRunIds,
    remediationRunIds,
    validationRunIds,
    eachDeliveryExecutedByWorker: true,
    preflightResultCount: preflightRowsAfterDuplicate.data.length,
    remediationQueueCount: remediationRowsAfterDuplicate.data.length,
    proposalCount: proposalRowsAfterDuplicate.data.length,
    validationQueueCount: validationQueuesAfterDuplicate.data.length,
    validationAttemptCount: validationAttemptsAfterDuplicate.data.length,
    noDuplicateLogicalWork: true,
  });
  await Promise.all(duplicateTargets.map((marker) => rm(marker, { force: true })));

  await appendFile(
    intentPath,
    `${JSON.stringify({
      status: "money_path_complete",
      preflightRunId: result.id,
      preflightChildRunId: queueRow.trigger_run_id,
      remediationQueueId: remediationQueue.id,
      remediationChildRunId: remediationQueue.trigger_run_id,
      proposalId: proposal.id,
      validationQueueId: validationQueue.id,
      validationChildRunId: validationQueue.trigger_run_id,
      validationDurationMs: validationAttempt.duration_ms,
      preflightStatus: result.status,
      verifiedImpact: result.verified_impact,
      remediationQueueStatus: remediationQueue.status,
      proposalKind: proposal.proposal_kind,
      patchFingerprint: proposal.patch_fingerprint,
      proposalValidationStatus: validatedProposal.patch_validation_status,
      validationOutcome: validationAttempt.outcome,
      resolutionId: firstResolutionId,
      resolutionReplayReturnedSame: true,
      duplicateDeliveryProof,
      protectionHistory: [...actualHistory],
      populatedTenantIsolation: tenantIsolationFailures.length === 0,
      anonymousIsolation: tenantIsolationFailures.length === 0,
      economicScoping: {
        singleGlobalChange: true,
        sharedDependency: true,
        tenantARelevant: true,
        tenantBRelevant: false,
        tenantAPreflightCompleted: true,
        tenantBPreflightQueueRows: tenantBPreflightQueue.data.length,
        tenantBPreflightRows: tenantBPreflightRuns.data.length,
        tenantBRemediationRows: tenantBRemediationQueue.data.length,
        tenantBValidationRows: tenantBValidationQueue.data.length,
      },
      completedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );

  process.stdout.write(
    `M15_REAL_PREFLIGHT_TOPOLOGY=${JSON.stringify({
      dispatcherTaskId: "dispatch-preflight-queue",
      dispatcherInvocation: "registered_development_schedule",
      childTaskId: "run-preflight",
      childRunId: queueRow.trigger_run_id,
      queueTransitions,
      queueId: input.queueId,
      queueStatus: "complete",
      preflightRunId: result.id,
      preflightStatus: result.status,
      verifiedImpact: result.verified_impact,
      remediation: {
        dispatcherTaskId: "dispatch-remediation-preparation",
        childTaskId: "prepare-remediation",
        childRunId: remediationQueue.trigger_run_id,
        queueId: remediationQueue.id,
        queueTransitions: remediationTransitions,
        proposalId: proposal.id,
        proposalKind: proposal.proposal_kind,
        patchFingerprint: proposal.patch_fingerprint,
        patchValidationStatus: proposal.patch_validation_status,
      },
      validation: {
        dispatcherTaskId: "dispatch-remediation-validation",
        childTaskId: "validate-remediation",
        childRunId: validationQueue.trigger_run_id,
        queueId: validationQueue.id,
        queueTransitions: validationTransitions,
        outcome: validationAttempt.outcome,
        durationMs: validationAttempt.duration_ms,
        proposalStatus: validatedProposal.patch_validation_status,
      },
      resolution: { id: firstResolutionId, replayReturnedSame: true },
      duplicateDeliveryProof,
      protectionHistory: [...actualHistory],
      populatedTenantIsolation: tenantIsolationFailures.length === 0,
      anonymousIsolation: tenantIsolationFailures.length === 0,
      economicScoping: {
        singleGlobalChange: true,
        sharedDependency: true,
        tenantARelevant: true,
        tenantBRelevant: false,
        tenantAPreflightCompleted: true,
        tenantBPreflightQueueRows: tenantBPreflightQueue.data.length,
        tenantBPreflightRows: tenantBPreflightRuns.data.length,
        tenantBRemediationRows: tenantBRemediationQueue.data.length,
        tenantBValidationRows: tenantBValidationQueue.data.length,
      },
      attemptIntentPath: intentPath,
    })}\n`,
  );

  if (tenantIsolationFailures.length) {
    throw new Error(
      `m15_real_populated_tenant_read_isolation_failed:${tenantIsolationFailures.join(";")}`,
    );
  }
  return {
    scenario: {
      proposalId: proposal.id,
      preflightRunId: result.id,
      repositoryId: input.repositoryId,
    },
    intentPath,
  };
}

function localConfiguration() {
  const workdir = "node_modules/.cache/m15-local";
  const command = process.platform === "win32" ? "supabase.exe" : "supabase";
  const status = spawnSync(command, ["status", "--workdir", workdir, "--output", "env"], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024,
  });
  if (status.error || status.status !== 0) throw new Error("local_supabase_status_unavailable");
  const values = new Map<string, string>();
  for (const line of (status.stdout ?? "").split(/\r?\n/)) {
    const equals = line.indexOf("=");
    if (equals < 1) continue;
    values.set(
      line.slice(0, equals).trim(),
      line
        .slice(equals + 1)
        .trim()
        .replace(/^['"]|['"]$/g, ""),
    );
  }
  const url = values.get("API_URL");
  const publishableKey = values.get("PUBLISHABLE_KEY") ?? values.get("ANON_KEY");
  const serviceKey = values.get("SERVICE_ROLE_KEY") ?? values.get("SECRET_KEY");
  if (!url || !publishableKey || !serviceKey)
    throw new Error("local_supabase_configuration_unavailable");
  if (
    !new Set(["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"]).has(
      new URL(url).origin,
    )
  ) {
    throw new Error("local_supabase_loopback_required");
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  process.env.SUPABASE_SECRET_KEY = serviceKey;
  process.env.AUTERIM_M15_LOCAL_SUPABASE_URL = url;
  process.env.AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY = serviceKey;
  return { url, publishableKey, serviceKey };
}

function semanticClassifier(material: boolean): SemanticClassifier {
  return {
    providerId: "openai",
    modelId: "m15/local-deterministic",
    async classify() {
      return {
        inputTokens: 0,
        outputTokens: 0,
        classification: {
          material,
          category: material ? "api_change" : "documentation",
          affectedEntities: material ? ["fixture-client"] : [],
          severityHint: material ? "high" : "informational",
          confidence: 0.99,
          summary: material
            ? "A fixture API method was replaced."
            : "Fixture documentation was clarified.",
          evidence: material ? [{ type: "changed", excerpt: "modernClient.send() is used" }] : [],
          reasoningSummary: "Deterministic local acceptance fixture.",
        },
      };
    },
  };
}

const impactClassifier: CustomerImpactClassifier = {
  providerId: "openai",
  modelId: "m15/local-deterministic",
  async classify(packet) {
    const relevant = /uses fixture-client in the customer-facing product/i.test(
      packet.context.contextNote,
    );
    return {
      inputTokens: 0,
      outputTokens: 0,
      result: {
        relevant,
        relevance: relevant ? "high" : "none",
        severity: relevant ? "medium" : "informational",
        affectedAreas: relevant ? ["customer-facing product"] : [],
        impactSummary: relevant
          ? "The protected product uses the affected dependency."
          : "The recorded context does not use the affected client in production.",
        whyItMatters: relevant
          ? "The persisted dependency context confirms usage."
          : "The persisted dependency context describes offline documentation use only.",
        actionRequired: relevant,
        recommendedAction: relevant ? "Review the verified replacement." : null,
        confidence: 0.99,
        missingContext: relevant ? [] : ["Whether any production use exists remains unknown."],
        evidenceRefs: [
          { source: "global_evidence", excerpt: packet.globalChange.evidence[0]!.excerpt },
          { source: "dependency_context", excerpt: packet.context.contextNote },
        ],
      },
    };
  },
};

describe("M15 real local persisted change-to-impact path", () => {
  it.skipIf(!enabled)(
    "persists one shared material change, scopes impact to A, and excludes a non-material control",
    async () => {
      const local = localConfiguration();
      const nonce = randomUUID();
      const admin = createClient(local.url, local.serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const anon = createClient(local.url, local.publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const anonymousReader = createClient(local.url, local.publishableKey, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      });
      const users: string[] = [];
      const sources: string[] = [];
      const workspaces: string[] = [];
      const cleanupFailures: string[] = [];
      const additionalBusinessImpactIds: string[] = [];
      let primaryBusinessScenario: BusinessHandoffScenario | null = null;
      let topologyIntentPath: string | null = null;
      let productIdempotencyRace: IndependentRaceResult | null = null;
      let primaryFailure: unknown;

      try {
        const tenants = await Promise.all(
          ["a", "b"].map(async (suffix) => {
            const email = `m15-pipeline-${suffix}-${nonce}@auterim.invalid`;
            const password = `Local-${randomUUID()}-Aa1!`;
            const created = await admin.auth.admin.createUser({
              email,
              password,
              email_confirm: true,
            });
            if (created.error || !created.data.user) throw new Error("local_qa_user_create_failed");
            users.push(created.data.user.id);
            const signedIn = await anon.auth.signInWithPassword({ email, password });
            if (signedIn.error || !signedIn.data.session) throw new Error("local_qa_auth_failed");
            const userClient = createClient(local.url, local.publishableKey, {
              auth: { autoRefreshToken: false, persistSession: false },
              global: {
                headers: { Authorization: `Bearer ${signedIn.data.session.access_token}` },
              },
            });
            const onboarding = await admin.rpc("start_workspace_onboarding", {
              p_actor_user_id: created.data.user.id,
              p_workspace_name: `M15 pipeline ${suffix.toUpperCase()}`,
              p_company_name: `M15 pipeline ${suffix.toUpperCase()}`,
              p_website_url: `https://m15-pipeline-${suffix}-${nonce}.example/`,
              p_website_domain: `m15-pipeline-${suffix}-${nonce}.example`,
              p_idempotency_key: `m15-pipeline-${suffix}-${nonce}`,
              p_workspace_id: null,
            });
            const workspaceId = (onboarding.data as { workspaceId?: string } | null)?.workspaceId;
            if (onboarding.error || !workspaceId)
              throw new Error("local_qa_workspace_create_failed");
            workspaces.push(workspaceId);
            const product = await userClient
              .from("workspace_products")
              .select("id")
              .eq("workspace_id", workspaceId)
              .eq("is_default", true)
              .single();
            if (product.error || !product.data) throw new Error("local_qa_product_missing");
            return {
              userId: created.data.user.id,
              workspaceId,
              productId: product.data.id,
              userClient,
            };
          }),
        );

        const [tenantA, tenantB] = tenants;
        if (!tenantA || !tenantB) throw new Error("local_qa_tenants_missing");
        productIdempotencyRace = await proveProductIdempotencyConcurrency({
          workspaceId: tenantB.workspaceId,
          ownerUserId: tenantB.userId,
        });
        const dependencySlug = `m15-qa-${nonce.replaceAll("-", "").slice(0, 20)}`;
        const qaCatalog = await admin
          .from("dependency_catalog")
          .insert({
            slug: dependencySlug,
            name: `M15 QA ${nonce.slice(0, 8)}`,
            category: "developer-tools",
            website_url: "https://m15-qa.invalid/",
            enabled: true,
            metadata: { internal_qa: true },
          })
          .select("id")
          .single();
        if (qaCatalog.error || !qaCatalog.data) {
          throw new Error("local_qa_dependency_catalog_setup_failed");
        }

        const manualDependency = await tenantA.userClient.rpc("add_product_dependency_manually", {
          p_workspace_id: tenantA.workspaceId,
          p_product_id: tenantA.productId,
          p_dependency_slug: dependencySlug,
        });
        const workspaceDependencyId = (
          manualDependency.data as { workspaceDependencyId?: string } | null
        )?.workspaceDependencyId;
        if (manualDependency.error || !workspaceDependencyId)
          throw new Error("local_qa_dependency_add_failed");
        const context = await tenantA.userClient.rpc("set_onboarding_dependency_context", {
          p_workspace_id: tenantA.workspaceId,
          p_workspace_dependency_id: workspaceDependencyId,
          p_criticality: "important",
          p_production_critical: false,
          p_used_for: ["customer-facing product"],
          p_context_note: "Uses fixture-client in the customer-facing product.",
          p_usage_metadata: {},
        });
        if (context.error) throw new Error("local_qa_dependency_context_failed");

        const tenantBDependency = await tenantB.userClient.rpc("add_product_dependency_manually", {
          p_workspace_id: tenantB.workspaceId,
          p_product_id: tenantB.productId,
          p_dependency_slug: dependencySlug,
        });
        const tenantBWorkspaceDependencyId = (
          tenantBDependency.data as { workspaceDependencyId?: string } | null
        )?.workspaceDependencyId;
        if (tenantBDependency.error || !tenantBWorkspaceDependencyId) {
          throw new Error("local_qa_tenant_b_dependency_add_failed");
        }
        const tenantBContext = await tenantB.userClient.rpc("set_onboarding_dependency_context", {
          p_workspace_id: tenantB.workspaceId,
          p_workspace_dependency_id: tenantBWorkspaceDependencyId,
          p_criticality: "normal",
          p_production_critical: false,
          p_used_for: ["analytics"],
          p_context_note:
            "Uses the provider for offline documentation; the customer-facing product does not use fixture-client.",
          p_usage_metadata: {},
        });
        if (tenantBContext.error) throw new Error("local_qa_tenant_b_context_failed");

        const sourceIds = await Promise.all(
          [
            "material-verified",
            "material-not-found",
            "material-inconclusive",
            "material-business-allow",
            "material-business-policy-deny",
            "material-business-version-deny",
            "material-business-downgrade-deny",
            "control",
          ].map(async (kind) => {
            const inserted = await admin
              .from("source_catalog")
              .insert({
                dependency_id: qaCatalog.data.id,
                name: `M15 ${kind} ${nonce}`,
                source_type: "changelog",
                url: `https://docs.m15-qa.invalid/${kind}/${nonce}`,
                enabled: true,
              })
              .select("id")
              .single();
            if (inserted.error || !inserted.data) throw new Error("local_qa_source_create_failed");
            sources.push(inserted.data.id);
            return inserted.data.id as string;
          }),
        );

        for (const tenant of [tenantA, tenantB]) {
          for (const [step, nextStep] of [
            ["dependencies_review", "context_setup"],
            ["context_setup", "notifications_setup"],
          ] as const) {
            const completed = await tenant.userClient.rpc("complete_onboarding_step", {
              p_workspace_id: tenant.workspaceId,
              p_step: step,
            });
            if (completed.error || completed.data !== nextStep) {
              throw new Error(`local_qa_onboarding_${step}_failed`);
            }
          }
          const preferences = await tenant.userClient.rpc(
            "save_onboarding_notification_preferences",
            {
              p_workspace_id: tenant.workspaceId,
              p_important_changes: "instant",
              p_informational: "off",
              p_monthly_protection_report: false,
            },
          );
          if (preferences.error) throw new Error("local_qa_notification_preferences_failed");
          const activated = await tenant.userClient.rpc("activate_workspace_protection", {
            p_workspace_id: tenant.workspaceId,
          });
          if (activated.error) throw new Error("local_qa_workspace_activation_failed");
        }

        // Seed only the external GitHub installation/repository boundary as local QA data.
        // Selection still goes through the authenticated production RPC, and Preflight itself
        // runs through its normal persistence service with a pinned, offline provider fixture.
        const protectedProduct = await admin
          .from("workspace_products")
          .select("id,status")
          .eq("id", tenantA.productId)
          .eq("workspace_id", tenantA.workspaceId)
          .single();
        if (protectedProduct.error || protectedProduct.data.status !== "protected")
          throw new Error("local_qa_product_activation_failed");
        const connection = await admin
          .from("repository_connections")
          .insert({
            workspace_id: tenantA.workspaceId,
            provider: "github",
            installation_id: Math.floor(100_000_000 + Math.random() * 900_000_000),
            account_login: `m15-${nonce.slice(0, 8)}`,
            status: "connected",
            connected_by: tenantA.userId,
          })
          .select("id")
          .single();
        if (connection.error || !connection.data)
          throw new Error("local_qa_repository_connection_setup_failed");
        const repository = await admin
          .from("repositories")
          .insert({
            workspace_id: tenantA.workspaceId,
            connection_id: connection.data.id,
            external_id: Math.floor(1_000_000_000 + Math.random() * 8_000_000_000),
            owner: "auterim-internal-qa",
            name: `m15-${nonce.slice(0, 8)}`,
            default_branch: "main",
            private: true,
            status: "available",
          })
          .select("id")
          .single();
        if (repository.error || !repository.data)
          throw new Error("local_qa_repository_setup_failed");
        const repositorySelection = await tenantA.userClient.rpc("set_repository_protection", {
          p_repository_id: repository.data.id,
          p_selected: true,
          p_dependency_ids: [workspaceDependencyId],
        });
        if (repositorySelection.error) throw new Error("local_qa_repository_selection_failed");
        const remediationPolicy = await tenantA.userClient.rpc("set_product_remediation_policy", {
          p_workspace_id: tenantA.workspaceId,
          p_product_id: tenantA.productId,
          p_enabled: true,
          p_draft_pr_preparation_allowed: true,
          p_automatic_workflow_handoff_allowed: false,
          p_approval_required: true,
          p_allowed_repository_ids: [repository.data.id],
        });
        if (remediationPolicy.error) throw new Error("local_qa_remediation_policy_failed");

        const fetcherFor = (kind: "material" | "control") => {
          let index = 0;
          const bodies =
            kind === "material"
              ? ["legacyClient.send() was supported", "modernClient.send() is used"]
              : ["The SDK guide has examples", "The SDK guide now has clearer examples"];
          return async () => {
            const body = bodies[index++];
            if (!body) throw new Error("fixture_fetch_overrun");
            const bytes = Buffer.from(body, "utf8");
            return {
              status: 200,
              body: bytes,
              bytesRead: bytes.byteLength,
              bodyTruncated: false,
              contentType: "text/plain",
              safeHeaders: {},
              etag: null,
              lastModified: null,
              finalUrl: `https://docs.m15-qa.invalid/${nonce}`,
            };
          };
        };

        const material = await runPersistedSyntheticChange(
          {
            sourceId: sourceIds[0]!,
            workspaceDependencyId,
            additionalWorkspaceDependencyIds: [tenantBWorkspaceDependencyId],
            runIdPrefix: `m15-pipeline-material-${nonce}`,
            baselineContent: "legacyClient.send() was supported",
            changedContent: "modernClient.send() is used",
            decision: "material",
            internalQaEvidence: {
              oldExpression: "legacyClient.send()",
              newExpression: "modernClient.send()",
              evidenceSourceUrl: "https://docs.m15-qa.invalid/replacement",
            },
          },
          {
            classifier: semanticClassifier(true),
            impactClassifier,
            fetcher: fetcherFor("material") as never,
          },
        );
        expect(material.scan.status).toBe("changed");
        expect(material.classification.status).toBe("classified");
        expect(material.impactAssessments).toHaveLength(2);
        expect(material.queueItems).toHaveLength(2);
        const tenantAImpact = material.impactAssessments.find(
          (assessment) => assessment.workspaceDependencyId === workspaceDependencyId,
        );
        const tenantBImpact = material.impactAssessments.find(
          (assessment) => assessment.workspaceDependencyId === tenantBWorkspaceDependencyId,
        );
        expect(tenantAImpact?.result.status).toBe("assessed");
        expect(tenantBImpact?.result.status).toBe("assessed");
        if (
          tenantAImpact?.result.status !== "assessed" ||
          tenantBImpact?.result.status !== "assessed"
        ) {
          throw new Error("local_qa_tenant_impact_assessment_missing");
        }
        const persistedImpacts = await admin
          .from("impact_assessments")
          .select("id,workspace_dependency_id,relevant,relevance,action_required")
          .in("id", [tenantAImpact.result.id, tenantBImpact.result.id]);
        expect(persistedImpacts.error).toBeNull();
        const tenantAImpactRow = persistedImpacts.data?.find(
          (assessment: { id: string }) => assessment.id === tenantAImpact.result.id,
        );
        const tenantBImpactRow = persistedImpacts.data?.find(
          (assessment: { id: string }) => assessment.id === tenantBImpact.result.id,
        );
        expect(tenantAImpactRow).toMatchObject({ relevant: true, action_required: true });
        expect(tenantBImpactRow).toMatchObject({ relevant: false, relevance: "none" });
        const sourceChangeId = material.sourceChangeId;
        const persistedChange = await admin
          .from("source_changes")
          .select("id")
          .eq("id", sourceChangeId)
          .single();
        const persistedReplacement = await admin
          .from("source_remediation_replacements")
          .select("synthetic,internal_qa,public_eligible,old_expression,new_expression")
          .eq("source_change_id", sourceChangeId)
          .single();
        expect(persistedChange.error).toBeNull();
        expect(persistedReplacement.data).toMatchObject({
          synthetic: true,
          internal_qa: true,
          public_eligible: false,
          old_expression: "legacyClient.send()",
          new_expression: "modernClient.send()",
        });

        const impactAssessment = tenantAImpact.result;
        if (!impactAssessment || impactAssessment.status !== "assessed")
          throw new Error("local_qa_impact_assessment_missing");
        const impactAssessmentId = impactAssessment.id;
        const preflightQueue = await admin.rpc("list_preflight_dispatch_queue", { p_limit: 100 });
        expect(preflightQueue.error).toBeNull();
        const matchingPreflight = (preflightQueue.data ?? []).filter(
          (item: { impact_assessment_id: string }) =>
            item.impact_assessment_id === impactAssessmentId,
        );
        expect(matchingPreflight).toHaveLength(1);
        expect(matchingPreflight[0]).toMatchObject({
          workspace_id: tenantA.workspaceId,
          impact_assessment_id: impactAssessmentId,
          attempt_count: 0,
        });
        const noPreflightYet = await admin
          .from("preflight_runs")
          .select("id")
          .eq("impact_assessment_id", impactAssessmentId);
        expect(noPreflightYet.error).toBeNull();
        expect(noPreflightYet.data).toEqual([]);
        const tenantBImpactId =
          tenantBImpact?.result.status === "assessed" ? tenantBImpact.result.id : undefined;
        if (!tenantBImpactId) throw new Error("local_qa_tenant_b_impact_missing");
        const irrelevantTenantPreflight = await admin
          .from("preflight_dispatch_queue")
          .select("id")
          .eq("impact_assessment_id", tenantBImpactId);
        const irrelevantTenantPreflightRun = await admin
          .from("preflight_runs")
          .select("id")
          .eq("impact_assessment_id", tenantBImpactId);
        expect(irrelevantTenantPreflight.error).toBeNull();
        expect(irrelevantTenantPreflight.data).toEqual([]);
        expect(irrelevantTenantPreflightRun.error).toBeNull();
        expect(irrelevantTenantPreflightRun.data).toEqual([]);

        if (realTriggerTopology) {
          if (!process.env.TRIGGER_SECRET_KEY?.startsWith("tr_dev_sk_")) {
            throw new Error("m15_real_trigger_requires_development_credential");
          }
          const eligibleQueue = matchingPreflight[0] as { queue_id: string } | undefined;
          if (!eligibleQueue) throw new Error("m15_real_preflight_queue_identity_missing");
          const primaryTopology = await proveRealPreflightTriggerTopology({
            client: admin,
            workspaceClient: tenantA.userClient,
            unrelatedTenantClient: tenantB.userClient,
            anonymousClient: anonymousReader,
            workspaceId: tenantA.workspaceId,
            ownerUserId: tenantA.userId,
            productId: tenantA.productId,
            tenantBWorkspaceId: tenantB.workspaceId,
            queueId: eligibleQueue.queue_id,
            impactAssessmentId,
            productIdempotencyRace,
            tenantBImpactAssessmentId: tenantBImpactId,
            sourceChangeId,
            repositoryId: repository.data.id,
            nonce,
          });
          primaryBusinessScenario = primaryTopology.scenario;
          topologyIntentPath = primaryTopology.intentPath;
        }

        for (const [index, expectedOutcome] of [
          [1, "not_found"],
          [2, "inconclusive"],
        ] as const) {
          const fixtureKind = expectedOutcome;
          const fixtureChange = await runPersistedSyntheticChange(
            {
              sourceId: sourceIds[index]!,
              workspaceDependencyId,
              additionalWorkspaceDependencyIds: [tenantBWorkspaceDependencyId],
              runIdPrefix: `m15-pipeline-${fixtureKind}-${nonce}`,
              baselineContent: "legacyClient.send() was supported",
              changedContent: "modernClient.send() is used",
              decision: "material",
              internalQaEvidence: {
                oldExpression: "legacyClient.send()",
                newExpression: "modernClient.send()",
                evidenceSourceUrl: `https://docs.openai.com/m15-local/${fixtureKind}`,
              },
            },
            {
              classifier: semanticClassifier(true),
              impactClassifier,
              fetcher: fetcherFor("material") as never,
            },
          );
          expect(fixtureChange.impactAssessments).toHaveLength(2);
          const impactAssessment = fixtureChange.impactAssessments.find(
            (assessment) => assessment.workspaceDependencyId === workspaceDependencyId,
          )?.result;
          if (!impactAssessment || impactAssessment.status !== "assessed")
            throw new Error(`local_qa_${fixtureKind}_impact_assessment_missing`);
          const unrelatedImpact = fixtureChange.impactAssessments.find(
            (assessment) => assessment.workspaceDependencyId === tenantBWorkspaceDependencyId,
          )?.result;
          if (!unrelatedImpact || unrelatedImpact.status !== "assessed")
            throw new Error(`local_qa_${fixtureKind}_tenant_b_impact_missing`);
          const persistedFixtureImpacts = await admin
            .from("impact_assessments")
            .select("id,relevant,relevance,action_required")
            .in("id", [impactAssessment.id, unrelatedImpact.id]);
          expect(persistedFixtureImpacts.error).toBeNull();
          expect(persistedFixtureImpacts.data).toHaveLength(2);
          expect(
            persistedFixtureImpacts.data?.find(
              (row: { id: string }) => row.id === impactAssessment.id,
            ),
          ).toMatchObject({ relevant: true, action_required: true });
          expect(
            persistedFixtureImpacts.data?.find(
              (row: { id: string }) => row.id === unrelatedImpact.id,
            ),
          ).toMatchObject({ relevant: false, relevance: "none" });
          const pending = await admin.rpc("list_preflight_dispatch_queue", { p_limit: 100 });
          expect(pending.error).toBeNull();
          expect(
            (pending.data ?? []).some(
              (item: { impact_assessment_id: string }) =>
                item.impact_assessment_id === impactAssessment.id,
            ),
          ).toBe(true);
          expect(
            (pending.data ?? []).some(
              (item: { impact_assessment_id: string }) =>
                item.impact_assessment_id === unrelatedImpact.id,
            ),
          ).toBe(false);
        }

        if (realTriggerTopology) {
          for (const index of [3, 4, 5] as const) {
            const businessChange = await runPersistedSyntheticChange(
              {
                sourceId: sourceIds[index]!,
                workspaceDependencyId,
                additionalWorkspaceDependencyIds: [tenantBWorkspaceDependencyId],
                runIdPrefix: `m15-business-${index}-${nonce}`,
                baselineContent: "legacyClient.send() was supported",
                changedContent: "modernClient.send() is used",
                decision: "material",
                internalQaEvidence: {
                  oldExpression: "legacyClient.send()",
                  newExpression: "modernClient.send()",
                  evidenceSourceUrl: `https://docs.m15-qa.invalid/business/${index}`,
                },
              },
              {
                classifier: semanticClassifier(true),
                impactClassifier,
                fetcher: fetcherFor("material") as never,
              },
            );
            const impactAssessment = businessChange.impactAssessments.find(
              (assessment) => assessment.workspaceDependencyId === workspaceDependencyId,
            )?.result;
            if (!impactAssessment || impactAssessment.status !== "assessed") {
              throw new Error("m15_business_impact_assessment_missing");
            }
            additionalBusinessImpactIds.push(impactAssessment.id);
          }
        }

        const control = await runPersistedSyntheticChange(
          {
            sourceId: sourceIds[6]!,
            workspaceDependencyId,
            runIdPrefix: `m15-pipeline-control-${nonce}`,
            baselineContent: "The SDK guide has examples",
            changedContent: "The SDK guide now has clearer examples",
            decision: "non_material",
            internalQaEvidence: {
              oldExpression: "legacyClient.send()",
              newExpression: "modernClient.send()",
              evidenceSourceUrl: "https://docs.m15-qa.invalid/control",
            },
          },
          {
            classifier: semanticClassifier(false),
            impactClassifier,
            fetcher: fetcherFor("control") as never,
          },
        );
        expect(control.classification.status).toBe("classified");
        if (control.classification.status === "classified") {
          expect(control.classification.classification.material).toBe(false);
        }
        expect(control.queueItems).toHaveLength(0);
        expect(control.impactAssessments).toHaveLength(0);

        if (realTriggerTopology) {
          if (
            !primaryBusinessScenario ||
            !topologyIntentPath ||
            additionalBusinessImpactIds.length !== 3
          ) {
            throw new Error("m15_business_worker_scenarios_missing");
          }
          const additionalProof = await prepareAdditionalBusinessScenarios({
            client: admin,
            workspaceId: tenantA.workspaceId,
            impactAssessmentIds: additionalBusinessImpactIds,
            repositoryId: repository.data.id,
            intentPath: topologyIntentPath,
          });
          const additionalScenarios = additionalProof.scenarios;
          if (additionalScenarios.length !== 3) {
            throw new Error("m15_business_validated_scenarios_incomplete");
          }
          const dodoCustomerId = `cus_m15_${nonce.replaceAll("-", "")}`;
          const dodoSubscriptionId = `sub_m15_${nonce.replaceAll("-", "")}`;
          const customerAttached = await tenantA.userClient.rpc("attach_workspace_dodo_customer", {
            p_workspace_id: tenantA.workspaceId,
            p_customer_id: dodoCustomerId,
          });
          if (customerAttached.error) throw new Error("m15_business_customer_attach_failed");
          const [policyDeniedScenario, policyVersionScenario, downgradeDeniedScenario] =
            additionalScenarios;
          if (!policyDeniedScenario || !policyVersionScenario || !downgradeDeniedScenario) {
            throw new Error("m15_business_scenario_mapping_failed");
          }
          const businessProof = await proveBusinessHandoffRealTrigger({
            memberClient: tenantA.userClient,
            adminClient: admin,
            workspaceId: tenantA.workspaceId,
            productId: tenantA.productId,
            customerId: dodoCustomerId,
            subscriptionId: dodoSubscriptionId,
            scenarios: {
              allow: primaryBusinessScenario,
              policyDenied: policyDeniedScenario,
              policyVersionChanged: policyVersionScenario,
              downgradeDenied: downgradeDeniedScenario,
            },
          });
          await appendTopologyCheckpoint(topologyIntentPath, "business_policy_persisted", {
            businessAllow: businessProof.allow.finalStatus === "prepared",
            policyMutationDenied: businessProof.policyDenied.finalStatus === "denied",
            businessDowngradeDenied: businessProof.downgradeDenied.finalStatus === "denied",
            policyVersionChangedAndDenied:
              businessProof.policyVersionChanged.finalStatus === "denied" &&
              businessProof.policyVersionChanged.policyVersionAtMutation !== null &&
              businessProof.policyVersionChanged.policyVersionAtMutation >
                businessProof.policyVersionChanged.policyVersionBeforeRelease &&
              businessProof.policyVersionChanged.policyVersionAfterRelease ===
                businessProof.policyVersionChanged.policyVersionBeforeRelease,
            queuedPolicyVersion: businessProof.policyVersionChanged.policyVersionBeforeRelease,
            mutationPolicyVersion: businessProof.policyVersionChanged.policyVersionAtMutation ?? 0,
            triggerRunIds: [
              businessProof.allow.triggerRunId,
              businessProof.policyDenied.triggerRunId,
              businessProof.policyVersionChanged.triggerRunId,
              businessProof.downgradeDenied.triggerRunId,
            ],
            requestIds: [
              businessProof.allow.requestId,
              businessProof.policyDenied.requestId,
              businessProof.policyVersionChanged.requestId,
              businessProof.downgradeDenied.requestId,
            ],
          });
        }

        const otherTenantRows = await tenantB.userClient
          .from("workspace_dependencies")
          .select("id")
          .eq("id", workspaceDependencyId);
        expect(otherTenantRows.error).toBeNull();
        expect(otherTenantRows.data).toEqual([]);
      } catch (error) {
        primaryFailure = error;
        const primaryCode =
          error instanceof Error
            ? /^(?:m15|business_handoff)_[a-z0-9_]{1,80}(?::[a-z0-9_:]{1,120})?$/.exec(
                error.message,
              )?.[0]
            : undefined;
        if (primaryCode) process.stderr.write(`M15_QA_PRIMARY_FAILURE_SAFE=${primaryCode}\n`);
        else if (error instanceof Error && error.name === "AssertionError") {
          process.stderr.write("M15_QA_PRIMARY_FAILURE_SAFE=qa_assertion_failed\n");
        }
      } finally {
        for (const workspaceId of workspaces) {
          const membershipRemoval = await admin
            .from("workspace_members")
            .delete()
            .eq("workspace_id", workspaceId);
          const remainingMemberships = await admin
            .from("workspace_members")
            .select("user_id")
            .eq("workspace_id", workspaceId);
          if (
            membershipRemoval.error ||
            remainingMemberships.error ||
            remainingMemberships.data?.length
          ) {
            cleanupFailures.push("qa_membership_removal_unverified");
          }
        }
        let retainedHistoryWorkspaces = 0;
        for (const workspaceId of workspaces) {
          const result = await admin.from("workspaces").delete().eq("id", workspaceId);
          if (result.error?.code === "23503") {
            const membership = await admin
              .from("workspace_members")
              .select("user_id")
              .eq("workspace_id", workspaceId);
            const retainedWorkspace = await admin
              .from("workspaces")
              .select("id")
              .eq("id", workspaceId)
              .maybeSingle();
            if (
              membership.error ||
              (membership.data?.length ?? 0) !== 0 ||
              retainedWorkspace.error ||
              !retainedWorkspace.data
            ) {
              cleanupFailures.push("history_workspace_not_isolated");
            } else {
              // Persisted product history intentionally restricts tenant deletion. The
              // acceptance database is disposable and is reset before the next run.
              retainedHistoryWorkspaces++;
            }
          } else if (result.error) {
            cleanupFailures.push(`workspace:${result.error.code ?? "failed"}`);
          }
        }
        let retainedHistoryActorsBanned = 0;
        for (const userId of users) {
          const result = await admin.auth.admin.deleteUser(userId);
          const remainingUser = await admin.auth.admin.getUserById(userId);
          if (remainingUser.error?.code === "user_not_found") continue;
          if (remainingUser.error || !remainingUser.data.user) {
            cleanupFailures.push("auth_user_removal_unverified");
            continue;
          }
          if (result.error || remainingUser.data.user) {
            const banned = await admin.auth.admin.updateUserById(userId, {
              ban_duration: "876000h",
            });
            if (banned.error || !banned.data.user.banned_until) {
              cleanupFailures.push(
                `auth_user_restriction_failed:${result.error?.status ?? result.error?.code ?? "delete_refused"}`,
              );
            } else {
              retainedHistoryActorsBanned++;
            }
          }
        }
        if (sources.length) {
          const sourceDisable = await admin
            .from("source_catalog")
            .update({ enabled: false })
            .in("id", sources)
            .select("id,enabled,url");
          if (
            sourceDisable.error ||
            sourceDisable.data?.length !== sources.length ||
            sourceDisable.data.some(
              (source: { enabled: boolean; url: string }) =>
                source.enabled || !source.url.startsWith("https://docs.m15-qa.invalid/"),
            )
          ) {
            cleanupFailures.push("qa_source_retention_not_safe");
          }
          const qaChanges = await admin
            .from("source_changes")
            .select("id")
            .in("source_id", sources);
          if (qaChanges.error) {
            cleanupFailures.push(`qa_change_check:${qaChanges.error.code ?? "failed"}`);
          }
          const qaReplacements = qaChanges.data?.length
            ? await admin
                .from("source_remediation_replacements")
                .select("source_change_id,synthetic,internal_qa,public_eligible")
                .in(
                  "source_change_id",
                  qaChanges.data.map((row: { id: string }) => row.id),
                )
            : { data: [], error: null };
          if (
            qaReplacements.error ||
            (qaReplacements.data ?? []).some(
              (row: { synthetic: boolean; internal_qa: boolean; public_eligible: boolean }) =>
                !row.synthetic || !row.internal_qa || row.public_eligible,
            )
          ) {
            cleanupFailures.push("qa_evidence_retention_not_safe");
          }
          process.stderr.write(
            `M15_QA_CLEANUP=memberships_removed;auth_users_removed_or_banned_for_history=${retainedHistoryActorsBanned};unreferenced_tenants_removed;history_tenants_without_members=${retainedHistoryWorkspaces};disabled_sources=${sourceDisable.data?.length ?? 0};immutable_internal_evidence_retained=${qaChanges.data?.length ?? 0}\n`,
          );
        }
        await anon.auth.signOut();
        if (cleanupFailures.length) {
          process.stderr.write(`M15_QA_CLEANUP_FAILURE=${cleanupFailures.join(",")}\n`);
        }
      }
      if (primaryFailure) throw primaryFailure;
      if (cleanupFailures.length) throw new Error("m15_local_qa_cleanup_failed");
    },
    realTriggerTopology ? 1_500_000 : 120_000,
  );
});
