#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { openApprovalUrl } from "./browser.js";
import { loadLocalProjectState, markLocalScanSuccessful } from "./local-state.js";
import { renderReview, scanProject, serializeDiscoveryPayload } from "./scanner/index.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_USER_CANCELLED = 3;
const EXIT_AUTHORIZATION = 4;
const EXIT_SCAN = 5;
const EXIT_SUBMISSION = 6;
const EXIT_INTERRUPTED = 130;
const DEFAULT_SERVER = "https://auterim.com";

type ParsedArguments =
  | { command: "help" }
  | { command: "version" }
  | { command: "connect-help" }
  | { command: "connect"; root: string; mode: "dry-run" | "connect"; server: string };

function parseArguments(arguments_: string[]): ParsedArguments | null {
  if (arguments_.length === 0 || arguments_[0] === "--help" || arguments_[0] === "-h")
    return { command: "help" };
  if (arguments_[0] === "--version" || arguments_[0] === "-v")
    return arguments_.length === 1 ? { command: "version" } : null;
  if (arguments_[0] !== "connect") return null;
  if (arguments_[1] === "--help" || arguments_[1] === "-h")
    return arguments_.length <= 2 ? { command: "connect-help" } : null;

  let mode: "dry-run" | "connect" = "connect";
  let root = process.cwd();
  let server = DEFAULT_SERVER;
  let serverProvided = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--dry-run") {
      if (serverProvided || mode === "dry-run") return null;
      mode = "dry-run";
      continue;
    }
    if (argument === "--server") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--") || serverProvided || mode === "dry-run") return null;
      server = value;
      serverProvided = true;
      index += 1;
      continue;
    }
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) return null;
      root = value;
      index += 1;
      continue;
    }
    return null;
  }
  return { command: "connect", root: resolve(root), mode, server };
}

const globalHelp =
  "Auterim protects software from external changes.\n\n" +
  "Usage: auterim <command>\n\n" +
  "Commands:\n" +
  "  connect    Analyze this project locally and connect derived dependency evidence to an Auterim Product.\n\n" +
  "Options:\n" +
  "  -h, --help       Show help\n" +
  "  -v, --version    Show CLI version\n";
const connectHelp =
  "Usage: auterim connect [--dry-run] [--root <project-directory>] [--server <Auterim-origin>]\n\n" +
  "Analyze a project locally and connect derived dependency evidence to an Auterim Protected Product.\n" +
  "Connected mode requires browser authorization and interactive consent. The default server is https://auterim.com.\n" +
  "Dry-run is offline and does not require authorization.\n";

export type CliRuntime = {
  interactive?: boolean;
  ci?: boolean;
  configDirectory?: string;
  openBrowser?: (url: string) => Promise<boolean>;
  confirm?: (signal: AbortSignal) => Promise<boolean | "interrupted">;
};

