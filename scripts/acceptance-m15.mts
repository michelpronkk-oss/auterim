import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatePatchInDocker } from "../src/lib/preflight/docker-validation-core.ts";
type Stage = { name: string; status: "PASS" | "FAIL"; detail: string };
const stages: Stage[] = [];
const supportingChecks: Stage[] = [];
const root = process.cwd();
const localWorkdir = path.join(root, "node_modules", ".cache", "m15-local");
const localSupabase = path.join(localWorkdir, "supabase");
const maxOutput = 128 * 1024;
const acceptanceStartedAt = Date.now();

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function run(
  command: string,
  args: string[],
  timeout = 180_000,
  envOverride: Partial<NodeJS.ProcessEnv> = {},
) {
  const executable =
    process.platform === "win32" && ["supabase", "docker", "git"].includes(command)
      ? `${command}.exe`
      : command;
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: maxOutput,
    windowsHide: true,
    shell: process.platform === "win32" && ["npm", "npx"].includes(command),
    env: { ...process.env, ...envOverride, NO_COLOR: "1" },
  });
  return {
    ok: !result.error && result.status === 0,
    failureCode: errorCode(result.error) ?? String(result.status ?? "unknown"),
    output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  };
}

function record(name: string, ok: boolean, detail: string) {
  stages.push({ name, status: ok ? "PASS" : "FAIL", detail });
  return ok;
}

function recordSupporting(name: string, ok: boolean, detail: string) {
  supportingChecks.push({ name, status: ok ? "PASS" : "FAIL", detail });
}

function safeFailure(result: ReturnType<typeof run>) {
  return result.ok ? "ok" : result.failureCode;
}

function safeLocalTestFailure(result: ReturnType<typeof run>) {
  const code = result.output.match(/\b(?:m15|local_qa)_[a-z0-9_]{1,80}\b/g)?.at(-1);
  return code ?? safeFailure(result);
}

function safeTriggerFailure(result: ReturnType<typeof run>) {
  const topologyFailureMatch = result.output.match(
    /real_preflight_topology_test_failed:(m15_[a-z0-9_:]+)(?:;qa_cleanup=([a-z0-9_:,]+))?/,
  );
  const topologyFailure = topologyFailureMatch?.[0];
  const diagnostic =
    topologyFailure ??
    result.output.match(/M15_REAL_PREFLIGHT_FAILURE=([^\r\n]*)/)?.[1]?.slice(0, 1_200) ??
    result.output.match(
      /trigger_worker_exited_before_ready:(?:authentication|project_access|build|configuration|worker_start_error|worker_exited_without_ready_signal)/,
    )?.[0] ??
    result.output.match(/trigger_round_trip_dispatch_failed:[^\r\n]*/)?.[0]?.slice(0, 1_600) ??
    result.output.match(
      /trigger_round_trip_dispatch_failed:(?:trigger_dispatch_not_accepted:[a-z_]+|trigger_worker_persistence_timeout:run_status_[a-z_]+)|trigger_cli_auth_(?:check_failed|probe_[a-z0-9_]+|unauthorized|exit_[a-z0-9_]+)|trigger_cli_not_logged_in|trigger_cli_project_access_denied|development_credential_unproven|isolated_supabase_target_forbidden/,
    )?.[0];
  const encodedObservation = result.output.match(/M15_TRIGGER_OBSERVATION=(\{[^\r\n]+\})/)?.[1];
  if (encodedObservation) {
    try {
      const observation = JSON.parse(encodedObservation) as {
        runId?: unknown;
        dispatchAttemptId?: unknown;
        dispatchInvocation?: {
          taskId?: unknown;
          projectRef?: unknown;
          environment?: unknown;
          supabaseOrigin?: unknown;
          declaredTaskConcurrencyLimit?: unknown;
        };
        acceptedReportPersisted?: unknown;
        dispatchedAt?: unknown;
        observationPath?: unknown;
      };
      const invocation = observation.dispatchInvocation;
      const statusHistory = [...result.output.matchAll(/^M15_TRIGGER_STATUS=(\{[^\r\n]+\})$/gm)]
        .flatMap((match) => {
          try {
            const status = JSON.parse(match[1]!) as {
              runId?: unknown;
              dispatchAttemptId?: unknown;
              status?: unknown;
              isCompleted?: unknown;
              isFailed?: unknown;
              isCancelled?: unknown;
              observedAt?: unknown;
            };
            if (
              status.runId === observation.runId &&
              status.dispatchAttemptId === observation.dispatchAttemptId &&
              typeof status.status === "string" &&
              /^[A-Za-z][A-Za-z0-9_ -]{0,47}$/.test(status.status) &&
              typeof status.isCompleted === "boolean" &&
              typeof status.isFailed === "boolean" &&
              typeof status.isCancelled === "boolean" &&
              typeof status.observedAt === "string" &&
              !Number.isNaN(Date.parse(status.observedAt))
            ) {
              return [
                `${status.status}[completed=${status.isCompleted},failed=${status.isFailed},cancelled=${status.isCancelled}]@${status.observedAt}`,
              ];
            }
          } catch {
            // Ignore malformed child output and keep only validated exact-run statuses.
          }
          return [];
        })
        .join(",");
      if (
        invocation?.taskId === "m15-local-acceptance-round-trip" &&
        invocation.projectRef === "proj_hwqtxtyrvwykjirkrdoh" &&
        invocation.environment === "development" &&
        ["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"].includes(
          String(invocation.supabaseOrigin),
        ) &&
        invocation.declaredTaskConcurrencyLimit === 1 &&
        typeof observation.runId === "string" &&
        /^[A-Za-z0-9_-]+$/.test(observation.runId) &&
        typeof observation.dispatchAttemptId === "string" &&
        /^[0-9a-f-]{36}$/i.test(observation.dispatchAttemptId) &&
        typeof observation.acceptedReportPersisted === "boolean" &&
        typeof observation.dispatchedAt === "string" &&
        !Number.isNaN(Date.parse(observation.dispatchedAt)) &&
        typeof observation.observationPath === "string" &&
        observation.observationPath.includes("node_modules") &&
        observation.observationPath.includes("m15-local")
      ) {
        const statusDetail = statusHistory ? `; run_status_history=${statusHistory}` : "";
        return `${diagnostic ?? safeFailure(result)}; trigger_run_id=${observation.runId}; dispatch_attempt_id=${observation.dispatchAttemptId}; invocation_task_id=${invocation.taskId}; invocation_project_ref=${invocation.projectRef}; invocation_environment=${invocation.environment}; invocation_supabase_origin=${invocation.supabaseOrigin}; declared_task_concurrency_limit=${invocation.declaredTaskConcurrencyLimit}; accepted_report_persisted=${observation.acceptedReportPersisted}; dispatched_at=${observation.dispatchedAt}; observation_path=${observation.observationPath}${statusDetail}`;
      }
    } catch {
      // Ignore malformed child output; the ordinary safe failure code remains useful.
    }
  }
  return diagnostic ?? safeFailure(result);
}

