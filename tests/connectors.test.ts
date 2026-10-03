import { describe, expect, it } from "vitest";
import {
  classifyRuntimeContext,
  hasConnectorCapability,
  normalizeProviderFailure,
  safeConnectorResource,
} from "@/lib/connectors/model";
import { connectorStateHash, newOAuthSecrets } from "@/lib/connectors/service";

describe("connector platform safety contracts", () => {
  it("creates high entropy independent OAuth state and browser binding", () => {
    const first = newOAuthSecrets();
    const second = newOAuthSecrets();
    expect(first.state).not.toBe(second.state);
    expect(first.browserBinding).not.toBe(first.state);
    expect(Buffer.from(first.state, "base64url")).toHaveLength(32);
    expect(Buffer.from(first.browserBinding, "base64url")).toHaveLength(32);
    expect(connectorStateHash(first.state)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("maps GitHub to repository verification and only provider capabilities", () => {
    expect(hasConnectorCapability("github", "CAN_VERIFY")).toBe(true);
    expect(hasConnectorCapability("github", "CAN_RECEIVE_ALERTS")).toBe(false);
    expect(hasConnectorCapability("slack", "CAN_RECEIVE_ALERTS")).toBe(true);
  });

  it("keeps provider resource metadata allowlisted and redacts secret-shaped values", () => {
    expect(
      safeConnectorResource({
        id: "C123",
        type: "channel",
        name: "#alerts\nunsafe",
        metadata: {
          isPrivate: false,
          isMember: true,
          token: "xoxb-not-safe",
          email: "user@example.com",
          opaque: "ignored",
        },
      }),
    ).toEqual({
      externalResourceId: "C123",
      resourceType: "channel",
      displayName: "#alerts unsafe",
      metadata: { isPrivate: false, isMember: true },
    });
  });

  it("uses conservative Sentry correlation and never states causality", () => {
    const common = {
      errors: [
        {
          issueId: "81",
          type: "StripeAuthenticationError",
          firstSeen: "2026-10-01T00:00:00Z",
          lastSeen: "2026-10-01T01:00:00Z",
          count: 4,
        },
      ],
      windowStart: "2026-10-01T00:30:00Z",
      windowEnd: "2026-10-01T02:00:00Z",
    };
    expect(classifyRuntimeContext({ ...common, providerIdentifiers: ["Supabase"] }).result).toBe(
      "runtime_signal_inconclusive",
    );
    expect(classifyRuntimeContext({ ...common, providerIdentifiers: ["stripe"] })).toMatchObject({
      result: "runtime_signal_found",
      matchedIssueIds: ["81"],
    });
    expect(
      classifyRuntimeContext({ ...common, providerIdentifiers: ["stripe"], windowStart: "invalid" })
        .result,
    ).toBe("runtime_signal_inconclusive");
  });

  it("normalizes provider rate limits with a bounded retry hint", () => {
    const error = normalizeProviderFailure("slack", 429, "7200");
    expect(error.category).toBe("RATE_LIMITED");
    expect(error.retryable).toBe(true);
    expect(error.retryAfterSeconds).toBe(3600);
    expect(normalizeProviderFailure("sentry", 503, null).category).toBe("PROVIDER_UNAVAILABLE");
    expect(normalizeProviderFailure("linear", 401, null).category).toBe("AUTH_REQUIRED");
  });
});
