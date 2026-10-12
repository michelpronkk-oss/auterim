import { afterEach, describe, expect, it, vi } from "vitest";
import { logConnectorCallbackStage } from "@/lib/connectors/callback-telemetry";

describe("connector callback telemetry", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs bounded stage metadata and excludes arbitrary provider or credential data", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    logConnectorCallbackStage({
      provider: "vercel",
      stage: "persistence",
      outcome: "failed",
      reason: "authorization_save_failed",
      databaseCode: "22023",
    });

    expect(log).toHaveBeenCalledOnce();
    const record = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).toEqual({
      event: "connector_callback",
      provider: "vercel",
      stage: "persistence",
      outcome: "failed",
      reason: "authorization_save_failed",
      databaseCode: "22023",
    });
    expect(JSON.stringify(record)).not.toMatch(
      /accessToken|refreshToken|client_secret|ciphertext|oauth.?code|state=/i,
    );
  });

  it("omits malformed database codes rather than logging arbitrary error text", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    logConnectorCallbackStage({
      provider: "vercel",
      stage: "persistence",
      outcome: "failed",
      reason: "rpc_error",
      databaseCode: "secret-like-message",
    });
    const record = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).not.toHaveProperty("databaseCode");
  });
});