export async function main(
  arguments_ = process.argv.slice(2),
  runtime: CliRuntime = {},
): Promise<number> {
  const parsed = parseArguments(arguments_);
  if (!parsed) {
    process.stderr.write("Invalid command. Run `auterim --help` for usage.\n");
    return EXIT_USAGE;
  }
  if (parsed.command === "help") {
    process.stdout.write(globalHelp);
    return EXIT_OK;
  }
  if (parsed.command === "connect-help") {
    process.stdout.write(connectHelp);
    return EXIT_OK;
  }
  if (parsed.command === "version") {
    try {
      const metadata = JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ) as {
        version?: unknown;
      };
      if (typeof metadata.version !== "string") throw new Error("invalid_package_metadata");
      process.stdout.write(`${metadata.version}\n`);
      return EXIT_OK;
    } catch {
      process.stderr.write(
        "CLI package version is unavailable. Reinstall the package and retry.\n",
      );
      return EXIT_ERROR;
    }
  }

  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    controller.abort(new Error("interrupted"));
  };
  process.once("SIGINT", onInterrupt);

  try {
    if (parsed.mode === "connect")
      return await connectAndScan(parsed, controller.signal, () => interrupted, runtime);
    return await dryRun(parsed, controller.signal, () => interrupted, runtime);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

async function dryRun(
  parsed: Extract<ParsedArguments, { command: "connect" }>,
  signal: AbortSignal,
  isInterrupted: () => boolean,
  runtime: CliRuntime,
) {
  try {
    const state = await loadLocalProjectState(parsed.root, {
      ...(runtime.configDirectory ? { configDirectory: runtime.configDirectory } : {}),
    });
    printLocalRecognition(state.lastSuccessfulScanAt);
    process.stdout.write("Analyzing this project locally…\n");
    const result = await scanProject({ root: parsed.root, signal });
    if (signal.aborted || result.status === "cancelled") return EXIT_INTERRUPTED;
    if (result.status === "failed") {
      process.stderr.write(
        "Local scan failed. Check that the project directory is readable and retry.\n",
      );
      return EXIT_SCAN;
    }
    if (result.status === "complete")
      await markLocalScanSuccessful(parsed.root, new Date(), {
        ...(runtime.configDirectory ? { configDirectory: runtime.configDirectory } : {}),
      });
    process.stdout.write(`${renderReview(result)}\n\n`);
    const payload = serializeDiscoveryPayload(result);
    process.stdout.write(
      `Payload prepared locally: ${Buffer.byteLength(payload, "utf8")} bytes (not sent).\n`,
    );
    process.stdout.write("Network requests: 0. No data was uploaded.\n");
    return isInterrupted() ? EXIT_INTERRUPTED : EXIT_OK;
  } catch (error) {
    if (signal.aborted) return EXIT_INTERRUPTED;
    void error;
    process.stderr.write(
      "Local scan failed. Check that the project directory is readable and retry.\n",
    );
    return EXIT_SCAN;
  }
}

function trustedServer(value: string) {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!local && (url.protocol !== "https:" || url.hostname !== "auterim.com")) ||
    (local && !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("untrusted_server");
  return url.origin;
}

function safeVerificationUrl(value: unknown, server: string) {
  if (typeof value !== "string") throw new Error("authorization_unavailable");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("authorization_unavailable");
  }
  const base = new URL(server);
  const code = url.searchParams.get("code");
  if (
    url.origin !== base.origin ||
    url.pathname !== "/app/cli/connect" ||
    url.username ||
    url.password ||
    url.hash ||
    !code ||
    !/^[A-Z0-9-]{6,16}$/.test(code) ||
    [...url.searchParams.keys()].some((key) => key !== "code")
  )
    throw new Error("authorization_unavailable");
  return url.toString();
}

async function apiRequest(
  server: string,
  path: string,
  init: RequestInit = {},
  callerSignal?: AbortSignal,
) {
  let response: Response;
  try {
    const timeoutSignal = AbortSignal.timeout(10_000);
    response = await fetch(new URL(path, server), {
      ...init,
      signal: callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal,
      redirect: "error",
    });
  } catch {
    if (callerSignal?.aborted) throw new Error("interrupted");
    throw new Error("auterim_unavailable");
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const allowed = new Set([
      "rate_limited",
      "temporarily_unavailable",
      "invalid_cli_payload",
      "payload_too_large",
      "scan_id_conflict",
      "submission_limit_reached",
      "ingestion_credential_unavailable",
      "ingestion_temporarily_unavailable",
      "poll_too_frequent",
      "cli_connect_unavailable",
      "unsupported_cli_version",
      "authorization_expired",
      "authorization_cancelled",
      "product_unavailable",
      "access_revoked",
    ]);
    const code =
      body && typeof body.error === "string" && allowed.has(body.error)
        ? body.error
        : "request_failed";
    throw new Error(code);
  }
  return body;
}