type ProductTopologyProof = {
  attemptIntentPath?: unknown;
  dispatcherTaskId?: unknown;
  dispatcherInvocation?: unknown;
  childTaskId?: unknown;
  childRunId?: unknown;
  queueStatus?: unknown;
  preflightRunId?: unknown;
  preflightStatus?: unknown;
  verifiedImpact?: unknown;
  remediation?: {
    dispatcherTaskId?: unknown;
    childTaskId?: unknown;
    childRunId?: unknown;
    queueStatus?: unknown;
    proposalId?: unknown;
    proposalKind?: unknown;
    patchFingerprint?: unknown;
    patchValidationStatus?: unknown;
  };
  validation?: {
    dispatcherTaskId?: unknown;
    childTaskId?: unknown;
    childRunId?: unknown;
    outcome?: unknown;
    proposalStatus?: unknown;
    durationMs?: unknown;
  };
  resolution?: { id?: unknown; replayReturnedSame?: unknown };
  protectionHistory?: unknown;
  populatedTenantIsolation?: unknown;
  anonymousIsolation?: unknown;
  economicScoping?: {
    singleGlobalChange?: unknown;
    sharedDependency?: unknown;
    tenantARelevant?: unknown;
    tenantBRelevant?: unknown;
    tenantAPreflightCompleted?: unknown;
    tenantBPreflightQueueRows?: unknown;
    tenantBPreflightRows?: unknown;
    tenantBRemediationRows?: unknown;
    tenantBValidationRows?: unknown;
  };
  duplicateDeliveryProof?: {
    preflight?: {
      taskId?: unknown;
      runIds?: unknown;
      outcomes?: unknown;
      canonicalResults?: unknown;
    };
    remediation?: {
      taskId?: unknown;
      runIds?: unknown;
      outcomes?: unknown;
      canonicalProposals?: unknown;
    };
    validation?: {
      taskId?: unknown;
      runIds?: unknown;
      outcomes?: unknown;
      canonicalAttempts?: unknown;
    };
    noDuplicateLogicalWork?: unknown;
  };
};

