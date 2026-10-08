#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderReview, scanProject, serializeDiscoveryPayload } from "./scanner/index.js";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;
const EXIT_INTERRUPTED = 130;

type ParsedArguments = { root: string };

function parseArguments(arguments_: string[]): ParsedArguments | null {
  if (arguments_.length < 2 || arguments_[0] !== "connect" || arguments_[1] !== "--dry-run") {
    return null;
  }

  let root = process.cwd();
  for (let index = 2; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--root") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) return null;
      root = value;
      index += 1;
      continue;
    }
    return null;
  }

  return { root: resolve(root) };
}

function printUsage() {
  process.stderr.write(
    "Usage: auterim connect --dry-run [--root <project-directory>]\n" +
      "Scans local manifests and prints a review plus the derived payload. Nothing is uploaded.\n",
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
