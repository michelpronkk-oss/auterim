import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { access, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  forwardAcceptedObservation,
  forwardRunStatusObservations,
  isSuccessfulCompletedRun,
  TRIGGER_AUTH_PROBE_BUDGET_MS,
  TRIGGER_WORKER_READINESS_BUDGET_MS,
  TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS,
} from "./roundtrip-observability.mts";

const repoRoot = path.resolve(process.cwd());
const expectedRoot = path.resolve("C:/Users/miche/Desktop/Auterim");
const workdir = path.join(repoRoot, "node_modules", ".cache", "m15-local");
const supabaseWorkdir = path.join(workdir, "supabase");
const envPath = path.join(workdir, "trigger-worker.env");
const localCredentialsPath = path.join(workdir, "local-supabase.json");
const localCredentialsMarker = "AUTERIM_M15_LOCAL_SUPABASE_V1";
const expectedProject = "proj_hwqtxtyrvwykjirkrdoh";
const triggerCliVersion = "4.7.2";
const originalDiagnosticTaskId = "m15-local-acceptance-round-trip";
const diagnosticTaskId = originalDiagnosticTaskId;
const expectedQueueConfiguration = "legacy_v1_concurrency_limit_1";
let entitlementRecovery:
  | {
      npm: string;
      safeEnv: NodeJS.ProcessEnv;
      secret: string;
      local: { apiUrl: string; publishableKey: string; serviceKey: string };
      fixtureId: string;
      round: "core" | "stale";
    }
  | undefined;

function fail(code: string): never {
  throw new Error(code);
}

function startupFailureCategory(output: string) {
  const value = output.toLowerCase();
  if (/login|auth|credential|unauthorized|forbidden/.test(value)) return "authentication";
  if (/project.{0,40}(not found|invalid|unauthorized)|not authorized.{0,40}project/.test(value)) {
    return "project_access";
  }
  if (/cannot find module|module not found|build failed|build error/.test(value)) return "build";
  if (/config.{0,40}(invalid|error|not found)|failed to load config/.test(value))
    return "configuration";
  if (/error|failed/.test(value)) return "worker_start_error";
  return "worker_exited_without_ready_signal";
}

function safeStartupDiagnostic(output: string) {
  return output
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .filter((line) =>
      /error|fail|warn|auth|project|connect|worker|ready|build|task|login/i.test(line),
    )
    .slice(-20)
    .map((line) =>
      line
        .replace(/(key|token|secret)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]")
        .replace(/tr_(?:dev|prod|stg|preview)_sk_[A-Za-z0-9_-]+/gi, "[redacted]")
        .replace(/\b(?:sb_secret_|sb_publishable_)[A-Za-z0-9_-]+/gi, "[redacted]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/eyJ[A-Za-z0-9._-]{30,}/g, "[redacted]")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
        .replace(/https?:\/\/[^\s?]+\?[^\s]*/gi, "[url]"),
    )
    .join(" | ")
    .slice(0, 1_200);
}

function waitForWorkerReady(
  child: ChildProcess,
  getOutput: () => string,
  requirePresence: boolean,
  budgetMs = TRIGGER_WORKER_READINESS_BUDGET_MS,
  getReadinessEvents?: () => Array<{ event: string; observedAt: string }>,
) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearInterval(poll);
      clearTimeout(timeout);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () =>
      finish(
        new Error(
          `trigger_worker_exited_before_ready:${startupFailureCategory(getOutput())}:${safeStartupDiagnostic(getOutput()) || "no_safe_diagnostic"}`,
        ),
      );
    const timeout = setTimeout(
      () =>
        finish(
          new Error(
            `trigger_worker_readiness_timeout:${safeStartupDiagnostic(getOutput()) || "no_safe_diagnostic"}`,
          ),
        ),
      budgetMs,
    );
    const poll = setInterval(() => {
      const output = getOutput();
      const readinessEvents = getReadinessEvents?.();
      const readinessEventNames = new Set(readinessEvents?.map((event) => event.event));
      const lastPresenceEvent = readinessEvents
        ?.filter((event) => ["presence_established", "presence_socket_error"].includes(event.event))
        .at(-1)?.event;
      const eventBasedReady = Boolean(
        readinessEvents &&
        readinessEventNames.has("project_identity") &&
        readinessEventNames.has("task_manifest_indexed") &&
        readinessEventNames.has("worker_ready") &&
        (!requirePresence || lastPresenceEvent === "presence_established"),
      );
      if (
        eventBasedReady ||
        (output.includes(`TRIGGER_PROJECT_REF: '${expectedProject}'`) &&
          /worker manifest indexed/i.test(output) &&
          /Local worker ready on branch:/i.test(output) &&
          (!requirePresence || /Presence connection established/i.test(output)))
      ) {
        finish();
      } else if (child.exitCode !== null) {
        onExit();
      }
    }, 100);
    child.once("exit", onExit);
  });
}

async function registeredTaskIds(output: string) {
  const buildIds = [...output.matchAll(/\bbuild-[A-Za-z0-9_-]+\b/g)];
  const buildId = buildIds.at(-1)?.[0];
  if (!buildId) fail("trigger_worker_manifest_missing");
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      await readFile(path.join(repoRoot, ".trigger", "tmp", buildId, "index.json"), "utf8"),
    );
  } catch {
    fail("trigger_worker_manifest_unavailable");
  }
  const identifiers = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") identifiers.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      Object.values(value).forEach(collect);
    }
  };
  collect(manifest);
  return identifiers;
}

function parseEnv(output: string) {
  const values = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
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
  return values;
}