async function safeProductTopologySuccess(result: ReturnType<typeof run>, startedAt: number) {
  let markerName: string | undefined;
  const wrapperReport = parseJsonOutput<{ attemptIntentPath?: unknown }>(result.output);
  if (typeof wrapperReport?.attemptIntentPath === "string") {
    const candidate = path.basename(wrapperReport.attemptIntentPath);
    const candidateDirectory = path.dirname(path.resolve(wrapperReport.attemptIntentPath));
    if (
      candidateDirectory.toLowerCase() === path.resolve(localWorkdir).toLowerCase() &&
      /^preflight-topology-[0-9a-f-]{36}\.jsonl$/i.test(candidate)
    ) {
      markerName = candidate;
    }
  }
  if (!markerName) {
    return { ok: false as const, proof: null, failure: "topology_marker_identity_missing" };
  }
  let proof: ProductTopologyProof | null = null;
  try {
    const records = (await readFile(path.join(localWorkdir, markerName), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      });
    const prepared = records.find((record) => record.status === "prepared");
    if (!prepared) {
      return { ok: false as const, proof: null, failure: "topology_attempt_record_missing" };
    }
    const preparedAt =
      typeof prepared.preparedAt === "string" ? Date.parse(prepared.preparedAt) : Number.NaN;
    if (!Number.isFinite(preparedAt) || preparedAt < startedAt) {
      return { ok: false as const, proof: null, failure: "topology_marker_stale" };
    }
    const completed = records.findLast((record) => record.status === "money_path_complete");
    if (!completed) {
      return { ok: false as const, proof: null, failure: "topology_completion_record_missing" };
    }
    proof = {
      attemptIntentPath: path.join(localWorkdir, markerName),
      dispatcherTaskId: prepared.dispatcherTaskId,
      dispatcherInvocation: "registered_development_schedule",
      childTaskId: prepared.childTaskId,
      childRunId: completed.preflightChildRunId,
      queueStatus: completed.preflightStatus === "completed" ? "complete" : undefined,
      preflightStatus: completed.preflightStatus,
      verifiedImpact: completed.verifiedImpact,
      remediation: {
        dispatcherTaskId: "dispatch-remediation-preparation",
        childTaskId: "prepare-remediation",
        childRunId: completed.remediationChildRunId,
        queueStatus: completed.remediationQueueStatus,
        proposalId: completed.proposalId,
        proposalKind: completed.proposalKind,
        patchFingerprint: completed.patchFingerprint,
        patchValidationStatus: completed.proposalValidationStatus,
      },
      validation: {
        dispatcherTaskId: "dispatch-remediation-validation",
        childTaskId: "validate-remediation",
        childRunId: completed.validationChildRunId,
        outcome: completed.validationOutcome,
        proposalStatus: completed.proposalValidationStatus,
        durationMs: completed.validationDurationMs,
      },
      resolution: {
        id: completed.resolutionId,
        replayReturnedSame: completed.resolutionReplayReturnedSame,
      },
      protectionHistory: completed.protectionHistory,
      populatedTenantIsolation: completed.populatedTenantIsolation,
      anonymousIsolation: completed.anonymousIsolation,
      economicScoping: completed.economicScoping as ProductTopologyProof["economicScoping"],
      duplicateDeliveryProof:
        completed.duplicateDeliveryProof as ProductTopologyProof["duplicateDeliveryProof"],
    };
  } catch {
    return { ok: false as const, proof: null, failure: "topology_marker_unreadable" };
  }
  if (!proof)
    return { ok: false as const, proof: null, failure: "local_completion_marker_missing" };
  const runId = (value: unknown): value is string =>
    typeof value === "string" && /^run_[A-Za-z0-9_-]+$/.test(value);
  const fingerprint = proof.remediation?.patchFingerprint;
  const historyKinds = Array.isArray(proof.protectionHistory) ? proof.protectionHistory : [];
  const checks: Record<string, boolean> = {
    process_completed: result.ok,
    preflight_dispatcher: proof.dispatcherTaskId === "dispatch-preflight-queue",
    preflight_schedule:
      proof.dispatcherInvocation === "registered_development_schedule" ||
      proof.dispatcherInvocation === "registered_development_task_run",
    preflight_child: proof.childTaskId === "run-preflight" && runId(proof.childRunId),
    preflight_persisted:
      proof.queueStatus === "complete" &&
      proof.preflightStatus === "completed" &&
      proof.verifiedImpact === "verified",
    remediation_dispatcher:
      proof.remediation?.dispatcherTaskId === "dispatch-remediation-preparation",
    remediation_child:
      proof.remediation?.childTaskId === "prepare-remediation" &&
      runId(proof.remediation.childRunId),
    remediation_persisted:
      proof.remediation?.queueStatus === "completed" &&
      proof.remediation.proposalKind === "patch" &&
      typeof proof.remediation.proposalId === "string",
    patch_fingerprint: typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    validation_dispatcher: proof.validation?.dispatcherTaskId === "dispatch-remediation-validation",
    validation_child:
      proof.validation?.childTaskId === "validate-remediation" &&
      runId(proof.validation.childRunId),
    validation_persisted:
      proof.validation?.outcome === "validated" &&
      proof.validation.proposalStatus === "validated" &&
      typeof proof.validation.durationMs === "number",
    resolution_replay:
      proof.resolution?.replayReturnedSame === true && typeof proof.resolution.id === "string",
    history_shape: Array.isArray(proof.protectionHistory),
    tenant_isolation: proof.populatedTenantIsolation === true,
    anonymous_isolation: proof.anonymousIsolation === true,
    history_complete:
      Array.isArray(proof.protectionHistory) &&
      [
        "automatic_preflight_started",
        "preflight_completed",
        "verified_risk_found",
        "remediation_generated",
        "remediation_validated",
        "risk_resolved",
      ].every((kind) => historyKinds.includes(kind)),
    economic_scoping:
      proof.economicScoping?.singleGlobalChange === true &&
      proof.economicScoping.sharedDependency === true &&
      proof.economicScoping.tenantARelevant === true &&
      proof.economicScoping.tenantBRelevant === false &&
      proof.economicScoping.tenantAPreflightCompleted === true &&
      proof.economicScoping.tenantBPreflightQueueRows === 0 &&
      proof.economicScoping.tenantBPreflightRows === 0 &&
      proof.economicScoping.tenantBRemediationRows === 0 &&
      proof.economicScoping.tenantBValidationRows === 0,
    preflight_duplicate_delivery:
      proof.duplicateDeliveryProof?.preflight?.taskId === "run-preflight" &&
      Array.isArray(proof.duplicateDeliveryProof.preflight.runIds) &&
      proof.duplicateDeliveryProof.preflight.runIds.length === 2 &&
      Array.isArray(proof.duplicateDeliveryProof.preflight.outcomes) &&
      proof.duplicateDeliveryProof.preflight.outcomes.includes("completed") &&
      proof.duplicateDeliveryProof.preflight.outcomes.includes("complete") &&
      proof.duplicateDeliveryProof.preflight.canonicalResults === 1,
    remediation_duplicate_delivery:
      proof.duplicateDeliveryProof?.remediation?.taskId === "prepare-remediation" &&
      Array.isArray(proof.duplicateDeliveryProof.remediation.runIds) &&
      proof.duplicateDeliveryProof.remediation.runIds.length === 2 &&
      Array.isArray(proof.duplicateDeliveryProof.remediation.outcomes) &&
      (proof.duplicateDeliveryProof.remediation.outcomes.includes("completed") ||
        proof.duplicateDeliveryProof.remediation.outcomes.includes("persisted_before_retry")) &&
      proof.duplicateDeliveryProof.remediation.outcomes.includes("replayed") &&
      proof.duplicateDeliveryProof.remediation.canonicalProposals === 1,
    validation_duplicate_delivery:
      proof.duplicateDeliveryProof?.validation?.taskId === "validate-remediation" &&
      Array.isArray(proof.duplicateDeliveryProof.validation.runIds) &&
      proof.duplicateDeliveryProof.validation.runIds.length === 2 &&
      Array.isArray(proof.duplicateDeliveryProof.validation.outcomes) &&
      (proof.duplicateDeliveryProof.validation.outcomes.includes("validated") ||
        proof.duplicateDeliveryProof.validation.outcomes.includes("persisted_before_retry")) &&
      proof.duplicateDeliveryProof.validation.outcomes.includes("replayed") &&
      proof.duplicateDeliveryProof.validation.canonicalAttempts === 1 &&
      proof.duplicateDeliveryProof.noDuplicateLogicalWork === true,
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const ok = failedChecks.length === 0;
  return {
    ok,
    failure: failedChecks.join(",") || undefined,
    proof: ok
      ? {
          preflightRunId: proof.childRunId,
          remediationRunId: proof.remediation?.childRunId,
          validationRunId: proof.validation?.childRunId,
          proposalId: proof.remediation?.proposalId,
          patchFingerprint: fingerprint,
          validationDurationMs: proof.validation?.durationMs,
          duplicateDeliveryProof: proof.duplicateDeliveryProof,
        }
      : null,
  };
}

async function safeProductTopologyProgress(startedAt: number) {
  try {
    const names = await readdir(localWorkdir);
    const matching: Array<{
      attemptIntentPath: string;
      records: Array<Record<string, unknown>>;
    }> = [];
    for (const name of names) {
      if (!/^preflight-topology-[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
      let records: Array<Record<string, unknown>>;
      try {
        records = (await readFile(path.join(localWorkdir, name), "utf8"))
          .split(/\r?\n/)
          .filter(Boolean)
          .flatMap((line) => {
            try {
              const record = JSON.parse(line) as unknown;
              return record && typeof record === "object" && !Array.isArray(record)
                ? [record as Record<string, unknown>]
                : [];
            } catch {
              return [];
            }
          });
      } catch {
        continue;
      }
      const prepared = records.find((record) => record.status === "prepared");
      const preparedAt =
        typeof prepared?.preparedAt === "string" ? Date.parse(prepared.preparedAt) : Number.NaN;
      if (Number.isFinite(preparedAt) && preparedAt >= startedAt) {
        matching.push({ attemptIntentPath: path.join(localWorkdir, name), records });
      }
    }
    if (matching.length !== 1) {
      return {
        attemptIntentPath: undefined,
        records: [] as Array<Record<string, unknown>>,
        checkpoints: new Set<string>(),
        failure:
          matching.length === 0 ? "fresh_attempt_marker_missing" : "multiple_fresh_attempt_markers",
      };
    }
    return {
      attemptIntentPath: matching[0]!.attemptIntentPath,
      records: matching[0]!.records,
      checkpoints: new Set(
        matching[0]!.records
          .map((record) => record.status)
          .filter((status): status is string => typeof status === "string"),
      ),
      failure: undefined,
    };
  } catch {
    return {
      attemptIntentPath: undefined,
      records: [] as Array<Record<string, unknown>>,
      checkpoints: new Set<string>(),
      failure: "attempt_progress_unavailable",
    };
  }
}

function parseJsonOutput<T>(output: string): T | null {
  for (const line of output.split(/\r?\n/).reverse()) {
    const candidate = line.trim();
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Keep looking for a complete structured report line.
    }
  }
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(output.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

async function prepareIsolatedSupabase() {
  const config = await readFile(path.join(root, "supabase", "config.toml"), "utf8");
  const versions = (await readdir(path.join(root, "supabase", "migrations")))
    .filter((name) => /^\d{14}_.+\.sql$/.test(name))
    .map((name) => name.slice(0, 14))
    .sort();
  const isolatedMigrations = path.join(localSupabase, "migrations");
  await mkdir(isolatedMigrations, { recursive: true });
  const localConfig = config
    .replace('project_id = "auterim"', 'project_id = "auterim-m15-acceptance"')
    .replace(/^port = 54321$/m, "port = 65431")
    .replace(/^port = 54322$/m, "port = 65432")
    .replace(/^shadow_port = 54320$/m, "shadow_port = 65430")
    .replace(/^port = 54329$/m, "port = 65429")
    .replace(/^port = 54323$/m, "port = 65433")
    .replace(/^port = 54324$/m, "port = 65434")
    .replace(/^port = 54327$/m, "port = 65437")
    .replace(/^inspector_port = 8083$/m, "inspector_port = 68083")
    .replace(/^openai_api_key = .*$/m, 'openai_api_key = ""');
  await writeFile(path.join(localSupabase, "config.toml"), localConfig, "utf8");
  await cp(path.join(root, "supabase", "migrations"), path.join(localSupabase, "migrations"), {
    recursive: true,
    filter: (source) => !source.endsWith(".DS_Store"),
  });
  await writeFile(
    path.join(isolatedMigrations, "20261024000000_m15_local_trigger_roundtrip.sql"),
    [
      "create table public.m15_local_trigger_roundtrip (",
      "  correlation_id uuid primary key,",
      "  task_id text not null check (task_id = 'm15-local-acceptance-round-trip'),",
      "  run_id text not null,",
      "  completed_at timestamptz not null default now()",
      ");",
      "alter table public.m15_local_trigger_roundtrip enable row level security;",
      "revoke all on public.m15_local_trigger_roundtrip from anon, authenticated;",
      "grant all on public.m15_local_trigger_roundtrip to service_role;",
      "",
    ].join("\n"),
    "utf8",
  );
  return versions;
}

async function clearStaleLocalAcceptanceHoldMarkers() {
  const gateDirectory = path.join(localWorkdir, "preclaim-gates");
  const staleMarkerNames = [
    "run-preflight-hold-all",
    "prepare-remediation-hold-all",
    "validate-remediation-hold-all",
    "prepare-business-handoff-hold-all",
  ];
  await Promise.all(
    staleMarkerNames.map((name) => rm(path.join(gateDirectory, name), { force: true })),
  );
}

async function dockerFixtureProof(): Promise<{ ok: boolean; failureCode?: string }> {
  const fixture = path.join(root, "tests", "fixtures", "m15-money-path");
  const patch = [
    "diff --git a/src/client.ts b/src/client.ts",
    "--- a/src/client.ts",
    "+++ b/src/client.ts",
    "@@ -1,1 +1,1 @@",
    '-export const configuredEntity = "fixture-client"; const legacyClient = { send: () => "old" }; const modernClient = { send: () => "new" }; export const client = legacyClient.send();',
    '+export const configuredEntity = "fixture-client"; const legacyClient = { send: () => "old" }; const modernClient = { send: () => "new" }; export const client = modernClient.send();',
    "",
  ].join("\n");
  const imageBuild = spawnSync(
    process.platform === "win32" ? "docker.exe" : "docker",
    [
      "build",
      "--file",
      "scripts/m15-validation/Dockerfile",
      "--tag",
      "auterim/m15-validator:1",
      ".",
    ],
    { cwd: root, encoding: "utf8", timeout: 600_000, maxBuffer: maxOutput, windowsHide: true },
  );
  if (imageBuild.error || imageBuild.status !== 0) {
    return { ok: false, failureCode: errorCode(imageBuild.error) ?? String(imageBuild.status) };
  }
  const validation = await validatePatchInDocker({
    repositoryDirectory: fixture,
    patch,
    timeoutMs: 120_000,
  });
  return {
    ok: validation.state === "VALIDATED",
    failureCode: validation.state === "VALIDATED" ? undefined : validation.category,
  };
}

const project = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
  name?: string;
};
if (
  project.name !== "auterim" ||
  !(await readFile(path.join(root, "AGENTS.md"), "utf8")).includes("Auterim Supabase project")
) {
  process.stdout.write(
    JSON.stringify({
      acceptance: "FAIL",
      stages: [
        { name: "PROJECT_ISOLATION", status: "FAIL", detail: "Auterim repository root required" },
      ],
    }),
  );
  process.exit(1);
}

const projectCheck = run("npm", ["run", "project:check"]);
record(
  "ENVIRONMENT",
  projectCheck.ok,
  projectCheck.ok ? "Auterim identity checks passed" : "project:check failed; output withheld",
);
const envCheck = run("npm", ["run", "env:check"]);
record(
  "ENV_CONFIGURATION",
  envCheck.ok,
  envCheck.ok ? "environment presence check passed" : "env:check failed; output withheld",
);

let expectedMigrations: string[] = [];
let localStackReady = false;
try {
  const dockerContext = run("docker", ["context", "show"]);
  if (!dockerContext.ok || dockerContext.output.trim() !== "desktop-linux") {
    throw new Error("local_docker_context_required");
  }
  expectedMigrations = await prepareIsolatedSupabase();
  await clearStaleLocalAcceptanceHoldMarkers();
  const started = run("supabase", [
    "start",
    "--workdir",
    localWorkdir,
    "--exclude",
    "studio,mailpit,storage-api,imgproxy,edge-runtime,logflare,vector,supavisor",
  ]);
  const reset = started.ok
    ? run("supabase", ["db", "reset", "--local", "--no-seed", "--workdir", localWorkdir])
    : started;
  const history = reset.ok
    ? run("supabase", ["migration", "list", "--local", "--workdir", localWorkdir])
    : reset;
  const localVersions = [...history.output.matchAll(/^\s*(\d{14})\s*\|/gm)].map(
    (match) => match[1]!,
  );
  const dbOk =
    started.ok &&
    reset.ok &&
    expectedMigrations.every((version) => localVersions.includes(version));
  record(
    "DATABASE",
    dbOk,
    dbOk
      ? `${expectedMigrations.length} migrations applied and present in local history`
      : `local stack=${safeFailure(started)}, reset=${safeFailure(reset)}, history=${safeFailure(history)}, migrations=${localVersions.length}/${expectedMigrations.length}`,
  );
  localStackReady = dbOk;
} catch {
  record("DATABASE", false, "could not prepare isolated local Postgres");
}

type IntegrationReport = {
  acceptance: string;
  stages: Stage[];
};
const localAuthRls = localStackReady
  ? run("node", [
      "--experimental-strip-types",
      "scripts/m15-validation/local-auth-rls.mts",
      localWorkdir,
    ])
  : null;
const localAuthReport = localAuthRls
  ? parseJsonOutput<IntegrationReport>(localAuthRls.output)
  : null;
const authStages = new Map((localAuthReport?.stages ?? []).map((stage) => [stage.name, stage]));
const localAuthFailureStage = localAuthReport?.stages.find((stage) => stage.status === "FAIL");
for (const [stageName, reportName] of [
  ["AUTH", "AUTH_JWT"],
  ["WORKSPACES", "WORKSPACE_PRODUCT_RLS"],
  ["TENANT_ISOLATION", "TENANT_ISOLATION"],
  ["POLICY_PERSISTENCE", "POLICY_PERSISTENCE"],
  ["SERVICE_BOUNDARY", "VALIDATION_AND_REPLACEMENT_BOUNDARIES"],
  ["ANONYMOUS_BOUNDARY", "ANON_BOUNDARY"],
] as const) {
  const stage = authStages.get(reportName);
  record(
    stageName,
    Boolean(localStackReady && stage?.status === "PASS"),
    stage?.detail ??
      (localAuthRls?.ok
        ? "local Auth/RLS report omitted expected stage"
        : `isolated local Auth/RLS proof ${localAuthRls ? safeLocalTestFailure(localAuthRls) : "not_run"}${localAuthFailureStage ? `; ${localAuthFailureStage.name}=${localAuthFailureStage.detail}` : ""}`),
  );
}

const persistedPath = localStackReady
  ? run("npx", ["vitest", "run", "tests/m15-local-money-path.integration.test.ts"], 180_000, {
      AUTERIM_M15_LOCAL_INTEGRATION: "1",
      AUTERIM_M15_LOCAL_SUPABASE_URL: "http://127.0.0.1:65431",
      AUTERIM_M15_LOCAL_REPO_ROOT: root,
    })
  : null;
const persistedPathPassed = Boolean(persistedPath?.ok);
for (const stageName of [
  "PROTECTED_PRODUCT_DEPENDENCY",
  "CHANGE_PERSISTENCE",
  "MATERIALITY",
  "CUSTOMER_RELEVANCE",
  "TRUSTED_REPLACEMENT_EVIDENCE",
]) {
  record(
    stageName,
    persistedPathPassed,
    persistedPathPassed
      ? "one global synthetic change was classified against both tenants sharing the same dependency; only relevant tenant A entered the Preflight queue"
      : `persisted local change-to-impact proof ${persistedPath ? safeLocalTestFailure(persistedPath) : "not_run"}`,
  );
}
const productTopologyStartedAt = Date.now();
const productTopology = localStackReady
  ? run(
      "node",
      [
        "--experimental-strip-types",
        "scripts/m15-validation/trigger-dev-roundtrip.mts",
        "--real-preflight",
      ],
      1_800_000,
    )
  : null;
const productTopologyReport = productTopology
  ? productTopology.ok
    ? await safeProductTopologySuccess(productTopology, productTopologyStartedAt)
    : { ok: false, proof: null, failure: safeTriggerFailure(productTopology) }
  : { ok: false, proof: null, failure: "not_run" };
const productTopologyProgress = productTopology
  ? await safeProductTopologyProgress(productTopologyStartedAt)
  : {
      attemptIntentPath: undefined,
      records: [] as Array<Record<string, unknown>>,
      checkpoints: new Set<string>(),
      failure: "not_run",
    };
const hasTopologyCheckpoint = (checkpoint: string) =>
  productTopologyProgress.checkpoints.has(`stage_${checkpoint}`);

async function readFocusedEntitlementCheckpoint() {
  const expected = new Map([
    ["allowed_pro_execution", { taskId: "prepare-remediation", outcome: "completed" }],
    ["subscription_downgraded", { taskId: "prepare-remediation", outcome: "denied" }],
    ["subscription_expired", { taskId: "prepare-remediation", outcome: "denied" }],
    ["product_archived", { taskId: "prepare-remediation", outcome: "denied" }],
    ["dependency_disabled", { taskId: "prepare-remediation", outcome: "denied" }],
    ["preflight_superseded", { taskId: "prepare-remediation", outcome: "denied" }],
    ["stale_validation_work", { taskId: "validate-remediation", outcome: "denied" }],
  ]);
  try {
    const names = await readdir(localWorkdir);
    const candidates = names.filter((name) =>
      /^entitlement-matrix-[0-9a-f-]{36}\.json$/i.test(name),
    );
    const valid: Array<{ path: string; observedAt: number; fixtureId: string }> = [];
    for (const name of candidates) {
      const filePath = path.join(localWorkdir, name);
      try {
        const value = JSON.parse(await readFile(filePath, "utf8")) as {
          status?: unknown;
          fixtureId?: unknown;
          observedAt?: unknown;
          caseCount?: unknown;
          cases?: unknown;
          rounds?: unknown;
        };
        const observedAt =
          typeof value.observedAt === "string" ? Date.parse(value.observedAt) : NaN;
        if (
          value.status !== "m15_entitlement_matrix_proven" ||
          typeof value.fixtureId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(value.fixtureId) ||
          name !== `entitlement-matrix-${value.fixtureId}.json` ||
          value.caseCount !== 7 ||
          !Number.isFinite(observedAt) ||
          observedAt > Date.now() ||
          observedAt < acceptanceStartedAt - 2 * 60 * 60 * 1000 ||
          !Array.isArray(value.cases) ||
          value.cases.length !== 7 ||
          !Array.isArray(value.rounds) ||
          value.rounds.length !== 2
        )
          continue;
        const actual = new Map<
          string,
          {
            status?: unknown;
            taskId?: unknown;
            workerOutcome?: unknown;
            queueId?: unknown;
            triggerRunId?: unknown;
          }
        >();
        for (const item of value.cases) {
          if (item && typeof item === "object" && "name" in item && typeof item.name === "string") {
            actual.set(
              item.name,
              item as {
                status?: unknown;
                taskId?: unknown;
                workerOutcome?: unknown;
                queueId?: unknown;
                triggerRunId?: unknown;
              },
            );
          }
        }
        if (actual.size !== expected.size) continue;
        let casesMatch = true;
        const queueIds = new Set<string>();
        const runIds = new Set<string>();
        for (const [caseName, expectation] of expected) {
          const item = actual.get(caseName);
          if (
            item?.status !== "proven" ||
            item.taskId !== expectation.taskId ||
            item.workerOutcome !== expectation.outcome ||
            typeof item.queueId !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(item.queueId) ||
            typeof item.triggerRunId !== "string" ||
            !/^run_[A-Za-z0-9_-]+$/.test(item.triggerRunId)
          ) {
            casesMatch = false;
            break;
          }
          queueIds.add(item.queueId);
          runIds.add(item.triggerRunId);
        }
        if (queueIds.size !== 7 || runIds.size !== 7 || !casesMatch) continue;
        const roundsMatch = value.rounds.every((item, index) => {
          if (
            !item ||
            typeof item !== "object" ||
            !Array.isArray((item as { workerEvents?: unknown }).workerEvents)
          )
            return false;
          const round = item as {
            round?: unknown;
            workerEvents: Array<{ event?: unknown }>;
            taskIds?: unknown;
          };
          const expectedRound = index === 0 ? "core" : "stale";
          return (
            round.round === expectedRound &&
            round.workerEvents.some((event) => event.event === "worker_ready") &&
            round.workerEvents.some((event) => event.event === "presence_established") &&
            Array.isArray(round.taskIds) &&
            round.taskIds.includes(
              expectedRound === "core" ? "prepare-remediation" : "validate-remediation",
            )
          );
        });
        if (!roundsMatch) continue;
        valid.push({ path: filePath, observedAt, fixtureId: value.fixtureId });
      } catch {
        // Ignore malformed local checkpoint artifacts; only a complete fresh proof may pass.
      }
    }
    if (valid.length !== 1)
      return {
        ok: false as const,
        failure:
          valid.length === 0
            ? "focused_entitlement_checkpoint_missing_or_invalid"
            : "multiple_focused_entitlement_checkpoints",
      };
    return { ok: true as const, ...valid[0]! };
  } catch {
    return { ok: false as const, failure: "focused_entitlement_checkpoint_unavailable" };
  }
}

const focusedEntitlementCheckpoint = await readFocusedEntitlementCheckpoint();
const coreConcurrencyCheckpoint = productTopologyProgress.records.find(
  (record) => record.status === "stage_postgres_core_concurrency_persisted",
);
const claimConcurrencyCheckpoint = productTopologyProgress.records.find(
  (record) => record.status === "stage_postgres_concurrency_persisted",
);
const claimConcurrencyFailureCheckpoint = productTopologyProgress.records.find(
  (record) => record.status === "stage_postgres_claim_concurrency_failed",
);
const postgresConcurrencyPassed =
  coreConcurrencyCheckpoint?.independentSessionRaces === 2 &&
  coreConcurrencyCheckpoint.productIdempotencyRacePassed === true &&
  coreConcurrencyCheckpoint.resolutionRacePassed === true &&
  claimConcurrencyCheckpoint?.independentClaimSessionRaces === 3 &&
  claimConcurrencyCheckpoint.independentBackendSessions === true &&
  claimConcurrencyCheckpoint.preflightClaimWinnerCount === 1 &&
  claimConcurrencyCheckpoint.remediationClaimWinnerCount === 1 &&
  claimConcurrencyCheckpoint.validationClaimWinnerCount === 1 &&
  claimConcurrencyCheckpoint.preflightClaimBarrierObserved === true &&
  claimConcurrencyCheckpoint.remediationClaimBarrierObserved === true &&
  claimConcurrencyCheckpoint.validationClaimBarrierObserved === true &&
  claimConcurrencyCheckpoint.claimTokensPersistedOnlyServerSide === true &&
  claimConcurrencyCheckpoint.noDeadlockOrLockTimeout === true;
recordSupporting(
  "REAL_TRIGGER_TASK_TOPOLOGY",
  productTopologyReport.ok,
  productTopologyReport.ok
    ? `scheduled dispatchers and product child tasks completed against local persistence; ${JSON.stringify(productTopologyReport.proof)}`
    : `real Trigger Development product topology ${productTopologyReport.failure ?? (productTopology ? safeTriggerFailure(productTopology) : "not_run")}`,
);
recordSupporting(
  "POSTGRES_CORE_CONCURRENCY",
  coreConcurrencyCheckpoint?.independentSessionRaces === 2 &&
    coreConcurrencyCheckpoint.productIdempotencyRacePassed === true &&
    coreConcurrencyCheckpoint.resolutionRacePassed === true,
  coreConcurrencyCheckpoint
    ? "independent local PostgreSQL sessions proved product-idempotency and resolution races; queue-claim races remain separate"
    : "independent PostgreSQL core idempotency and resolution races were not proven",
);
record(
  "ECONOMIC_SCOPING",
  hasTopologyCheckpoint("economic_scoping_persisted"),
  hasTopologyCheckpoint("economic_scoping_persisted")
    ? "fresh persisted checkpoint proves one shared global change, relevant tenant A work, and zero tenant B downstream rows"
    : `same-change, same-dependency cross-tenant relevance and zero downstream work are not proven${productTopologyProgress.failure ? `; ${productTopologyProgress.failure}` : ""}`,
);
record(
  "PREFLIGHT",
  hasTopologyCheckpoint("preflight_persisted"),
  hasTopologyCheckpoint("preflight_persisted")
    ? "checkpoint proves the real run-preflight child completed and persisted one verified Preflight result"
    : `real Preflight worker result ${productTopologyReport.failure ?? (productTopology ? safeTriggerFailure(productTopology) : "not_run")}`,
);
record(
  "AUTOMATIC_REMEDIATION_ENQUEUE",
  hasTopologyCheckpoint("remediation_persisted"),
  hasTopologyCheckpoint("remediation_persisted")
    ? "checkpoint proves verified Preflight automatically reached and completed the remediation preparation queue"
    : "verified Preflight did not produce a proven completed remediation preparation queue",
);
record(
  "PATCH_PERSISTENCE",
  hasTopologyCheckpoint("remediation_persisted"),
  hasTopologyCheckpoint("remediation_persisted")
    ? "checkpoint proves prepare-remediation persisted a grounded patch proposal and fingerprint"
    : "no completed remediation child produced a proven persisted proposal",
);
record(
  "VALIDATION_QUEUE",
  hasTopologyCheckpoint("validation_persisted"),
  hasTopologyCheckpoint("validation_persisted")
    ? "checkpoint proves the persisted patch reached the real validation dispatcher and child queue"
    : "no completed validation child and persisted outcome are proven",
);
record(
  "VALIDATION_ROW_ISOLATION",
  hasTopologyCheckpoint("tenant_isolation_persisted"),
  hasTopologyCheckpoint("tenant_isolation_persisted")
    ? "checkpoint proves populated money-path rows were denied to unrelated and anonymous clients"
    : "populated-row isolation was not completed through the real product path",
);
record(
  "PATCH_GROUNDING",
  hasTopologyCheckpoint("remediation_persisted"),
  hasTopologyCheckpoint("remediation_persisted")
    ? "checkpoint proves the persisted patch contains exact fixture path and old/new expressions from pinned repository evidence"
    : "no Trigger-produced patch has been grounded against the pinned fixture",
);

const fixTests = run("npx", [
  "vitest",
  "run",
  "tests/preflight.test.ts",
  "-t",
  "exact replacement grounded in the verified pinned file",
]);
recordSupporting(
  "FIX_PREPARATION",
  fixTests.ok,
  fixTests.ok
    ? "exact pinned-file replacement tests passed"
    : "patch preparation test failed; output withheld",
);
const entitlementTests = run("npx", [
  "vitest",
  "run",
  "tests/billing.test.ts",
  "-t",
  "explicit Business policy",
]);
recordSupporting(
  "ENTITLEMENT_POLICY",
  entitlementTests.ok,
  entitlementTests.ok
    ? "canonical entitlement and policy tests passed"
    : "entitlement/policy test failed; output withheld",
);
let dockerProof: { ok: boolean; failureCode?: string } = {
  ok: false,
  failureCode: "exception",
};
try {
  dockerProof = await dockerFixtureProof();
} catch {
  dockerProof = { ok: false, failureCode: "exception" };
}
recordSupporting(
  "PATCH_VALIDATION",
  dockerProof.ok,
  dockerProof.ok
    ? "fixture patch tests and typecheck passed in bounded no-network container"
    : `container validation process ${dockerProof.failureCode}`,
);

for (const [name, detail, stageOk] of [
  [
    "REAL_TRIGGER_EXECUTION_ROUND_TRIP",
    hasTopologyCheckpoint("validation_persisted")
      ? "fresh checkpoints prove registered dispatchers, real product child execution, and local results through validation"
      : "real scheduled dispatcher → child execution → local persistence path is not proven through validation",
    hasTopologyCheckpoint("validation_persisted"),
  ],
  [
    "PATCH_VALIDATION_PERSISTENCE",
    hasTopologyCheckpoint("validation_persisted")
      ? "checkpoint proves the real validation child persisted a validated Docker outcome and updated the proposal"
      : "Docker output has not been proven persisted through an asynchronous worker",
    hasTopologyCheckpoint("validation_persisted"),
  ],
  [
    "ENTITLEMENT_RECHECK",
    focusedEntitlementCheckpoint.ok
      ? "fresh focused checkpoints prove six canonical authorization cases plus real validation denial after a newer Preflight makes queued patch evidence stale; proposal replacement is not a reachable product transition"
      : `focused real-worker entitlement matrix is not proven: ${focusedEntitlementCheckpoint.failure}`,
    focusedEntitlementCheckpoint.ok,
  ],
  [
    "BUSINESS_POLICY_ELIGIBILITY",
    hasTopologyCheckpoint("business_policy_persisted")
      ? "real Business handoff worker evidence proves allow, policy mutation denial, Business downgrade denial, and explicit stale policy-version semantics"
      : "persisted Business handoff allow/deny worker cases and current policy/version rechecks have not been proven",
    hasTopologyCheckpoint("business_policy_persisted"),
  ],
  [
    "LIFECYCLE",
    hasTopologyCheckpoint("preflight_persisted") &&
    hasTopologyCheckpoint("remediation_persisted") &&
    hasTopologyCheckpoint("validation_persisted") &&
    hasTopologyCheckpoint("resolution_persisted") &&
    hasTopologyCheckpoint("history_persisted")
      ? "persisted checkpoints prove verified Preflight, prepared patch, validation, resolution, and required protection history"
      : "canonical protection lifecycle transitions and required history are not fully proven",
    hasTopologyCheckpoint("preflight_persisted") &&
      hasTopologyCheckpoint("remediation_persisted") &&
      hasTopologyCheckpoint("validation_persisted") &&
      hasTopologyCheckpoint("resolution_persisted") &&
      hasTopologyCheckpoint("history_persisted"),
  ],
  [
    "RESOLUTION",
    hasTopologyCheckpoint("resolution_persisted")
      ? "checkpoint proves the authenticated resolution RPC returned the same persisted resolution on retry"
      : "normal lifecycle resolution has not completed with idempotent persistence",
    hasTopologyCheckpoint("resolution_persisted"),
  ],
  [
    "HISTORY",
    hasTopologyCheckpoint("history_persisted")
      ? "checkpoint proves required change-to-resolution protection history remains linked to customer impact"
      : "retained lifecycle, evidence, remediation and validation history are not yet verified",
    hasTopologyCheckpoint("history_persisted"),
  ],
  [
    "RETRY_CRASH_RECOVERY",
    hasTopologyCheckpoint("retry_crash_recovery_persisted")
      ? "real Trigger attempts failed after canonical proposal/patch and validation commits, retried from persisted terminal state, and resolution replay returned the same identity"
      : "post-commit Trigger retry and resolution recovery were not proven through persisted worker outcomes",
    hasTopologyCheckpoint("retry_crash_recovery_persisted"),
  ],
  [
    "POSTGRES_CONCURRENCY",
    postgresConcurrencyPassed
      ? "six independent local PostgreSQL sessions synchronized at canonical workspace-lock barriers proved single-winner Preflight, remediation, and validation claims plus idempotent product and resolution races"
      : coreConcurrencyCheckpoint
        ? `product-idempotency and resolution races passed, but independent eligible Preflight/remediation/validation single-winner claim races and lock behavior are not all proven${Array.isArray(claimConcurrencyFailureCheckpoint?.failureCodes) ? `; claim failures=${claimConcurrencyFailureCheckpoint.failureCodes.join(",")}` : ""}`
        : "independent PostgreSQL backend sessions have not proven the required product, Preflight, remediation, validation, lifecycle, and resolution races",
    postgresConcurrencyPassed,
  ],
] as const) {
  record(name, stageOk, detail);
}

const duplicateDeliveryCheckpoint = productTopologyProgress.records.find(
  (record) => record.status === "stage_duplicate_delivery_idempotency_persisted",
);
const duplicateDeliveryProof = productTopologyReport.ok
  ? productTopologyReport.proof?.duplicateDeliveryProof
  : null;
const remediationDuplicateDeliveryPassed = Boolean(
  duplicateDeliveryCheckpoint?.eachDeliveryExecutedByWorker === true &&
  duplicateDeliveryCheckpoint.noDuplicateLogicalWork === true &&
  Array.isArray(duplicateDeliveryCheckpoint.remediationRunIds) &&
  duplicateDeliveryCheckpoint.remediationRunIds.length === 2 &&
  duplicateDeliveryCheckpoint.proposalCount === 1 &&
  (duplicateDeliveryProof?.remediation?.taskId === "prepare-remediation" ||
    duplicateDeliveryCheckpoint.status === "stage_duplicate_delivery_idempotency_persisted"),
);
const validationDuplicateDeliveryPassed = Boolean(
  duplicateDeliveryCheckpoint?.eachDeliveryExecutedByWorker === true &&
  duplicateDeliveryCheckpoint.noDuplicateLogicalWork === true &&
  Array.isArray(duplicateDeliveryCheckpoint.validationRunIds) &&
  duplicateDeliveryCheckpoint.validationRunIds.length === 2 &&
  duplicateDeliveryCheckpoint.validationAttemptCount === 1 &&
  (duplicateDeliveryProof?.validation?.taskId === "validate-remediation" ||
    duplicateDeliveryCheckpoint.status === "stage_duplicate_delivery_idempotency_persisted"),
);
record(
  "REMEDIATION_IDEMPOTENCY",
  remediationDuplicateDeliveryPassed,
  remediationDuplicateDeliveryPassed
    ? "two distinct Trigger Development prepare-remediation deliveries executed for one completed queue identity and reconciled to one canonical proposal"
    : "two real remediation task deliveries did not prove one canonical proposal",
);
record(
  "ASYNC_REMEDIATION_RETRY_IDEMPOTENCY",
  validationDuplicateDeliveryPassed,
  validationDuplicateDeliveryPassed
    ? "two distinct Trigger Development validate-remediation deliveries executed for one validated queue identity and retained one canonical validation attempt"
    : "two real validation task deliveries did not prove one canonical validation attempt",
);

const passed = stages.filter((stage) => stage.status === "PASS").length;
const failed = stages.length - passed;
process.stdout.write(
  `${JSON.stringify(
    { acceptance: failed === 0 ? "PASS" : "FAIL", passed, failed, stages, supportingChecks },
    null,
    2,
  )}\n`,
);
if (failed > 0) process.exitCode = 1;
