import { describe, expect, it, vi } from "vitest";
import {
  classifyRuntimeContext,
  hasConnectorCapability,
  normalizeProviderFailure,
  safeConnectorResource,
} from "@/lib/connectors/model";
import { connectorStateHash, newOAuthSecrets } from "@/lib/connectors/service";
import {
  createLinearIssue,
  normalizeSlackApiFailure,
  readSentryRuntimeContext,
  SENTRY_RUNTIME_RESPONSE_MAX_BYTES,
  type ProviderCredentials,
} from "@/lib/connectors/providers";

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

  it("keeps transient Slack discovery errors out of the permission-loss path", () => {
    expect(normalizeSlackApiFailure("internal_error")).toMatchObject({
      category: "PROVIDER_UNAVAILABLE",
      retryable: true,
    });
    expect(normalizeSlackApiFailure("ratelimited", 7200)).toMatchObject({
      category: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: 3600,
    });
    expect(normalizeSlackApiFailure("missing_scope").category).toBe("PERMISSION_MISSING");
  });

  it("marks ambiguous Linear create responses retryable so callers reconcile before retrying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ errors: [{ message: "private provider details" }] }, { status: 200 }),
      ),
    );
    try {
      await expect(
        createLinearIssue(
          { accessToken: "fixture-token", refreshToken: null, expiresAt: null, scopes: [] },
          { teamId: "team-1", title: "Verified risk", description: "Grounded finding" },
        ),
      ).rejects.toMatchObject({
        category: "TRANSIENT",
        retryable: true,
        safeMessage: "Linear issue creation could not be confirmed; reconcile before retrying.",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("bounds Sentry runtime response bytes and exposes only sanitized issue metadata", async () => {
    const credentials: ProviderCredentials = {
      accessToken: "fixture-token",
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(SENTRY_RUNTIME_RESPONSE_MAX_BYTES + 1))),
    );
    try {
      await expect(
        readSentryRuntimeContext(credentials, {
          organizationSlug: "auterim",
          projectSlugs: ["web"],
          windowStart: "2026-10-01T00:00:00.000Z",
          windowEnd: "2026-10-02T00:00:00.000Z",
          providerIdentifiers: ["stripe"],
        }),
      ).rejects.toMatchObject({ category: "PROVIDER_UNAVAILABLE" });

      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json([
            {
              id: "12345",
              firstSeen: "2026-10-01T01:00:00.000Z",
              lastSeen: "2026-10-01T02:00:00.000Z",
              metadata: {
                type: "StripeAuthenticationError",
                value: "private-person@example.com SECRET_SENTINEL",
              },
            },
          ]),
        ),
      );
      const result = await readSentryRuntimeContext(credentials, {
        organizationSlug: "auterim",
        projectSlugs: ["web"],
        windowStart: "2026-10-01T00:00:00.000Z",
        windowEnd: "2026-10-02T00:00:00.000Z",
        providerIdentifiers: ["stripe"],
      });
      expect(result.result).toBe("runtime_signal_found");
      expect(JSON.stringify(result)).not.toContain("private-person@example.com");
      expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