async function connectAndScan(
  parsed: Extract<ParsedArguments, { command: "connect" }>,
  signal: AbortSignal,
  isInterrupted: () => boolean,
  runtime: CliRuntime,
) {
  let server: string;
  try {
    server = trustedServer(parsed.server);
  } catch {
    process.stderr.write("Use https://auterim.com or a local loopback URL.\n");
    return EXIT_USAGE;
  }
  if (
    !(runtime.interactive ?? Boolean(stdin.isTTY && stdout.isTTY)) ||
    (runtime.ci ?? Boolean(process.env.CI))
  ) {
    process.stderr.write(
      "Connected mode needs an interactive terminal for explicit upload consent. Run `auterim connect --dry-run` to review offline.\n",
    );
    return EXIT_ERROR;
  }
  let state: Awaited<ReturnType<typeof loadLocalProjectState>> | null = null;
  try {
    state = await loadLocalProjectState(parsed.root, {
      ...(runtime.configDirectory ? { configDirectory: runtime.configDirectory } : {}),
    });
    printLocalRecognition(state.lastSuccessfulScanAt);
  } catch {
    process.stdout.write(
      "Local project recognition is unavailable; continuing without local state.\n",
    );
  }
  process.stdout.write("\nAuterim\n\nConnecting this project to a Protected Product…\n");

  let session: {
    sessionId: string;
    userCode: string;
    pollSecret: string;
    verificationUrl: string;
    expiresAt: string;
    intervalSeconds: number;
  };
  let pendingCleanup: { sessionId: string; pollSecret: string } | null = null;
  try {
    const created = (await apiRequest(
      server,
      "/api/cli/v1/connect",
      {
        method: "POST",
      },
      signal,
    )) as Record<string, unknown> | null;
    if (
      !created ||
      typeof created.sessionId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(created.sessionId) ||
      typeof created.userCode !== "string" ||
      !/^[A-Z0-9-]{6,16}$/.test(created.userCode) ||
      typeof created.pollSecret !== "string" ||
      !/^[A-Za-z0-9_-]{32,120}$/.test(created.pollSecret) ||
      typeof created.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(created.expiresAt))
    )
      throw new Error("authorization_unavailable");
    pendingCleanup = { sessionId: created.sessionId, pollSecret: created.pollSecret };
    session = {
      sessionId: created.sessionId,
      userCode: created.userCode,
      pollSecret: created.pollSecret,
      verificationUrl: "",
      expiresAt: created.expiresAt,
      intervalSeconds:
        typeof created.intervalSeconds === "number"
          ? Math.max(2, Math.min(Math.floor(created.intervalSeconds), 10))
          : 3,
    };
    session.verificationUrl = safeVerificationUrl(created.verificationUrl, server);
  } catch (error) {
    if (pendingCleanup) await cancelSession(server, pendingCleanup);
    return printFailure(error, "authorization");
  }

  process.stdout.write(
    `\nBrowser authorization:\n${session.verificationUrl}\n\nCode: ${session.userCode}\n`,
  );
  if (!(runtime.ci ?? Boolean(process.env.CI))) {
    const opened = await (runtime.openBrowser ?? openApprovalUrl)(session.verificationUrl);
    if (!opened) process.stdout.write("Copy the approval URL above into your browser.\n");
  }

  let credential: string | null = null;
  let shouldCancel = true;
  try {
    const deadline = Math.min(Date.parse(session.expiresAt), Date.now() + 15 * 60_000);
    while (!signal.aborted && Date.now() < deadline) {
      const result = (await apiRequest(
        server,
        "/api/cli/v1/connect/poll",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId: session.sessionId, pollSecret: session.pollSecret }),
        },
        signal,
      )) as { status?: string; credential?: string; intervalSeconds?: number } | null;
      if (result?.status === "approved" && typeof result.credential === "string") {
        credential = result.credential;
        break;
      }
      if (result?.status !== "pending") {
        if (result?.status === "expired") throw new Error("authorization_expired");
        if (result?.status === "cancelled" || result?.status === "rejected")
          throw new Error("authorization_cancelled");
        if (result?.status === "product_unavailable") throw new Error("product_unavailable");
        if (result?.status === "access_revoked") throw new Error("access_revoked");
        throw new Error("authorization_unavailable");
      }
      await abortableDelay(
        Math.max(2, Math.min(result.intervalSeconds ?? session.intervalSeconds, 10)) * 1000,
        signal,
      );
    }
    if (signal.aborted) throw new Error("interrupted");
    if (!credential) throw new Error("authorization_expired");

    process.stdout.write("\nLocal discovery:\n");
    const result = await scanProject({ root: parsed.root, signal });
    if (signal.aborted || result.status === "cancelled") throw new Error("interrupted");
    if (result.status === "failed") throw new Error("local_scan_failed");
    if (result.status === "complete") {
      try {
        state = await markLocalScanSuccessful(parsed.root, new Date(), {
          ...(runtime.configDirectory ? { configDirectory: runtime.configDirectory } : {}),
        });
      } catch {
        process.stdout.write("Local scan was not saved to local recognition state.\n");
      }
    }
    process.stdout.write(`✓ ${result.stats.filesVisited} files inspected\n`);
    const providerNames = [
      ...new Set(
        result.observations.flatMap((item) =>
          item.providerCandidate.status === "known" && item.providerCandidate.providerName
            ? [item.providerCandidate.providerName]
            : [],
        ),
      ),
    ].sort();
    process.stdout.write(`✓ ${providerNames.length} known provider candidates\n`);
    process.stdout.write("✓ 0 secret values uploaded\n\n");
    process.stdout.write(`${renderReview(result)}\n\n`);
    const payloadText = serializeDiscoveryPayload(result);
    process.stdout.write(
      `Ready to submit derived metadata (${Buffer.byteLength(payloadText, "utf8")} bytes).\n` +
        "The upload may include relative paths, the project folder name, and sanitized Git remote identity. Source files, environment values, and secrets are not uploaded.\n",
    );
    const consent = await (runtime.confirm ?? confirmUpload)(signal);
    if (consent === "interrupted" || signal.aborted) throw new Error("interrupted");
    if (!consent) {
      process.stdout.write("Submission declined. No discovery scan was submitted.\n");
      return EXIT_USER_CANCELLED;
    }
    let submitted: {
      accepted?: boolean;
      scanId?: string;
      idempotent?: boolean;
      observationCount?: number;
    };
    try {
      submitted = (await apiRequest(
        server,
        "/api/cli/v1/discovery",
        {
          method: "POST",
          headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
          body: payloadText,
        },
        signal,
      )) as typeof submitted;
    } catch (error) {
      return printFailure(error, "submission");
    }
    if (!submitted?.accepted || !submitted.scanId)
      return printFailure(new Error("submission_failed"), "submission");
    process.stdout.write(
      `\n✓ Product protection evidence updated\nAccepted local discovery scan ${submitted.scanId}; ${submitted.observationCount ?? 0} observations.\n\nView the Product Protection Graph in Auterim.\n`,
    );
    shouldCancel = false;
    return EXIT_OK;
  } catch (error) {
    if (
      signal.aborted ||
      isInterrupted() ||
      (error instanceof Error && error.message === "interrupted")
    ) {
      process.stderr.write("\nConnection interrupted. Any pending authorization was cancelled.\n");
      return EXIT_INTERRUPTED;
    }
    return printFailure(error, "authorization");
  } finally {
    credential = null;
    if (shouldCancel) await cancelSession(server, session);
    session.pollSecret = "";
  }
}

