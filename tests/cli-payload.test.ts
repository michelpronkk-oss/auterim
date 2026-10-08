import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCliDiscoveryPayload } from "@/lib/cli/payload";
import { scanProject, serializeDiscoveryPayload } from "../packages/cli/src/scanner/index.js";

const fixture = fileURLToPath(new URL("../packages/cli/fixtures/projects/basic", import.meta.url));

async function safePayload() {
  const scanned = await scanProject({ root: fixture });
  return JSON.parse(serializeDiscoveryPayload(scanned) as string) as Record<string, unknown>;
}

describe("server-side M15.6 CLI payload contract", () => {
  it("accepts the strict bounded Phase 1 contract", async () => {
    const payload = await safePayload();
    expect(parseCliDiscoveryPayload(payload)).toMatchObject({
      schemaVersion: "1.0.0",
      projectFingerprint: null,
      status: "complete",
    });
  });

  it("rejects extra fields, absolute paths, and secret-shaped values", async () => {
    const extra = await safePayload();
    (extra as Record<string, unknown>).workspaceId = "another tenant";
    expect(() => parseCliDiscoveryPayload(extra)).toThrow();

    const absolute = await safePayload();
    const observations = absolute.observations as Array<Record<string, unknown>>;
    observations[0]!.safeRelativePath = "C:/private/project.ts";
    expect(() => parseCliDiscoveryPayload(absolute)).toThrow();

    const secret = await safePayload();
    const items = secret.observations as Array<Record<string, unknown>>;
    items[0]!.normalizedIdentifier = "sk-live-this-is-a-secret-token-value";
    expect(() => parseCliDiscoveryPayload(secret)).toThrow();
  });

  it("rejects unsupported, failed, and inconsistent scan states", async () => {
    const payload = await safePayload();
    (payload as Record<string, unknown>).scannerVersion = "99.0.0";
    expect(() => parseCliDiscoveryPayload(payload)).toThrow();

    const inconsistent = await safePayload();
    (inconsistent.stats as Record<string, unknown>).observations = 0;
    expect(() => parseCliDiscoveryPayload(inconsistent)).toThrow();
  });
});