function triggerDevKey() {
  const file = requireLocalEnvFile();
  const row = file.split(/\r?\n/).find((line) => /^\s*TRIGGER_SECRET_KEY\s*=/.test(line));
  const value = row
    ?.slice(row.indexOf("=") + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (!value?.startsWith("tr_dev_sk_")) fail("development_credential_unproven");
  return value;
}

let localEnvContents: string | undefined;
function requireLocalEnvFile() {
  if (localEnvContents === undefined) fail("local_environment_unavailable");
  return localEnvContents;
}

async function localPersistence() {
  const config = await readFile(path.join(supabaseWorkdir, "config.toml"), "utf8");
  if (
    !config.includes('project_id = "auterim-m15-acceptance"') ||
    !/^port = 65431$/m.test(config)
  ) {
    fail("isolated_supabase_config_mismatch");
  }
  const command = process.platform === "win32" ? "supabase.exe" : "supabase";
  const result = spawnSync(command, ["status", "--workdir", workdir, "--output", "env"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024,
  });
  if (result.error || result.status !== 0) fail("isolated_supabase_status_unavailable");
  const values = parseEnv(result.stdout ?? "");
  const apiUrl = values.get("API_URL") ?? values.get("REST_URL");
  const publishableKey = values.get("PUBLISHABLE_KEY") ?? values.get("ANON_KEY");
  const serviceKey = values.get("SERVICE_ROLE_KEY") ?? values.get("SECRET_KEY");
  if (!apiUrl || !publishableKey || !serviceKey) fail("isolated_supabase_credentials_unavailable");
  if (
    !new Set(["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"]).has(
      new URL(apiUrl).origin,
    )
  ) {
    fail("isolated_supabase_target_forbidden");
  }
  return { apiUrl, publishableKey, serviceKey };
}

function safeProcessEnvironment() {
  const safe: NodeJS.ProcessEnv = { NODE_ENV: "development" };
  for (const key of [
    "PATH",
    "Path",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "USERDOMAIN",
    "USERNAME",
    "OS",
    "PROCESSOR_ARCHITECTURE",
    "PROCESSOR_IDENTIFIER",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ]) {
    if (process.env[key]) safe[key] = process.env[key];
  }
  safe.NEXT_TELEMETRY_DISABLED = "1";
  safe.TRIGGER_TELEMETRY_DISABLED = "1";
  return safe;
}

function runEntitlementTestPhase(input: {
  npm: string;
  safeEnv: NodeJS.ProcessEnv;
  secret: string;
  local: { publishableKey: string; serviceKey: string };
  phase: "prepare" | "execute" | "cleanup";
  round: "core" | "stale";
  fixtureId: string;
  coreCheckpointPath?: string;
}) {
  const phaseEnv: NodeJS.ProcessEnv = {
    ...input.safeEnv,
    AUTERIM_M15_ENTITLEMENT_PHASE: input.phase,
    AUTERIM_M15_ENTITLEMENT_ROUND: input.round,
    AUTERIM_M15_ENTITLEMENT_FIXTURE_ID: input.fixtureId,
  };
  if (input.coreCheckpointPath) {
    phaseEnv.AUTERIM_M15_ENTITLEMENT_CORE_CHECKPOINT_PATH = input.coreCheckpointPath;
  }
  if (input.phase !== "execute") {
    delete phaseEnv.TRIGGER_SECRET_KEY;
  }
  const result = spawnSync(
    input.npm,
    ["vitest", "run", "tests/m15-entitlement-matrix.integration.test.ts"],
    {
      cwd: repoRoot,
      env: phaseEnv,
      encoding: "utf8",
      timeout: input.phase === "prepare" ? 240_000 : input.phase === "cleanup" ? 120_000 : 600_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      shell: process.platform === "win32",
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .replaceAll(input.secret, "[redacted]")
    .replaceAll(input.local.publishableKey, "[redacted]")
    .replaceAll(input.local.serviceKey, "[redacted]")
    .replace(/tr_(?:dev|prod|stg|preview)_sk_[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9._-]{30,}/g, "[redacted]");
  return {
    status: result.status,
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
    output,
  };
}

function safeEntitlementMarker(output: string, marker: string) {
  const line = output.match(new RegExp(`^${marker}=(\\{[^\\r\\n]+\\})$`, "m"))?.[1];
  if (!line) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function safeEntitlementPreparationSummary(output: string) {
  const marker = safeEntitlementMarker(output, "M15_ENTITLEMENT_FIXTURE_PREPARED");
  return {
    markerSeen: output.includes("M15_ENTITLEMENT_FIXTURE_PREPARED="),
    complete: marker?.complete === true,
    round: typeof marker?.round === "string" ? marker.round : null,
    phase: typeof marker?.phase === "string" ? marker.phase : null,
    workerState: typeof marker?.workerState === "string" ? marker.workerState : null,
    localFixturePath: isLocalAcceptanceArtifact(marker?.fixturePath),
    caseCount: Array.isArray(marker?.cases) ? marker.cases.length : null,
    testSummary: output
      .replace(/\u001b\[[0-9;]*m/g, "")
      .split(/\r?\n/)
      .filter((line) => /Test Files\s+\d+|Tests\s+\d+|skipped/.test(line))
      .slice(-4)
      .map((line) => line.slice(0, 240)),
  };
}

function isLocalAcceptanceArtifact(value: unknown) {
  if (typeof value !== "string") return false;
  const resolved = path.resolve(value).toLowerCase();
  const expectedCache = path.join(repoRoot, "node_modules", ".cache", "m15-local").toLowerCase();
  return resolved.startsWith(`${expectedCache}${path.sep}`.toLowerCase());
}

function provenEntitlementCases(value: unknown, expectedCount: number) {
  if (!Array.isArray(value) || value.length !== expectedCount) return undefined;
  const cases = value.filter(
    (item): item is { name: string; status: "proven"; queueId: string; triggerRunId: string } =>
      Boolean(
        item &&
        typeof item === "object" &&
        "name" in item &&
        typeof item.name === "string" &&
        "status" in item &&
        item.status === "proven" &&
        "queueId" in item &&
        typeof item.queueId === "string" &&
        /^[0-9a-f-]{36}$/i.test(item.queueId) &&
        "triggerRunId" in item &&
        typeof item.triggerRunId === "string" &&
        /^run_[A-Za-z0-9_-]+$/.test(item.triggerRunId),
      ),
  );
  if (
    cases.length !== expectedCount ||
    new Set(cases.map((item) => item.name)).size !== expectedCount ||
    new Set(cases.map((item) => item.queueId)).size !== expectedCount ||
    new Set(cases.map((item) => item.triggerRunId)).size !== expectedCount
  ) {
    return undefined;
  }
  return cases;
}

function validateEntitlementPreparation(
  output: string,
  input: {
    round: "core" | "stale";
    fixtureId: string;
    coreCheckpointPath?: string;
  },
) {
  const prepared = safeEntitlementMarker(output, "M15_ENTITLEMENT_FIXTURE_PREPARED");
  const expectedCount = input.round === "core" ? 6 : 1;
  const preparedCases = Array.isArray(prepared?.cases) ? prepared.cases : [];
  const validCases = preparedCases.filter((item): item is { name: string; queueId: string } =>
    Boolean(
      item &&
      typeof item === "object" &&
      "name" in item &&
      typeof item.name === "string" &&
      /^[a-z][a-z0-9_]{0,63}$/.test(item.name) &&
      "queueId" in item &&
      typeof item.queueId === "string" &&
      /^[0-9a-f-]{36}$/i.test(item.queueId) &&
      "queueStatus" in item &&
      item.queueStatus === "queued" &&
      "statePrepared" in item &&
      item.statePrepared === true,
    ),
  );
  if (
    prepared?.complete !== true ||
    prepared.phase !== (input.round === "core" ? "core_prepare" : "stale_prepare") ||
    prepared.fixtureId !== input.fixtureId ||
    prepared.workerState !== "stopped" ||
    !isLocalAcceptanceArtifact(prepared.fixturePath) ||
    !Array.isArray(prepared.cases) ||
    prepared.cases.length !== expectedCount ||
    validCases.length !== expectedCount ||
    new Set(validCases.map((item) => item.name)).size !== expectedCount ||
    new Set(validCases.map((item) => item.queueId)).size !== expectedCount ||
    (input.round === "stale" &&
      (prepared.coreCheckpointPath !== input.coreCheckpointPath ||
        !isLocalAcceptanceArtifact(prepared.coreCheckpointPath)))
  ) {
    return undefined;
  }
  return {
    checkpointPath: prepared.fixturePath as string,
    coreCheckpointPath: prepared.coreCheckpointPath as string | undefined,
    cases: validCases,
  };
}

function assertNoAuterimDevWorker() {
  if (process.platform !== "win32") fail("trigger_dev_worker_process_check_unsupported");
  const command = [
    "$filter = \"CommandLine LIKE '%proj_hwqtxtyrvwykjirkrdoh%'\"",
    "$rows = Get-CimInstance Win32_Process -Filter $filter | Where-Object { $_.CommandLine -match 'trigger\\.dev' -and $_.CommandLine -match '\\bdev\\s+start\\b' }",
    "if ($rows) { exit 17 }",
    "exit 0",
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
      maxBuffer: 8_192,
    },
  );
  if (result.error || result.status === null) fail("trigger_dev_worker_process_check_failed");
  if (result.status === 17) fail("trigger_dev_worker_already_running");
  if (result.status !== 0) fail("trigger_dev_worker_process_check_failed");
}

async function runEntitlementWorkerRound(input: {
  npm: string;
  safeEnv: NodeJS.ProcessEnv;
  secret: string;
  local: { apiUrl: string; publishableKey: string; serviceKey: string };
  round: "core" | "stale";
  fixtureId: string;
  coreCheckpointPath?: string;
}) {
  assertNoAuterimDevWorker();
  const child = spawn(
    input.npm,
    [
      "--yes",
      `trigger.dev@${triggerCliVersion}`,
      "dev",
      "start",
      "--config",
      "trigger.m15-local.config.ts",
      "--project-ref",
      expectedProject,
      "--skip-update-check",
      "--skip-telemetry",
      "--log-level",
      "debug",
    ],
    {
      cwd: repoRoot,
      env: input.safeEnv,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();
  let workerOutput = "";
  const workerEvents: Array<{ event: string; observedAt: string }> = [];
  let workerLogRemainder = "";
  const captureWorker = (chunk: Buffer) => {
    const text = chunk
      .toString("utf8")
      .replaceAll(input.secret, "[redacted]")
      .replaceAll(input.local.publishableKey, "[redacted]")
      .replaceAll(input.local.serviceKey, "[redacted]")
      .replace(/tr_(?:dev|prod|stg|preview)_sk_[A-Za-z0-9_-]+/gi, "[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/eyJ[A-Za-z0-9._-]{30,}/g, "[redacted]");
    workerOutput = `${workerOutput}${text}`.slice(-32_000);
    workerLogRemainder += text;
    const lines = workerLogRemainder.split(/\r?\n/);
    workerLogRemainder = lines.pop() ?? "";
    for (const line of lines) {
      const event = line.includes(`TRIGGER_PROJECT_REF: '${expectedProject}'`)
        ? "project_identity"
        : /worker manifest indexed/i.test(line)
          ? "task_manifest_indexed"
          : /Local worker ready on branch:/i.test(line)
            ? "worker_ready"
            : /Presence connection error/i.test(line)
              ? "presence_socket_error"
              : /Presence connection established/i.test(line)
                ? "presence_established"
                : undefined;
      if (event) workerEvents.push({ event, observedAt: new Date().toISOString() });
      const taskOutcome = line.match(
        /AUTERIM_M15_TASK_OUTCOME task=(prepare-remediation|validate-remediation) runId=(run_[A-Za-z0-9_-]+) queueId=([0-9a-f-]{36}) queueAttempt=(\d+) triggerAttempt=(\d+) outcome=([a-z0-9_]{1,40})/,
      );
      if (taskOutcome) {
        const outcome = {
          event: "product_task_outcome",
          observedAt: new Date().toISOString(),
          runId: taskOutcome[2],
          taskId: taskOutcome[1],
          queueId: taskOutcome[3],
          queueAttempt: Number(taskOutcome[4]),
          triggerAttempt: Number(taskOutcome[5]),
          outcome: taskOutcome[6],
        };
        try {
          appendFileSync(
            path.join(workdir, "task-outcomes.jsonl"),
            `${JSON.stringify(outcome)}\n`,
            { mode: 0o600 },
          );
        } catch {
          // The test fails closed if the exact worker outcome cannot be persisted locally.
        }
      }
    }
  };
  child.stdout?.on("data", captureWorker);
  child.stderr?.on("data", captureWorker);

  try {
    try {
      await waitForWorkerReady(
        child,
        () => workerOutput,
        true,
        60_000,
        () => workerEvents,
      );
    } catch (error) {
      const diagnostic = {
        round: input.round,
        fixtureId: input.fixtureId,
        failedAt: new Date().toISOString(),
        failure:
          error instanceof Error ? error.message.split(":", 1)[0] : "worker_readiness_failed",
        events: workerEvents,
        safeLogSummary: safeStartupDiagnostic(workerOutput) || "no_matching_startup_lines",
      };
      const diagnosticPath = path.join(
        workdir,
        `entitlement-worker-startup-${input.fixtureId}-${input.round}.json`,
      );
      const diagnosticFile = await open(diagnosticPath, "wx", 0o600);
      try {
        await diagnosticFile.writeFile(`${JSON.stringify(diagnostic)}\n`, "utf8");
        await diagnosticFile.sync();
      } finally {
        await diagnosticFile.close();
      }
      process.stderr.write(
        `M15_ENTITLEMENT_WORKER_STARTUP_FAILURE=${JSON.stringify({ ...diagnostic, diagnosticPath })}\n`,
      );
      throw error;
    }
    if (!workerOutput.includes(`TRIGGER_PROJECT_REF: '${expectedProject}'`)) {
      fail("trigger_worker_project_identity_unproven");
    }
    const taskIds = await registeredTaskIds(workerOutput);
    const requiredTasks =
      input.round === "core"
        ? ["dispatch-remediation-preparation", "prepare-remediation"]
        : [
            "dispatch-remediation-preparation",
            "prepare-remediation",
            "dispatch-remediation-validation",
            "validate-remediation",
          ];
    if (requiredTasks.some((taskId) => !taskIds.has(taskId))) {
      fail(`trigger_worker_${input.round}_task_manifest_incomplete`);
    }

    const execute = spawn(
      input.npm,
      ["vitest", "run", "tests/m15-entitlement-matrix.integration.test.ts"],
      {
        cwd: repoRoot,
        env: {
          ...input.safeEnv,
          AUTERIM_M15_ENTITLEMENT_PHASE: "execute",
          AUTERIM_M15_ENTITLEMENT_ROUND: input.round,
          AUTERIM_M15_ENTITLEMENT_FIXTURE_ID: input.fixtureId,
          ...(input.coreCheckpointPath
            ? { AUTERIM_M15_ENTITLEMENT_CORE_CHECKPOINT_PATH: input.coreCheckpointPath }
            : {}),
        },
        windowsHide: true,
        shell: process.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let testOutput = "";
    const captureTest = (chunk: Buffer) => {
      testOutput = `${testOutput}${chunk
        .toString("utf8")
        .replaceAll(input.secret, "[redacted]")
        .replaceAll(input.local.publishableKey, "[redacted]")
        .replaceAll(input.local.serviceKey, "[redacted]")
        .replace(/tr_(?:dev|prod|stg|preview)_sk_[A-Za-z0-9_-]+/gi, "[redacted]")
        .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
        .replace(/eyJ[A-Za-z0-9._-]{30,}/g, "[redacted]")}`.slice(-32_000);
    };
    execute.stdout?.on("data", captureTest);
    execute.stderr?.on("data", captureTest);
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline && execute.exitCode === null && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (execute.exitCode === null) await stopProcess(execute);
    if (child.exitCode !== null || execute.exitCode !== 0) {
      const safeLines = testOutput
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .filter((line) => /M15_ENTITLEMENT|m15_entitlement|FAIL\s+tests\/|Error:/i.test(line))
        .slice(-10)
        .join(" | ")
        .slice(0, 1_000);
      if (safeLines) {
        process.stderr.write(`M15_ENTITLEMENT_${input.round.toUpperCase()}_FAILURE=${safeLines}\n`);
      }
      fail(
        child.exitCode !== null
          ? `trigger_worker_exited_during_${input.round}_entitlement_matrix`
          : execute.exitCode === null
            ? `${input.round}_entitlement_matrix_runtime_timeout`
            : `${input.round}_entitlement_matrix_test_failed`,
      );
    }

    const markerName =
      input.round === "core" ? "M15_ENTITLEMENT_CORE_MATRIX" : "M15_ENTITLEMENT_STALE_MATRIX";
    const checkpoint = safeEntitlementMarker(testOutput, markerName);
    const count = input.round === "core" ? 6 : 1;
    const cases = provenEntitlementCases(checkpoint?.cases, count);
    if (
      checkpoint?.complete !== true ||
      checkpoint.fixtureId !== input.fixtureId ||
      !isLocalAcceptanceArtifact(checkpoint.checkpointPath) ||
      !cases ||
      (input.round === "stale" &&
        (checkpoint.coreCheckpointPath !== input.coreCheckpointPath ||
          !isLocalAcceptanceArtifact(checkpoint.coreCheckpointPath)))
    ) {
      fail(`${input.round}_entitlement_checkpoint_invalid`);
    }
    return {
      round: input.round,
      fixtureId: input.fixtureId,
      checkpointPath: checkpoint.checkpointPath as string,
      coreCheckpointPath: input.coreCheckpointPath,
      cases,
      workerEvents,
      registeredTasks: requiredTasks,
    };
  } finally {
    await stopProcess(child);
    assertNoAuterimDevWorker();
  }
}

async function stopProcess(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], {
      cwd: repoRoot,
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  if (repoRoot.toLowerCase() !== expectedRoot.toLowerCase()) fail("auterim_workdir_required");
  let entitlementFixtureId: string | undefined;
  if (process.argv.includes("--entitlements-only")) {
    try {
      await access(path.join(repoRoot, "tests", "m15-entitlement-matrix.integration.test.ts"));
    } catch {
      fail("entitlement_matrix_integration_test_missing");
    }
  }
  // Remove any plaintext credential file left by an interrupted older launcher version.
  await rm(envPath, { force: true });
  // Recover only our own local Supabase credential file after an interrupted guarded run.
  try {
    const existingLocalCredentials = JSON.parse(await readFile(localCredentialsPath, "utf8")) as {
      marker?: unknown;
    };
    if (existingLocalCredentials.marker !== localCredentialsMarker) {
      fail("m15_local_supabase_credentials_conflict");
    }
    await rm(localCredentialsPath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const triggerConfig = await readFile(path.join(repoRoot, "trigger.config.ts"), "utf8");
  if (!new RegExp(`project\\s*:\\s*["']${expectedProject}["']`).test(triggerConfig)) {
    fail("trigger_project_mismatch");
  }
  if (!/dirs\s*:\s*\[\s*["']\.\/src\/trigger["']\s*\]/m.test(triggerConfig)) {
    fail("production_trigger_manifest_not_isolated");
  }
  const localTriggerConfig = await readFile(
    path.join(repoRoot, "trigger.m15-local.config.ts"),
    "utf8",
  );
  if (
    !new RegExp(`project\\s*:\\s*["']${expectedProject}["']`).test(localTriggerConfig) ||
    !/dirs\s*:\s*\[\s*["']\.\/src\/trigger["']\s*,\s*["']\.\/src\/trigger-m15-local["']\s*\]/m.test(
      localTriggerConfig,
    )
  ) {
    fail("local_trigger_manifest_mismatch");
  }
  if (triggerCliVersion !== "4.7.2") fail("trigger_cli_sdk_version_mismatch");
  localEnvContents = await readFile(path.join(repoRoot, ".env.local"), "utf8");
  const secret = triggerDevKey();
  const local = await localPersistence();

  await mkdir(workdir, { recursive: true });

  const safeEnv = safeProcessEnvironment();
  safeEnv.AUTERIM_M15_LOCAL_INTEGRATION = "1";
  if (process.argv.includes("--real-preflight") || process.argv.includes("--entitlements-only")) {
    safeEnv.AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES = "1";
    safeEnv.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE = "1";
    safeEnv.AUTERIM_M15_LOCAL_ACCEPTANCE_POSTWORK_GATE = "1";
    safeEnv.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY = "1";
    if (process.argv.includes("--real-preflight")) {
      safeEnv.AUTERIM_M15_LOCAL_ACCEPTANCE_POST_COMMIT_RETRY = "1";
    }
  }
  safeEnv.AUTERIM_M15_LOCAL_REPO_ROOT = repoRoot;
  safeEnv.NEXT_PUBLIC_SUPABASE_URL = local.apiUrl;
  safeEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = local.publishableKey;
  safeEnv.SUPABASE_SECRET_KEY = local.serviceKey;
  safeEnv.AUTERIM_M15_LOCAL_SUPABASE_URL = local.apiUrl;
  safeEnv.AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY = local.serviceKey;
  safeEnv.TRIGGER_SECRET_KEY = secret;
  delete safeEnv.TRIGGER_ACCESS_TOKEN;
  const hostedSupabaseOrigin = "https://lnljaacbptrubppoypaz.supabase.co";
  const localOrigin = new URL(local.apiUrl).origin;
  const forbiddenRoutingVariables = [
    "TRIGGER_VERSION",
    "TRIGGER_EXTERNAL_DEPLOYMENT_ID",
    "TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION",
    "VERCEL_GIT_COMMIT_SHA",
  ];
  if (
    safeEnv.AUTERIM_M15_LOCAL_INTEGRATION !== "1" ||
    safeEnv.AUTERIM_M15_LOCAL_REPO_ROOT?.toLowerCase() !== expectedRoot.toLowerCase() ||
    safeEnv.NEXT_PUBLIC_SUPABASE_URL !== local.apiUrl ||
    !new Set(["http://127.0.0.1:65431", "http://localhost:65431", "http://[::1]:65431"]).has(
      localOrigin,
    ) ||
    localOrigin === hostedSupabaseOrigin ||
    !safeEnv.TRIGGER_SECRET_KEY.startsWith("tr_dev_sk_") ||
    forbiddenRoutingVariables.some((key) => safeEnv[key] !== undefined) ||
    safeEnv.SUPABASE_URL !== undefined ||
    safeEnv.SUPABASE_SERVICE_ROLE_KEY !== undefined
  ) {
    fail("worker_local_environment_mismatch");
  }
  const npm = process.platform === "win32" ? "npx.cmd" : "npx";
  const cleanupFixtureIndex = process.argv.indexOf("--cleanup-entitlement-fixture");
  if (cleanupFixtureIndex >= 0) {
    const fixtureId = process.argv[cleanupFixtureIndex + 1];
    if (!fixtureId || !/^[0-9a-f-]{36}$/i.test(fixtureId)) {
      fail("entitlement_fixture_identity_invalid");
    }
    assertNoAuterimDevWorker();
    safeEnv.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE = "1";
    safeEnv.AUTERIM_M15_LOCAL_ACCEPTANCE_POSTWORK_GATE = "1";
    safeEnv.AUTERIM_M15_REAL_TRIGGER_TOPOLOGY = "1";
    const cleanup = runEntitlementTestPhase({
      npm,
      safeEnv,
      secret,
      local,
      phase: "cleanup",
      round: "core",
      fixtureId,
    });
    if (cleanup.status !== 0) fail("entitlement_fixture_cleanup_failed");
    process.stdout.write(
      `${JSON.stringify({ fixtureId, cleanup: "complete", persistence: "isolated-local-supabase" })}\n`,
    );
    return;
  }
  const authDiagnosticOnly = process.argv.includes("--diagnose-sdk-auth-only");
  const authRetrieveOnly = process.argv.includes("--diagnose-sdk-retrieve-only");
  const authRetrieveRunId = "run_06ghbrgb9k9jvhqihrd7h0lp01";
  const authProbeArgs = authRetrieveOnly
    ? [`--retrieve-run-id=${authRetrieveRunId}`, "--official-client"]
    : authDiagnosticOnly
      ? ["--official-client"]
      : [`--retrieve-run-id=${authRetrieveRunId}`];
  const authProbe = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "scripts/m15-validation/probe-trigger-sdk-auth.mts",
      ...authProbeArgs,
    ],
    {
      cwd: repoRoot,
      env: safeEnv,
      encoding: "utf8",
      timeout: TRIGGER_AUTH_PROBE_BUDGET_MS,
      windowsHide: true,
      maxBuffer: 16_384,
    },
  );
  const authOutput = `${authProbe.stdout ?? ""}\n${authProbe.stderr ?? ""}`.trim();
  if (authProbe.error) {
    const code = (authProbe.error as NodeJS.ErrnoException).code?.toLowerCase();
    fail(code ? `trigger_sdk_auth_probe_${code}` : "trigger_sdk_auth_probe_failed");
  }
  const authProbeRows = authOutput.split(/\r?\n/).flatMap((line) => {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      return typeof row.status === "string" ? [row] : [];
    } catch {
      return [];
    }
  });
  if (authRetrieveOnly) {
    process.stdout.write(
      `${JSON.stringify({
        status: "sdk_auth_retrieve_diagnostic_complete",
        projectRef: expectedProject,
        environment: "development",
        credentialSource: "Auterim/.env.local/TRIGGER_SECRET_KEY",
        exactRunId: authRetrieveRunId,
        globalSdk: authProbeRows[0] ?? { status: "SDK_NO_RESULT" },
        triggerClient: authProbeRows[1] ?? { status: "OFFICIAL_CLIENT_NO_RESULT" },
      })}\n`,
    );
    return;
  }
  if (authDiagnosticOnly) {
    process.stdout.write(
      `${JSON.stringify({
        status: "sdk_auth_diagnostic_complete",
        projectRef: expectedProject,
        environment: "development",
        credentialSource: "Auterim/.env.local/TRIGGER_SECRET_KEY",
        existingProbe: authProbeRows[0] ?? { status: "SDK_AUTH_PROBE_NO_RESULT" },
        officialClient: authProbeRows[1] ?? { status: "OFFICIAL_CLIENT_NO_RESULT" },
      })}\n`,
    );
    return;
  }
  const existingAuthResult = authProbeRows[0];
  if (authProbe.status !== 0 || existingAuthResult?.status !== "RETRIEVE_VALID") {
    const safeStatus =
      typeof existingAuthResult?.status === "string" &&
      /^SDK_[A-Z_]+$/.test(existingAuthResult.status)
        ? existingAuthResult.status
        : `trigger_sdk_auth_probe_exit_${String(authProbe.status ?? "unknown")}`;
    fail(safeStatus);
  }
  process.stdout.write(
    `${JSON.stringify({
      status: "development_sdk_auth_validated",
      projectRef: expectedProject,
      environment: "development",
      operation: "read_only_exact_run_retrieve",
      exactRunId: authRetrieveRunId,
      runStatus: existingAuthResult.runStatus,
    })}\n`,
  );
  if (process.argv.includes("--validate-sdk-auth-only")) {
    return;
  }
  if (process.argv.includes("--entitlements-only")) {
    assertNoAuterimDevWorker();
    const fixtureId = randomUUID();
    entitlementRecovery = { npm, safeEnv, secret, local, fixtureId, round: "core" };
    const corePreparation = runEntitlementTestPhase({
      npm,
      safeEnv,
      secret,
      local,
      phase: "prepare",
      round: "core",
      fixtureId,
    });
    if (corePreparation.status !== 0) {
      const safeLines = corePreparation.output
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .filter((line) => /M15_ENTITLEMENT|m15_entitlement|FAIL\s+tests\/|Error:/i.test(line))
        .slice(-10)
        .join(" | ")
        .slice(0, 1_000);
      if (safeLines) process.stderr.write(`M15_ENTITLEMENT_CORE_PREP_FAILURE=${safeLines}\n`);
      fail(
        `core_entitlement_fixture_prepare_failed:${corePreparation.errorCode ?? corePreparation.status}`,
      );
    }
    const preparedCore = validateEntitlementPreparation(corePreparation.output, {
      round: "core",
      fixtureId,
    });
    const expectedCoreNames = new Set([
      "allowed_pro_execution",
      "subscription_downgraded",
      "subscription_expired",
      "product_archived",
      "dependency_disabled",
      "preflight_superseded",
    ]);
    if (
      !preparedCore ||
      new Set(preparedCore.cases.map((item) => item.name)).size !== expectedCoreNames.size ||
      preparedCore.cases.some((item) => !expectedCoreNames.has(item.name))
    ) {
      process.stderr.write(
        `M15_ENTITLEMENT_PREP_SUMMARY=${JSON.stringify(safeEntitlementPreparationSummary(corePreparation.output))}\n`,
      );
      fail("core_entitlement_fixture_prepare_marker_invalid");
    }

    const coreResult = await runEntitlementWorkerRound({
      npm,
      safeEnv,
      secret,
      local,
      round: "core",
      fixtureId,
    });
    if (
      coreResult.cases.length !== 6 ||
      coreResult.cases.some((item) => !expectedCoreNames.has(item.name)) ||
      new Set(coreResult.cases.map((item) => item.name)).size !== 6
    ) {
      fail("core_entitlement_six_case_result_invalid");
    }

    let persistedCore: Record<string, unknown>;
    try {
      persistedCore = JSON.parse(await readFile(coreResult.checkpointPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      fail("core_entitlement_checkpoint_unreadable");
    }
    const persistedCoreCases = provenEntitlementCases(persistedCore.cases, 6);
    if (
      persistedCore.fixtureId !== fixtureId ||
      persistedCore.stage !== "six" ||
      !persistedCoreCases ||
      persistedCoreCases.some(
        (item, index) =>
          item.name !== coreResult.cases[index]?.name ||
          item.queueId !== coreResult.cases[index]?.queueId ||
          item.triggerRunId !== coreResult.cases[index]?.triggerRunId,
      )
    ) {
      fail("core_entitlement_persisted_checkpoint_mismatch");
    }

    assertNoAuterimDevWorker();
    const stalePreparation = runEntitlementTestPhase({
      npm,
      safeEnv,
      secret,
      local,
      phase: "prepare",
      round: "stale",
      fixtureId,
      coreCheckpointPath: coreResult.checkpointPath,
    });
    if (stalePreparation.status !== 0) {
      const safeLines = stalePreparation.output
        .replace(/\u001b\[[0-9;]*m/g, "")
        .split(/\r?\n/)
        .filter((line) => /M15_ENTITLEMENT|m15_entitlement|FAIL\s+tests\/|Error:/i.test(line))
        .slice(-10)
        .join(" | ")
        .slice(0, 1_000);
      if (safeLines) process.stderr.write(`M15_ENTITLEMENT_STALE_PREP_FAILURE=${safeLines}\n`);
      fail(
        `stale_entitlement_fixture_prepare_failed:${stalePreparation.errorCode ?? stalePreparation.status}`,
      );
    }
    const preparedStale = validateEntitlementPreparation(stalePreparation.output, {
      round: "stale",
      fixtureId,
      coreCheckpointPath: coreResult.checkpointPath,
    });
    if (!preparedStale || preparedStale.cases.length !== 1) {
      fail("stale_entitlement_fixture_prepare_marker_invalid");
    }
    if (preparedStale.cases[0]?.name !== "stale_validation_work") {
      fail("stale_entitlement_case_identity_invalid");
    }
    entitlementRecovery.round = "stale";

    const staleResult = await runEntitlementWorkerRound({
      npm,
      safeEnv,
      secret,
      local,
      round: "stale",
      fixtureId,
      coreCheckpointPath: coreResult.checkpointPath,
    });
    const aggregateCases = [...coreResult.cases, ...staleResult.cases];
    if (
      aggregateCases.length !== 7 ||
      new Set(aggregateCases.map((item) => item.name)).size !== 7 ||
      new Set(aggregateCases.map((item) => item.queueId)).size !== 7 ||
      new Set(aggregateCases.map((item) => item.triggerRunId)).size !== 7
    ) {
      fail("entitlement_matrix_aggregate_not_independent");
    }
    const aggregateCheckpoint = {
      status: "m15_entitlement_matrix_proven",
      fixtureId,
      observedAt: new Date().toISOString(),
      caseCount: aggregateCases.length,
      rounds: [
        {
          round: "core",
          checkpointPath: coreResult.checkpointPath,
          workerEvents: coreResult.workerEvents,
          taskIds: coreResult.registeredTasks,
        },
        {
          round: "stale",
          checkpointPath: staleResult.checkpointPath,
          coreCheckpointPath: coreResult.checkpointPath,
          workerEvents: staleResult.workerEvents,
          taskIds: staleResult.registeredTasks,
        },
      ],
      cases: aggregateCases,
    };
    const aggregatePath = path.join(workdir, `entitlement-matrix-${fixtureId}.json`);
    const aggregateFile = await open(aggregatePath, "wx", 0o600);
    try {
      await aggregateFile.writeFile(`${JSON.stringify(aggregateCheckpoint)}\n`, "utf8");
      await aggregateFile.sync();
    } finally {
      await aggregateFile.close();
    }
    const previousAggregateNames = (await readdir(workdir)).filter(
      (name) =>
        /^entitlement-matrix-[0-9a-f-]{36}\.json$/i.test(name) &&
        name !== path.basename(aggregatePath),
    );
    await Promise.all(
      previousAggregateNames.map((name) => rm(path.join(workdir, name), { force: true })),
    );
    process.stdout.write(
      `M15_ENTITLEMENT_MATRIX=${JSON.stringify({
        complete: true,
        fixtureId,
        checkpointPath: aggregatePath,
        cases: aggregateCases,
      })}\n`,
    );
    entitlementRecovery = undefined;
    return;
  }
  const inspectQueueIndex = process.argv.indexOf("--inspect-queue");
  if (inspectQueueIndex >= 0) {
    const taskId = process.argv[inspectQueueIndex + 1];
    const taskIds =
      taskId === "all-m15"
        ? [
            "dispatch-preflight-queue",
            "run-preflight",
            "dispatch-remediation-preparation",
            "prepare-remediation",
            "dispatch-remediation-validation",
            "validate-remediation",
          ]
        : taskId
          ? [taskId]
          : [];
    if (
      taskIds.length === 0 ||
      taskIds.some(
        (id) =>
          ![
            "dispatch-preflight-queue",
            "run-preflight",
            "dispatch-remediation-preparation",
            "prepare-remediation",
            "dispatch-remediation-validation",
            "validate-remediation",
          ].includes(id),
      )
    ) {
      fail("trigger_task_queue_identity_invalid");
    }
    const inspectionProgram = `
      import { queues } from "@trigger.dev/sdk";
      const taskIds = ${JSON.stringify(taskIds)};
      const results = await Promise.all(taskIds.map(async (taskId) => {
        try {
          const queue = await queues.retrieve({ type: "task", name: taskId });
          return {
            projectRef: ${JSON.stringify(expectedProject)},
            environment: "development",
            taskId,
            id: queue.id,
            name: queue.name,
            type: queue.type,
            version: queue.version,
            paused: queue.paused,
            concurrencyLimit: queue.concurrencyLimit,
            running: queue.running,
            queued: queue.queued,
            concurrency: queue.version === "V1" ? queue.concurrency ?? null : null,
          };
        } catch (error) {
          const value = error && typeof error === "object" ? error : {};
          const status = Number(value.status ?? value.statusCode);
          return {
            projectRef: ${JSON.stringify(expectedProject)},
            environment: "development",
            taskId,
            found: false,
            httpStatus: Number.isFinite(status) ? status : null,
            errorName: typeof value.name === "string" ? value.name : null,
          };
        }
      }));
      const missing = results.filter((item) => "found" in item && item.found === false);
      process.stdout.write(JSON.stringify({ results, missingCount: missing.length }) + "\\n");
      if (missing.length > 0) process.exitCode = 2;
    `;
    const inspection = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", inspectionProgram],
      {
        cwd: repoRoot,
        env: safeEnv,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 16_384,
      },
    );
    const report = (inspection.stdout ?? "").trim().split(/\r?\n/).at(-1);
    if (report && report.includes(`"results"`)) {
      process.stdout.write(`${report}\n`);
    } else {
      process.stdout.write(
        `${JSON.stringify({ projectRef: expectedProject, environment: "development", taskId, found: false, category: "inspection_failed" })}\n`,
      );
    }
    if (inspection.error || inspection.status !== 0) process.exitCode = 1;
    return;
  }
  const cancelRunIndex = process.argv.indexOf("--cancel-run");
  if (cancelRunIndex >= 0) {
    const runId = process.argv[cancelRunIndex + 1];
    const taskIdIndex = process.argv.indexOf("--task-id");
    const taskId = taskIdIndex >= 0 ? process.argv[taskIdIndex + 1] : undefined;
    if (!runId || !/^run_[A-Za-z0-9_-]+$/.test(runId)) fail("trigger_run_id_invalid");
    if (taskId !== "dispatch-remediation-preparation") fail("trigger_task_id_invalid");
    const cancellationProgram = `
      import { runs } from "@trigger.dev/sdk";
      const runId = ${JSON.stringify(runId)};
      const taskId = ${JSON.stringify(taskId)};
      const run = await runs.retrieve(runId);
      if (run.id !== runId || run.taskIdentifier !== taskId || run.status !== "QUEUED") {
        process.stdout.write(JSON.stringify({ runId, taskId, cancelled: false, status: run.status, identityValid: run.id === runId && run.taskIdentifier === taskId }) + "\\n");
        process.exitCode = 2;
      } else {
        await runs.cancel(runId);
        const cancelled = await runs.retrieve(runId);
        process.stdout.write(JSON.stringify({ runId, taskId, cancelled: cancelled.isCancelled, status: cancelled.status }) + "\\n");
        if (!cancelled.isCancelled) process.exitCode = 3;
      }
    `;
    const cancellation = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", cancellationProgram],
      {
        cwd: repoRoot,
        env: safeEnv,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 16_384,
      },
    );
    const report = (cancellation.stdout ?? "").trim().split(/\r?\n/).at(-1);
    if (report && report.includes(`"runId":${JSON.stringify(runId)}`)) {
      process.stdout.write(`${report}\n`);
    } else {
      process.stdout.write(
        `${JSON.stringify({ runId, taskId, cancelled: false, category: "cancellation_failed" })}\n`,
      );
    }
    if (cancellation.error || cancellation.status !== 0) process.exitCode = 1;
    return;
  }
  const inspectCliRunIndex = process.argv.indexOf("--inspect-cli-run");
  if (inspectCliRunIndex >= 0) {
    const runId = process.argv[inspectCliRunIndex + 1];
    const taskIdIndex = process.argv.indexOf("--task-id");
    const taskId = taskIdIndex >= 0 ? process.argv[taskIdIndex + 1] : undefined;
    if (!runId || !/^run_[A-Za-z0-9_-]+$/.test(runId)) fail("trigger_run_id_invalid");
    if (
      !taskId ||
      ![
        "dispatch-remediation-preparation",
        "prepare-remediation",
        "run-preflight",
        "validate-remediation",
        "prepare-business-handoff",
      ].includes(taskId)
    ) {
      fail("trigger_task_id_invalid");
    }
    const cli = spawnSync(
      npm,
      [
        "--yes",
        `trigger.dev@${triggerCliVersion}`,
        "runs",
        "get",
        runId,
        "--project-ref",
        expectedProject,
        "--env",
        "dev",
        "--skip-telemetry",
        "--log-level",
        "log",
      ],
      {
        cwd: repoRoot,
        env: safeEnv,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 64 * 1024,
        shell: process.platform === "win32",
      },
    );
    const output = `${cli.stdout ?? ""}\n${cli.stderr ?? ""}`;
    const safeFields = new Map<string, string>();
    for (const line of output.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/)) {
      const field = line.match(
        /^\s*(run id|id|task identifier|task id|task|status|environment|created at|created|started at|started|completed at|completed|finished at|finished)\s*[:|]\s*([^\r\n]{1,160})\s*$/i,
      );
      if (!field) continue;
      const key = field[1]!.toLowerCase().replace(/\s+/g, "_");
      const value = field[2]!.trim();
      if (/^[A-Za-z0-9_.:+/-]{1,120}$/.test(value)) safeFields.set(key, value);
    }
    const extract = (field: string) => {
      const match = output.match(
        new RegExp(`(?:^|[\\s,{])(?:"${field}"|${field})["']?[\\s:=]+["']?([^\\s,"'}]+)`, "im"),
      );
      return match?.[1] ?? safeFields.get(field.toLowerCase().replace(/([A-Z])/g, "_$1")) ?? null;
    };
    const result = {
      runId,
      found: cli.status === 0,
      category:
        cli.status === 0
          ? null
          : cli.status === 1 && /\b404\b|not found|resource_not_found/i.test(output)
            ? "resource_not_found"
            : cli.status === 1 && /\b401\b|\b403\b|unauthorized|forbidden/i.test(output)
              ? "authorization_failed"
              : cli.error
                ? `cli_${(cli.error as NodeJS.ErrnoException).code?.toLowerCase() ?? "failed"}`
                : "request_failed",
      cliVersion: triggerCliVersion,
      projectRef: expectedProject,
      environment: "development",
      taskIdentifier: extract("taskIdentifier") ?? extract("taskId"),
      status: extract("status"),
      createdAt: extract("createdAt") ?? extract("created_at"),
      completedAt: extract("completedAt") ?? extract("completed_at"),
      safeFieldLabels: [...safeFields.keys()].filter((key) =>
        [
          "run_id",
          "id",
          "task_identifier",
          "task_id",
          "task",
          "status",
          "environment",
          "created_at",
          "created",
          "started_at",
          "started",
          "completed_at",
          "completed",
          "finished_at",
          "finished",
        ].includes(key),
      ),
      exitCode: cli.status ?? null,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (cli.error || cli.status !== 0) process.exitCode = 1;
    return;
  }
  const inspectRunIndex = process.argv.indexOf("--inspect-run");
  if (inspectRunIndex >= 0) {
    const runId = process.argv[inspectRunIndex + 1];
    const taskIdIndex = process.argv.indexOf("--task-id");
    const taskId = taskIdIndex >= 0 ? process.argv[taskIdIndex + 1] : undefined;
    if (!runId || !/^run_[A-Za-z0-9_-]+$/.test(runId)) fail("trigger_run_id_invalid");
    if (
      !taskId ||
      ![
        "dispatch-remediation-preparation",
        "prepare-remediation",
        "run-preflight",
        "validate-remediation",
        "prepare-business-handoff",
      ].includes(taskId)
    ) {
      fail("trigger_task_id_invalid");
    }
    const inspectionProgram = `
      import { runs } from "@trigger.dev/sdk";
      const runId = ${JSON.stringify(runId)};
      const taskId = ${JSON.stringify(taskId)};
      try {
        const run = await runs.retrieve(runId);
        process.stdout.write(JSON.stringify({
          runId,
          found: true,
          status: run.status,
          taskIdentifier: run.taskIdentifier,
          taskKind: run.taskKind ?? null,
          triggerFunction: run.triggerFunction,
          isQueued: run.isQueued,
          version: run.version ?? null,
          createdAt: run.createdAt instanceof Date ? run.createdAt.toISOString() : null,
          startedAt:
            run.startedAt instanceof Date ? run.startedAt.toISOString() : null,
          finishedAt:
            run.finishedAt instanceof Date ? run.finishedAt.toISOString() : null,
          schedule: run.schedule
            ? { id: run.schedule.id, generatorType: run.schedule.generator.type }
            : null,
          rootRun: run.relatedRuns?.root
            ? { id: run.relatedRuns.root.id, taskIdentifier: run.relatedRuns.root.taskIdentifier }
            : null,
          isCompleted: run.isCompleted,
          isFailed: run.isFailed,
          isCancelled: run.isCancelled,
        }) + "\\n");
      } catch (error) {
        const value = error && typeof error === "object" ? error : {};
        const status = Number(value.status ?? value.statusCode);
        const message = typeof value.message === "string" ? value.message : "";
        let listed = false;
        let listedStatus;
        try {
          const page = await runs.list(${JSON.stringify(expectedProject)}, {
            env: "dev",
            taskIdentifier: taskId,
            limit: 100,
          });
          const matchingRun = page.data.find((candidate) => candidate.id === runId);
          listed = Boolean(matchingRun);
          listedStatus = matchingRun?.status;
        } catch {
          // Keep the fallback diagnostic bounded and avoid returning provider payloads.
        }
        const category = status === 404 || /resource not found/i.test(message)
          ? "resource_not_found"
          : status === 401 || status === 403
            ? "authorization_failed"
            : "request_failed";
        process.stdout.write(JSON.stringify({
          runId,
          found: false,
          category,
          httpStatus: Number.isFinite(status) ? status : null,
          errorName: typeof value.name === "string" ? value.name : null,
          projectRef: ${JSON.stringify(expectedProject)},
          environment: "development",
          taskIdentifier: taskId,
          listedInDevelopmentProject: listed,
          listedStatus: listedStatus ?? null,
        }) + "\\n");
        process.exitCode = 2;
      }
    `;
    const inspection = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", inspectionProgram],
      {
        cwd: repoRoot,
        env: safeEnv,
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 16_384,
      },
    );
    const report = (inspection.stdout ?? "").trim().split(/\r?\n/).at(-1);
    if (report && /^\{"runId":"run_[A-Za-z0-9_-]+","found":(?:true|false)/.test(report)) {
      process.stdout.write(`${report}\n`);
    } else {
      process.stdout.write(
        JSON.stringify({ runId, found: false, category: "inspection_failed" }) + "\n",
      );
    }
    if (inspection.error || inspection.status !== 0) process.exitCode = 1;
    return;
  }
  // Carry explicit local-only connection values in the guarded worker process.
  // The server client reads the namespaced secret directly; no credential file is written.
  const child = spawn(
    npm,
    [
      "--yes",
      `trigger.dev@${triggerCliVersion}`,
      "dev",
      "start",
      "--config",
      "trigger.m15-local.config.ts",
      "--project-ref",
      expectedProject,
      "--skip-update-check",
      "--skip-telemetry",
      "--log-level",
      "debug",
    ],
    {
      cwd: repoRoot,
      env: safeEnv,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdin.end();

  let output = "";
  const workerLogTimeline: Array<{
    event: string;
    observedAt: string;
    runId?: string;
    correlationId?: string;
    eventAt?: string;
    taskId?: string;
    queueId?: string;
    queueAttempt?: number;
    triggerAttempt?: number;
    outcome?: string;
  }> = [];
  let workerLogRemainder = "";
  let manifestIndexedAt: string | undefined;
  const captureWorkerLine = (line: string) => {
    const observedAt = new Date().toISOString();
    const startupEvent = line.includes(`TRIGGER_PROJECT_REF: '${expectedProject}'`)
      ? "project_identity"
      : /worker manifest indexed/i.test(line)
        ? "task_manifest_indexed"
        : /Local worker ready on branch:/i.test(line)
          ? "worker_ready"
          : /Presence connection error/i.test(line)
            ? "presence_socket_error"
            : /Presence connection established/i.test(line)
              ? "presence_established"
              : undefined;
    if (startupEvent) {
      workerLogTimeline.push({ event: startupEvent, observedAt });
      if (startupEvent === "task_manifest_indexed") manifestIndexedAt = observedAt;
    }
    const taskEvent = line.match(
      /AUTERIM_M15_V2_TASK_(STARTED|COMPLETED) runId=(run_[A-Za-z0-9_-]+) correlationId=([0-9a-f-]{36}) at=(\S+)/,
    );
    if (taskEvent && !Number.isNaN(Date.parse(taskEvent[4]!))) {
      workerLogTimeline.push({
        event: taskEvent[1]!.toLowerCase() === "started" ? "task_started" : "task_completed",
        observedAt,
        runId: taskEvent[2],
        correlationId: taskEvent[3],
        eventAt: taskEvent[4],
      });
    }
    if (/AUTERIM_M15_REMEDIATION_QUEUE_READ_COMPLETED items=\d+/.test(line)) {
      workerLogTimeline.push({
        event: "remediation_queue_read_completed",
        observedAt,
      });
    }
    const productTask = line.match(
      /AUTERIM_M15_TASK_OUTCOME task=(run-preflight|prepare-remediation|validate-remediation|prepare-business-handoff) runId=(run_[A-Za-z0-9_-]+) queueId=([0-9a-f-]{36}) queueAttempt=(\d+) triggerAttempt=(\d+) outcome=([a-z_]{1,40})/,
    );
    if (productTask) {
      const outcome = {
        event: "product_task_outcome",
        observedAt,
        runId: productTask[2],
        taskId: productTask[1],
        queueId: productTask[3],
        queueAttempt: Number(productTask[4]),
        triggerAttempt: Number(productTask[5]),
        outcome: productTask[6],
      };
      workerLogTimeline.push(outcome);
      try {
        appendFileSync(
          path.join(workdir, "task-outcomes.jsonl"),
          `${JSON.stringify({ ...outcome, completedAt: observedAt })}\n`,
          { mode: 0o600 },
        );
      } catch {
        // Missing local proof storage makes acceptance fail closed in the integration test.
      }
    }
  };
  const capture = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    output = `${output}${text}`.slice(-32_000);
    output = output.replaceAll(secret, "[redacted]");
    for (const localSecret of [local.publishableKey, local.serviceKey]) {
      output = output.replaceAll(localSecret, "[redacted]");
    }
    workerLogRemainder += text;
    const lines = workerLogRemainder.split(/\r?\n/);
    workerLogRemainder = lines.pop() ?? "";
    lines.forEach(captureWorkerLine);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.on("error", () => undefined);

  try {
    await waitForWorkerReady(child, () => output, false);
    if (!output.includes(`TRIGGER_PROJECT_REF: '${expectedProject}'`)) {
      fail("trigger_worker_project_identity_unproven");
    }
    const taskIds = await registeredTaskIds(output);
    if (!taskIds.has(diagnosticTaskId)) fail("trigger_worker_task_not_registered");
    const taskRegistrationObservedAt = new Date().toISOString();
    workerLogTimeline.push({
      event: "task_registration_confirmed",
      observedAt: taskRegistrationObservedAt,
    });

    if (process.argv.includes("--diagnostic-only")) {
      // Span one complete two-minute dispatcher schedule without sending a diagnostic run.
      const diagnosticDeadline = Date.now() + 130_000;
      while (Date.now() < diagnosticDeadline && child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      process.stdout.write(
        `${JSON.stringify({
          status: child.exitCode === null ? "worker_process_alive" : "worker_process_exited",
          exitCode: child.exitCode,
          authenticatedProjectProbe: "passed",
          triggerCliVersion,
          triggerProject: expectedProject,
          registeredTaskId: diagnosticTaskId,
          triggerEnvironment: "development",
          developmentCredentialValidated: true,
          inheritedProductionTriggerCredential: "excluded",
          localIntegrationFlag: safeEnv.AUTERIM_M15_LOCAL_INTEGRATION === "1",
          localSupabaseOrigin: new URL(local.apiUrl).origin,
          hostedSupabaseTarget: "excluded",
          productionRoutingVariables: "excluded",
          readinessObserved: true,
          workerLogTimeline,
          taskRegistrationObservedAt,
          manifestIndexedAt,
          startupDiagnostic: safeStartupDiagnostic(output) || "no_matching_startup_lines",
        })}\n`,
      );
      if (child.exitCode !== null) fail("trigger_dev_worker_exited_during_diagnostic");
      return;
    }

    if (process.argv.includes("--real-preflight")) {
      const requiredProductTasks = [
        "dispatch-preflight-queue",
        "run-preflight",
        "dispatch-remediation-preparation",
        "prepare-remediation",
        "dispatch-remediation-validation",
        "validate-remediation",
        "dispatch-business-handoff",
        "prepare-business-handoff",
      ];
      const missing = requiredProductTasks.filter((taskId) => !taskIds.has(taskId));
      if (missing.length) fail("trigger_worker_product_task_manifest_incomplete");

      const npm = process.platform === "win32" ? "npx.cmd" : "npx";
      const integration = spawn(
        npm,
        ["vitest", "run", "tests/m15-local-money-path.integration.test.ts"],
        {
          cwd: repoRoot,
          env: { ...safeEnv, AUTERIM_M15_REAL_TRIGGER_TOPOLOGY: "1" },
          windowsHide: true,
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let integrationOutput = "";
      const captureIntegration = (chunk: Buffer) => {
        integrationOutput = `${integrationOutput}${chunk.toString("utf8")}`.slice(-32_000);
        integrationOutput = integrationOutput
          .replaceAll(secret, "[redacted]")
          .replaceAll(local.publishableKey, "[redacted]")
          .replaceAll(local.serviceKey, "[redacted]")
          .replace(/tr_(?:dev|prod|stg|preview)_sk_[A-Za-z0-9_-]+/gi, "[redacted]")
          .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/eyJ[A-Za-z0-9._-]{30,}/g, "[redacted]");
      };
      integration.stdout?.on("data", captureIntegration);
      integration.stderr?.on("data", captureIntegration);
      const integrationDeadline = Date.now() + 1_560_000;
      while (
        Date.now() < integrationDeadline &&
        integration.exitCode === null &&
        child.exitCode === null
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (integration.exitCode === null) await stopProcess(integration);
      if (integration.exitCode !== 0 || child.exitCode !== null) {
        const cleanupFailure = integrationOutput.match(
          /M15_QA_CLEANUP_FAILURE=([a-z0-9_:,]+)/i,
        )?.[1];
        const failureCode =
          integrationOutput.match(
            /M15_QA_PRIMARY_FAILURE_SAFE=((?:m15|business_handoff)_[a-z0-9_:]{1,200}|qa_assertion_failed)/,
          )?.[1] ??
          integrationOutput.match(/m15_[a-z0-9_]+/g)?.at(-1) ??
          "real_preflight_topology_test_failed";
        const plainTestOutput = integrationOutput.replace(/\u001b\[[0-9;]*m/g, "");
        const primaryFailure = plainTestOutput.match(
          /^M15_QA_PRIMARY_FAILURE_SAFE=([a-z0-9_:]+)$/im,
        )?.[0];
        const safeTestSummary =
          primaryFailure ??
          plainTestOutput
            .split(/\r?\n/)
            .filter(
              (line) =>
                !line.startsWith("M15_REAL_PREFLIGHT_TOPOLOGY=") &&
                /M15_QA_CLEANUP_FAILURE|m15_[a-z0-9_]+|business_handoff_[a-z0-9_]+|Test Files\s+\d+|Tests\s+\d+|FAIL\s+tests\/|Error:/i.test(
                  line,
                ),
            )
            .slice(-12)
            .join(" | ")
            .slice(0, 1_200);
        const testDiagnostic = safeStartupDiagnostic(integrationOutput);
        if (safeTestSummary || testDiagnostic) {
          process.stderr.write(
            `M15_REAL_PREFLIGHT_FAILURE=${(safeTestSummary || testDiagnostic).slice(0, 1_200)}\n`,
          );
        }
        if (cleanupFailure) {
          process.stderr.write(`M15_QA_CLEANUP_FAILURE_SAFE=${cleanupFailure}\n`);
        }
        fail(
          child.exitCode !== null
            ? "trigger_worker_exited_during_real_preflight_topology"
            : `real_preflight_topology_test_failed:${failureCode}${cleanupFailure ? `;qa_cleanup=${cleanupFailure}` : ""}`,
        );
      }
      const proofLine = integrationOutput.match(
        /^M15_REAL_PREFLIGHT_TOPOLOGY=(\{[^\r\n]+\})$/m,
      )?.[0];
      if (!proofLine) fail("real_preflight_topology_evidence_missing");
      const proofPayload = JSON.parse(proofLine.slice("M15_REAL_PREFLIGHT_TOPOLOGY=".length)) as {
        attemptIntentPath?: unknown;
        duplicateDeliveryProof?: {
          preflight?: { taskId?: unknown; runIds?: unknown; outcomes?: unknown };
          remediation?: { taskId?: unknown; runIds?: unknown; outcomes?: unknown };
          validation?: { taskId?: unknown; runIds?: unknown; outcomes?: unknown };
          noDuplicateLogicalWork?: unknown;
        };
      };
      if (
        typeof proofPayload.attemptIntentPath !== "string" ||
        path.dirname(path.resolve(proofPayload.attemptIntentPath)).toLowerCase() !==
          workdir.toLowerCase()
      ) {
        fail("real_preflight_topology_marker_path_invalid");
      }
      const duplicateProof = proofPayload.duplicateDeliveryProof;
      const requiredDeliveries = [
        {
          taskId: "run-preflight",
          outcomes: ["completed", "complete"],
          group: duplicateProof?.preflight,
        },
        {
          taskId: "prepare-remediation",
          outcomes: ["persisted_before_retry", "replayed"],
          group: duplicateProof?.remediation,
        },
        {
          taskId: "validate-remediation",
          outcomes: ["persisted_before_retry", "replayed"],
          group: duplicateProof?.validation,
        },
      ];
      for (const delivery of requiredDeliveries) {
        if (
          delivery.group?.taskId !== delivery.taskId ||
          !Array.isArray(delivery.group.runIds) ||
          delivery.group.runIds.length !== 2 ||
          new Set(delivery.group.runIds).size !== 2 ||
          !delivery.group.runIds.every(
            (runId): runId is string =>
              typeof runId === "string" && /^run_[A-Za-z0-9_-]+$/.test(runId),
          ) ||
          !Array.isArray(delivery.group.outcomes) ||
          delivery.group.outcomes.length !== delivery.outcomes.length ||
          !delivery.group.outcomes.every((outcome, index) => outcome === delivery.outcomes[index])
        ) {
          fail(`real_trigger_duplicate_delivery_proof_invalid:${delivery.taskId}`);
        }
        const expectedRunIds = delivery.group.runIds as string[];
        for (let index = 0; index < expectedRunIds.length; index++) {
          const runId = expectedRunIds[index]!;
          if (
            !workerLogTimeline.some(
              (event) =>
                event.event === "product_task_outcome" &&
                event.runId === runId &&
                event.taskId === delivery.taskId &&
                event.outcome === delivery.outcomes[index],
            )
          ) {
            fail(`real_trigger_duplicate_delivery_not_executed:${delivery.taskId}`);
          }
        }
      }
      if (duplicateProof?.noDuplicateLogicalWork !== true) {
        fail("real_trigger_duplicate_delivery_not_idempotent");
      }
      process.stdout.write(
        `${JSON.stringify({
          status: "real_preflight_topology_complete",
          triggerProject: expectedProject,
          triggerEnvironment: "development",
          developmentCredentialValidated: true,
          inheritedProductionTriggerCredential: "excluded",
          localIntegrationFlag: true,
          localSupabaseOrigin: new URL(local.apiUrl).origin,
          hostedSupabaseTarget: "excluded",
          productionRoutingVariables: "excluded",
          taskRegistrationConfirmed: requiredProductTasks,
          workerLogTimeline,
          taskRegistrationObservedAt,
          manifestIndexedAt,
          attemptIntentPath: proofPayload.attemptIntentPath,
          proof: proofLine,
        })}\n`,
      );
      return;
    }

    if (process.argv.includes("--entitlements-only")) {
      const entitlementTasks = [
        "dispatch-remediation-preparation",
        "prepare-remediation",
        "dispatch-remediation-validation",
        "validate-remediation",
      ];
      const missing = entitlementTasks.filter((taskId) => !taskIds.has(taskId));
      if (missing.length) fail("trigger_worker_entitlement_task_manifest_incomplete");

      const entitlementTestPath = path.join(
        repoRoot,
        "tests",
        "m15-entitlement-matrix.integration.test.ts",
      );
      try {
        await access(entitlementTestPath);
      } catch {
        fail("entitlement_matrix_integration_test_missing");
      }

      if (!entitlementFixtureId) fail("entitlement_fixture_identity_missing");
      const entitlementTest = spawn(
        npm,
        ["vitest", "run", "tests/m15-entitlement-matrix.integration.test.ts"],
        {
          cwd: repoRoot,
          env: {
            ...safeEnv,
            AUTERIM_M15_REAL_TRIGGER_TOPOLOGY: "1",
            AUTERIM_M15_ENTITLEMENT_PHASE: "execute",
            AUTERIM_M15_ENTITLEMENT_FIXTURE_ID: entitlementFixtureId,
          },
          windowsHide: true,
          shell: process.platform === "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let entitlementOutput = "";
      const captureEntitlement = (chunk: Buffer) => {
        entitlementOutput = `${entitlementOutput}${chunk.toString("utf8")}`.slice(-32_000);
        entitlementOutput = entitlementOutput
          .replaceAll(secret, "[redacted]")
          .replaceAll(local.publishableKey, "[redacted]")
          .replaceAll(local.serviceKey, "[redacted]")
          .replace(/tr_(?:dev|prod|stg|preview)_sk_[A-Za-z0-9_-]+/gi, "[redacted]")
          .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
          .replace(/eyJ[A-Za-z0-9._-]{30,}/g, "[redacted]");
      };
      entitlementTest.stdout?.on("data", captureEntitlement);
      entitlementTest.stderr?.on("data", captureEntitlement);
      // Seven bounded worker cases should complete well within this limit; this is a hard
      // acceptance bound, not a queue TTL wait.
      const entitlementDeadline = Date.now() + 600_000;
      while (
        Date.now() < entitlementDeadline &&
        entitlementTest.exitCode === null &&
        child.exitCode === null
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (entitlementTest.exitCode === null) await stopProcess(entitlementTest);
      if (entitlementTest.exitCode !== 0 || child.exitCode !== null) {
        const safeLines = entitlementOutput
          .replace(/\u001b\[[0-9;]*m/g, "")
          .split(/\r?\n/)
          .filter((line) =>
            /M15_ENTITLEMENT|m15_entitlement|Test Files\s+\d+|Tests\s+\d+|FAIL\s+tests\/|Error:/i.test(
              line,
            ),
          )
          .slice(-12)
          .join(" | ")
          .slice(0, 1_200);
        if (safeLines) process.stderr.write(`M15_ENTITLEMENT_FAILURE=${safeLines}\n`);
        fail(
          child.exitCode !== null
            ? "trigger_worker_exited_during_entitlement_matrix"
            : entitlementTest.exitCode === null
              ? "entitlement_matrix_runtime_timeout"
              : "entitlement_matrix_test_failed",
        );
      }

      const checkpointLine = entitlementOutput.match(
        /^M15_ENTITLEMENT_MATRIX=(\{[^\r\n]+\})$/m,
      )?.[0];
      if (!checkpointLine) fail("entitlement_matrix_checkpoint_missing");
      const checkpoint = JSON.parse(checkpointLine.slice("M15_ENTITLEMENT_MATRIX=".length)) as {
        complete?: unknown;
        fixtureId?: unknown;
        checkpointPath?: unknown;
        cases?: unknown;
      };
      const provenCases = Array.isArray(checkpoint.cases)
        ? checkpoint.cases.filter(
            (item): item is { status: string; queueId: string; triggerRunId: string } =>
              Boolean(
                item &&
                typeof item === "object" &&
                "status" in item &&
                item.status === "proven" &&
                "queueId" in item &&
                typeof item.queueId === "string" &&
                "triggerRunId" in item &&
                typeof item.triggerRunId === "string" &&
                /^run_[A-Za-z0-9_-]+$/.test(item.triggerRunId),
              ),
          )
        : [];
      if (
        checkpoint.complete !== true ||
        checkpoint.fixtureId !== entitlementFixtureId ||
        !isLocalAcceptanceArtifact(checkpoint.checkpointPath) ||
        !Array.isArray(checkpoint.cases) ||
        checkpoint.cases.length !== 7 ||
        provenCases.length !== 7 ||
        new Set(provenCases.map((item) => item.queueId)).size !== 7 ||
        new Set(provenCases.map((item) => item.triggerRunId)).size !== 7
      ) {
        fail("entitlement_matrix_checkpoint_invalid");
      }
      process.stdout.write(
        `${JSON.stringify({
          status: "entitlement_matrix_complete",
          triggerProject: expectedProject,
          triggerEnvironment: "development",
          developmentCredentialValidated: true,
          inheritedProductionTriggerCredential: "excluded",
          localIntegrationFlag: true,
          localSupabaseOrigin: new URL(local.apiUrl).origin,
          hostedSupabaseTarget: "excluded",
          productionRoutingVariables: "excluded",
          taskRegistrationConfirmed: entitlementTasks,
          workerLogTimeline,
          taskRegistrationObservedAt,
          manifestIndexedAt,
          checkpointPath: checkpoint.checkpointPath,
          fixtureId: checkpoint.fixtureId,
          cases: provenCases,
        })}\n`,
      );
      return;
    }

    const node = process.platform === "win32" ? "node.exe" : "node";
    const dispatch = spawn(
      node,
      ["--experimental-strip-types", "scripts/m15-validation/dispatch-trigger-roundtrip.mts"],
      { cwd: repoRoot, env: safeEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let dispatchOutput = "";
    const captureDispatch = (chunk: Buffer) => {
      dispatchOutput = `${dispatchOutput}${chunk.toString("utf8")}`.slice(-16_384);
    };
    dispatch.stdout?.on("data", captureDispatch);
    dispatch.stderr?.on("data", captureDispatch);
    const deadline = Date.now() + TRIGGER_WRAPPER_DISPATCH_TIMEOUT_MS;
    while (Date.now() < deadline && dispatch.exitCode === null && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (dispatch.exitCode === null) await stopProcess(dispatch);
    if (dispatch.exitCode !== 0 || child.exitCode !== null) {
      // The accepted identity line is emitted after its durable file write; replay it even when
      // this outer timeout terminates the dispatch process during polling.
      forwardAcceptedObservation(dispatchOutput, (line) => process.stderr.write(line));
      forwardRunStatusObservations(dispatchOutput, (line) => process.stderr.write(line));
      const dispatchDiagnostic = dispatchOutput.match(
        /trigger_dispatch_not_accepted:[a-z_]+|trigger_worker_persistence_timeout:run_status_[a-z_]+|isolated_local_supabase_required/,
      )?.[0];
      const workerDiagnostic = safeStartupDiagnostic(output) || "no_safe_worker_diagnostic";
      const dispatchRuntimeDiagnostic =
        safeStartupDiagnostic(dispatchOutput) || "no_safe_dispatch_diagnostic";
      fail(
        child.exitCode !== null
          ? `trigger_worker_exited:${startupFailureCategory(output)}:${safeStartupDiagnostic(output) || "no_safe_diagnostic"}`
          : `trigger_round_trip_dispatch_failed:${dispatchDiagnostic ?? "dispatch_failed"};worker_diagnostic=${workerDiagnostic};dispatch_diagnostic=${dispatchRuntimeDiagnostic}`,
      );
    }
    const finalJsonLine = dispatchOutput
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.startsWith("{"))
      .at(-1);
    if (!finalJsonLine) fail("trigger_round_trip_result_missing");
    const report = JSON.parse(finalJsonLine) as {
      status: string;
      runId: string;
      dispatchAttemptId: string;
      dispatchInvocation: {
        taskId: string;
        projectRef: string;
        environment: string;
        supabaseOrigin: string;
        queueConfiguration: string;
        declaredTaskConcurrencyLimit?: number;
      };
      runStatusHistory: Array<{
        status: string;
        isCompleted: boolean;
        isFailed: boolean;
        isCancelled: boolean;
        observedAt: string;
      }>;
      dispatchedAt: string;
      observationPath: string;
      attemptRecordPath: string;
      localCompletionMarker: {
        correlation_id: string;
        task_id: string;
        run_id: string;
        completed_at: string;
      };
      persistence: string;
    };
    if (
      report.status !== "complete" ||
      report.dispatchInvocation.taskId !== diagnosticTaskId ||
      report.dispatchInvocation.projectRef !== expectedProject ||
      report.dispatchInvocation.environment !== "development" ||
      report.dispatchInvocation.supabaseOrigin !== new URL(local.apiUrl).origin ||
      report.dispatchInvocation.queueConfiguration !== expectedQueueConfiguration ||
      report.dispatchInvocation.declaredTaskConcurrencyLimit !== 1 ||
      !report.dispatchAttemptId ||
      !report.runId ||
      !report.runStatusHistory.at(-1) ||
      !isSuccessfulCompletedRun(report.runStatusHistory.at(-1)!) ||
      typeof report.dispatchedAt !== "string" ||
      typeof report.observationPath !== "string" ||
      report.persistence !== "isolated-local-supabase"
    ) {
      fail("trigger_round_trip_marker_mismatch_or_timeout");
    }
    process.stdout.write(
      `${JSON.stringify({
        status: "complete",
        runId: report.runId,
        dispatchAttemptId: report.dispatchAttemptId,
        dispatchInvocation: report.dispatchInvocation,
        runStatusHistory: report.runStatusHistory,
        dispatchedAt: report.dispatchedAt,
        observationPath: report.observationPath,
        attemptRecordPath: report.attemptRecordPath,
        localCompletionMarker: report.localCompletionMarker,
        workerLogTimeline: workerLogTimeline.filter(
          (event) =>
            !event.runId ||
            (event.runId === report.runId && event.correlationId === report.dispatchAttemptId),
        ),
        taskRegistrationObservedAt,
        manifestIndexedAt,
        persistence: report.persistence,
        triggerCliVersion,
        triggerEnvironment: "development",
        developmentCredentialValidated: true,
        inheritedProductionTriggerCredential: "excluded",
        localIntegrationFlag: true,
        localSupabaseOrigin: new URL(local.apiUrl).origin,
        hostedSupabaseTarget: "excluded",
        productionRoutingVariables: "excluded",
      })}\n`,
    );
  } finally {
    await stopProcess(child);
    await rm(localCredentialsPath, { force: true });
  }
}

main().catch(async (error: unknown) => {
  const code = error instanceof Error ? error.message : "trigger_round_trip_failed";
  if (entitlementRecovery) {
    try {
      assertNoAuterimDevWorker();
      const fixturePath = path.join(
        workdir,
        `entitlement-fixture-${entitlementRecovery.fixtureId}.json`,
      );
      await access(fixturePath);
      const cleanup = runEntitlementTestPhase({
        npm: entitlementRecovery.npm,
        safeEnv: entitlementRecovery.safeEnv,
        secret: entitlementRecovery.secret,
        local: entitlementRecovery.local,
        phase: "cleanup",
        round: entitlementRecovery.round,
        fixtureId: entitlementRecovery.fixtureId,
      });
      process.stderr.write(
        `M15_ENTITLEMENT_CLEANUP=${cleanup.status === 0 ? "complete" : "failed"}\n`,
      );
    } catch {
      process.stderr.write("M15_ENTITLEMENT_CLEANUP=failed_or_fixture_already_removed\n");
    }
  }
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
