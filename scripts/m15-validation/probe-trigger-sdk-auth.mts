import { runs, TriggerClient } from "@trigger.dev/sdk";

const projectRef = "proj_hwqtxtyrvwykjirkrdoh";
const taskId = "prepare-remediation";
const listEndpointPath = `/api/v1/projects/${projectRef}/runs`;
const retrieveRunId = process.argv
  .find((argument) => argument.startsWith("--retrieve-run-id="))
  ?.split("=")[1];
const endpointPath = retrieveRunId
  ? `/api/v3/runs/${encodeURIComponent(retrieveRunId)}`
  : listEndpointPath;

function safeFailureDetails(error: unknown, prefix: string) {
  const value = error as {
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    code?: unknown;
    error?: { code?: unknown };
    name?: unknown;
  };
  const status = typeof value?.status === "number" ? value.status : undefined;
  const statusCode = typeof value?.statusCode === "number" ? value.statusCode : undefined;
  const httpStatus = status ?? statusCode ?? null;
  const rawMessage = typeof value?.message === "string" ? value.message : "";
  const message = rawMessage.toLowerCase();
  const errorClass =
    typeof value?.constructor?.name === "string" ? value.constructor.name : "UnknownError";
  const name = typeof value?.name === "string" ? value.name : "UnknownError";
  const candidateCode = value?.code ?? value?.error?.code;
  const errorCode =
    typeof candidateCode === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(candidateCode)
      ? candidateCode
      : null;
  const safeErrorMessage = /invalid api key/i.test(rawMessage)
    ? "Invalid API key"
    : /unauthorized|authentication failed/i.test(rawMessage)
      ? "Unauthorized"
      : /forbidden|permission denied|not permitted/i.test(rawMessage)
        ? "Permission denied"
        : httpStatus === null
          ? "No HTTP response status"
          : `HTTP ${httpStatus}`;
  const statusLabel =
    httpStatus === 200
      ? `${prefix}_AUTH_VALID`
      : httpStatus === 401
        ? `${prefix}_AUTH_INVALID`
        : httpStatus === 403
          ? `${prefix}_AUTH_PERMISSION_DENIED`
          : httpStatus === 404
            ? `${prefix}_PROJECT_OR_ENDPOINT_NOT_FOUND`
            : httpStatus === 429
              ? `${prefix}_AUTH_PROBE_RATE_LIMITED`
              : httpStatus === null
                ? /invalid api key/i.test(message)
                  ? `${prefix}_AUTH_INVALID`
                  : `${prefix}_AUTH_PROBE_FAILED`
                : `${prefix}_AUTH_PROBE_FAILED`;

  return {
    status: statusLabel,
    httpStatus,
    endpointPath,
    errorCode,
    errorClass: `${errorClass}/${name}`.slice(0, 100),
    safeErrorMessage,
  };
}

function request() {
  return {
    env: "dev" as const,
    taskIdentifier: taskId,
    period: "1h",
    limit: 1,
  };
}

async function retrieveResult(retrieve: (runId: string) => Promise<unknown>, prefix: string) {
  if (!retrieveRunId || !/^run_[A-Za-z0-9]+$/.test(retrieveRunId)) {
    return { status: `${prefix}_INVALID_RUN_ID`, endpointPath };
  }
  try {
    const value = (await retrieve(retrieveRunId)) as { id?: unknown; status?: unknown };
    const runStatus = typeof value.status === "string" ? value.status : "UNKNOWN";
    return {
      status: "RETRIEVE_VALID",
      projectRef,
      environment: "development",
      operation: "read_only_exact_run_retrieve",
      httpMethod: "GET",
      endpointPath,
      runId: value.id === retrieveRunId ? retrieveRunId : "RUN_ID_MISMATCH",
      runStatus,
    };
  } catch (error) {
    return safeFailureDetails(error, prefix);
  }
}

if (
  !process.env.TRIGGER_SECRET_KEY?.startsWith("tr_dev_sk_") ||
  process.env.TRIGGER_ACCESS_TOKEN !== undefined ||
  process.env.TRIGGER_API_URL !== undefined ||
  process.env.TRIGGER_VERSION !== undefined ||
  process.env.TRIGGER_EXTERNAL_DEPLOYMENT_ID !== undefined ||
  process.env.TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION !== undefined ||
  process.env.VERCEL_GIT_COMMIT_SHA !== undefined
) {
  process.stderr.write("SDK_AUTH_INVALID_ENVIRONMENT\n");
  process.exitCode = 1;
} else if (retrieveRunId) {
  const result = await retrieveResult((runId) => runs.retrieve(runId), "SDK");
  process.stdout.write(`${JSON.stringify({ ...result, client: "global_sdk" })}\n`);
  if (result.status !== "RETRIEVE_VALID") process.exitCode = 1;

  if (process.argv.includes("--official-client")) {
    const token = process.env.TRIGGER_SECRET_KEY;
    if (!token) {
      process.stdout.write(
        `${JSON.stringify({ status: "OFFICIAL_CLIENT_INVALID_ENVIRONMENT", endpointPath })}\n`,
      );
      process.exitCode = 1;
    } else {
      const client = new TriggerClient({
        accessToken: token,
        baseURL: "https://api.trigger.dev",
        previewBranch: "",
      });
      const officialResult = await retrieveResult(
        (runId) => client.runs.retrieve(runId),
        "OFFICIAL_CLIENT",
      );
      process.stdout.write(`${JSON.stringify({ ...officialResult, client: "trigger_client" })}\n`);
      if (officialResult.status !== "RETRIEVE_VALID") process.exitCode = 1;
    }
  }
} else {
  try {
    // Preserved diagnostic only; this endpoint is not used as the M15 auth gate.
    await runs.list(projectRef, { ...request() });
    process.stdout.write(
      `${JSON.stringify({
        status: "SDK_AUTH_VALID",
        projectRef,
        environment: "development",
        operation: "read_only_task_run_list",
        httpMethod: "GET",
        endpointPath,
        taskId,
      })}\n`,
    );
  } catch (error) {
    process.stdout.write(`${JSON.stringify(safeFailureDetails(error, "SDK"))}\n`);
    process.exitCode = 1;
  }

  if (process.argv.includes("--official-client")) {
    const token = process.env.TRIGGER_SECRET_KEY;
    if (!token) {
      process.stdout.write(
        `${JSON.stringify({ status: "SDK_AUTH_INVALID_ENVIRONMENT", endpointPath })}\n`,
      );
      process.exitCode = 1;
    } else {
      const client = new TriggerClient({
        accessToken: token,
        baseURL: "https://api.trigger.dev",
        previewBranch: "",
      });
      try {
        await client.runs.list(projectRef, request());
        process.stdout.write(
          `${JSON.stringify({
            status: "OFFICIAL_CLIENT_AUTH_VALID",
            projectRef,
            environment: "development",
            operation: "read_only_task_run_list",
            httpMethod: "GET",
            endpointPath,
            taskId,
          })}\n`,
        );
      } catch (error) {
        const details = safeFailureDetails(error, "SDK");
        process.stdout.write(
          `${JSON.stringify({ ...details, status: `OFFICIAL_CLIENT_${details.status}` })}\n`,
        );
        process.exitCode = 1;
      }
    }
  }
}