function printLocalRecognition(lastSuccessfulScanAt: string | null) {
  process.stdout.write("Auterim recognizes this local project.\n");
  if (lastSuccessfulScanAt) {
    process.stdout.write(`Last successful local scan: ${lastSuccessfulScanAt}\n`);
    process.stdout.write("Reconnect to a Product to refresh evidence.\n");
  }
}

async function abortableDelay(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw new Error("interrupted");
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("interrupted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function confirmUpload(signal: AbortSignal): Promise<boolean | "interrupted"> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (
      (await prompt.question("Submit this derived metadata to Auterim? [y/N] ", { signal }))
        .trim()
        .toLowerCase() === "y"
    );
  } catch {
    return "interrupted";
  } finally {
    prompt.close();
  }
}

async function cancelSession(server: string, session: { sessionId: string; pollSecret: string }) {
  try {
    await fetch(new URL("/api/cli/v1/connect/cancel", server), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.sessionId, pollSecret: session.pollSecret }),
      signal: AbortSignal.timeout(2_000),
      redirect: "error",
    });
  } catch {
    // Best-effort cleanup is deliberately silent; the server session expires automatically.
  }
}

function printFailure(error: unknown, phase: "authorization" | "submission") {
  const code = safeError(error);
  const message = userMessage(code);
  process.stderr.write(`${message}\n`);
  if (code === "interrupted") return EXIT_INTERRUPTED;
  if (code === "local_scan_failed" || code === "scan_partial") return EXIT_SCAN;
  if (phase === "submission") return EXIT_SUBMISSION;
  return EXIT_AUTHORIZATION;
}

