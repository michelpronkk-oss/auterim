#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { renderReview, scanProject, serializeDiscoveryPayload } from "./scanner/index.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

type ParsedArguments =
  { root: string; mode: "dry-run" } | { root: string; mode: "connect"; server: string };

function parseArguments(arguments_: string[]): ParsedArguments | null {
  if (arguments_[0] !== "connect" || arguments_.length < 2) return null;
  let mode: "dry-run" | "connect" | null =
    arguments_[1] === "--dry-run" ? "dry-run" : arguments_[1] === "--server" ? "connect" : null;
  if (!mode) return null;
  let root = process.cwd();
  let server = mode === "connect" ? (arguments_[2] ?? "") : "";
  if (mode === "connect" && (!server || server.startsWith("--"))) return null;
  for (let index = mode === "connect" ? 3 : 2; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) return null;
      root = value;
      index += 1;
      continue;
    }
    if (argument === "--server" && mode === "dry-run") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) return null;
      mode = "connect";
      server = value;
      index += 1;
      continue;
    }
    return null;
  }
  if (mode === "connect" && !server) return null;
  return mode === "dry-run" ? { root: resolve(root), mode } : { root: resolve(root), mode, server };
}

function printUsage() {
  process.stderr.write(
    "Usage: auterim connect --dry-run [--root <project-directory>]\n" +
      "       auterim connect --server <https://auterim.com|http://127.0.0.1:3000> [--root <project-directory>]\n" +
      "Dry-run is offline. The connected mode asks for browser approval and interactive consent before upload.\n",
  );
}

export async function main(arguments_ = process.argv.slice(2)): Promise<number> {
  const parsed = parseArguments(arguments_);
  if (!parsed) {
    printUsage();
    return EXIT_USAGE;
  }

  const controller = new AbortController();
  let interrupted = false;
  const onInterrupt = () => {
    interrupted = true;
    controller.abort(new Error("interrupted"));
  };
  process.once("SIGINT", onInterrupt);

  try {
    if (parsed.mode === "connect") return await connectAndScan(parsed, controller.signal);
    const result = await scanProject({ root: parsed.root, signal: controller.signal });
    if (interrupted) return EXIT_INTERRUPTED;

    const review = renderReview(result);
    const payload = serializeDiscoveryPayload(result);
    const serializedPayload =
      typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
    if (typeof serializedPayload !== "string") {
      throw new Error("payload_serialization_failed");
    }
    const payloadBytes = Buffer.byteLength(serializedPayload, "utf8");

    process.stdout.write(`${review.trimEnd()}\n\n`);
    process.stdout.write(`Payload prepared locally: ${payloadBytes} bytes (not sent).\n`);
    if (result.status === "failed") return EXIT_ERROR;
    return EXIT_OK;
  } catch (error) {
    if (interrupted || controller.signal.aborted) {
      process.stderr.write("Local scan interrupted.\n");
      return EXIT_INTERRUPTED;
    }

    // Scanner errors may contain paths or excerpts. Keep diagnostics deliberately generic.
    void error;
    process.stderr.write("Local scan failed: local_scan_failed\n");
    return EXIT_ERROR;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
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

async function apiRequest(server: string, path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(new URL(path, server), {
      ...init,
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
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
  parsed: Extract<ParsedArguments, { mode: "connect" }>,
  signal: AbortSignal,
) {
  let server: string;
  try {
    server = trustedServer(parsed.server);
  } catch {
    process.stderr.write("Use https://auterim.com or a local loopback URL.\n");
    return EXIT_USAGE;
  }
  let session: {
    sessionId: string;
    userCode: string;
    pollSecret: string;
    verificationUrl: string;
    expiresAt: string;
    intervalSeconds: number;
  };
  try {
    session = (await apiRequest(server, "/api/cli/v1/connect", {
      method: "POST",
    })) as typeof session;
  } catch (error) {
    process.stderr.write(`Could not start Auterim connection: ${safeError(error)}\n`);
    return EXIT_ERROR;
  }
  process.stdout.write(
    `Authorize this CLI in your browser:\n${session.verificationUrl}\n\nCode: ${session.userCode}\n\n`,
  );
  let credential: string | null = null;
  let shouldCancel = true;
  try {
    const deadline = Math.min(Date.parse(session.expiresAt), Date.now() + 15 * 60_000);
    while (!signal.aborted && Date.now() < deadline) {
      const result = (await apiRequest(server, "/api/cli/v1/connect/poll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId, pollSecret: session.pollSecret }),
      })) as { status?: string; credential?: string; intervalSeconds?: number };
      if (result.status === "approved" && typeof result.credential === "string") {
        credential = result.credential;
        break;
      }
      if (result.status !== "pending")
        throw new Error(
          result.status === "expired" ? "authorization_expired" : "authorization_unavailable",
        );
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, Math.max(1, Math.min(result.intervalSeconds ?? 3, 10)) * 1000),
      );
    }
    if (signal.aborted) throw new Error("interrupted");
    if (!credential) throw new Error("authorization_expired");
    const result = await scanProject({ root: parsed.root, signal });
    if (signal.aborted || result.status === "failed" || result.status === "cancelled")
      throw new Error("local_scan_failed");
    const payload = serializeDiscoveryPayload(result);
    const payloadText = typeof payload === "string" ? payload : JSON.stringify(payload);
    process.stdout.write(
      `\n${renderReview(result)}\n\nThis uploads ${Buffer.byteLength(payloadText, "utf8")} bytes of derived metadata for the selected Product.\n`,
    );
    if (!(await confirmUpload())) {
      process.stdout.write("Upload cancelled. No scan was submitted.\n");
      return EXIT_OK;
    }
    const submitted = (await apiRequest(server, "/api/cli/v1/discovery", {
      method: "POST",
      headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
      body: payloadText,
    })) as { accepted?: boolean; scanId?: string; idempotent?: boolean; observationCount?: number };
    if (!submitted.accepted || !submitted.scanId) throw new Error("submission_failed");
    process.stdout.write(
      `Accepted local discovery scan ${submitted.scanId}; ${submitted.observationCount ?? 0} observations.\n`,
    );
    shouldCancel = false;
    return EXIT_OK;
  } catch (error) {
    process.stderr.write(`Auterim connection stopped: ${safeError(error)}\n`);
    return signal.aborted ? EXIT_INTERRUPTED : EXIT_ERROR;
  } finally {
    credential = null;
    if (shouldCancel) {
      await fetch(new URL("/api/cli/v1/connect/cancel", server), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: session.sessionId, pollSecret: session.pollSecret }),
        signal: AbortSignal.timeout(2_000),
        redirect: "error",
      }).catch(() => undefined);
    }
    session.pollSecret = "";
  }
}

async function confirmUpload() {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    return (
      (await prompt.question("Submit this derived metadata to Auterim? [y/N] "))
        .trim()
        .toLowerCase() === "y"
    );
  } finally {
    prompt.close();
  }
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
    "authorization_expired",
    "authorization_unavailable",
    "local_scan_failed",
    "interrupted",
    "submission_failed",
  ]);
  return safe.has(code) ? code : "request_failed";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