function safeError(error: unknown) {
  const code = error instanceof Error ? error.message : "request_failed";
  const safe = new Set([
    "auterim_unavailable",
    "rate_limited",
    "temporarily_unavailable",
    "invalid_cli_payload",
    "payload_too_large",
    "scan_id_conflict",
    "submission_limit_reached",
    "ingestion_credential_unavailable",
    "ingestion_temporarily_unavailable",
    "poll_too_frequent",
    "cli_connect_unavailable",
    "unsupported_cli_version",
    "authorization_expired",
    "authorization_cancelled",
    "authorization_unavailable",
    "product_unavailable",
    "access_revoked",
    "local_scan_failed",
    "interrupted",
    "submission_failed",
  ]);
  return safe.has(code) ? code : "request_failed";
}

function userMessage(code: string) {
  const messages: Record<string, string> = {
    auterim_unavailable: "Auterim could not be reached. Check your connection and try again.",
    rate_limited: "Too many connection attempts. Wait a moment and try again.",
    poll_too_frequent: "Authorization is being checked too often. Wait a moment and try again.",
    temporarily_unavailable: "Auterim is temporarily unavailable. Try again shortly.",
    cli_connect_unavailable: "Auterim could not start the connection. Try again shortly.",
    unsupported_cli_version: "Your Auterim CLI is out of date. Run `npx auterim@latest connect`.",
    authorization_expired: "Browser authorization expired. Run `auterim connect` to start again.",
    authorization_cancelled:
      "Browser authorization was cancelled. Run `auterim connect` when ready.",
    authorization_unavailable:
      "Authorization could not be completed. Check the browser approval and retry.",
    product_unavailable:
      "The selected Product is unavailable. Choose an active Product and reconnect.",
    access_revoked:
      "Workspace access changed during authorization. Ask an owner/admin to reconnect.",
    invalid_cli_payload: "Auterim rejected the discovery summary. Update the CLI and try again.",
    payload_too_large:
      "The discovery summary is too large to submit. Review the project size and retry.",
    scan_id_conflict:
      "This scan identity was already used for different data. Start a fresh connection and scan.",
    submission_limit_reached:
      "The Product has reached its discovery submission limit. Try again later.",
    ingestion_credential_unavailable:
      "The connection expired before submission. Start a fresh connection and scan.",
    ingestion_temporarily_unavailable:
      "Auterim could not save the discovery summary. Start a fresh connection and rescan.",
    local_scan_failed: "Local discovery failed. Check the project directory and retry.",
    interrupted: "Connection interrupted.",
    submission_failed:
      "Auterim did not confirm the submission. Start a fresh connection and rescan before retrying.",
  };
  return (
    messages[code] ??
    "The Auterim connection could not be completed. Run `auterim connect` to retry."
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
