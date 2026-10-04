import { describe, expect, it } from "vitest";
import {
  getSupabasePublicConfig,
  isIntegrationConfigured,
  parseEnvironment,
} from "@/lib/env/schema";

describe("environment validation", () => {
  it("allows all future integrations to be absent", () => {
    expect(parseEnvironment({})).toMatchObject({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      AUTERIM_CLASSIFIER_PROVIDER: "openai",
      AUTERIM_DISCOVERY_RUNTIME_ENABLED: "0",
    });
    expect(
      parseEnvironment({ AUTERIM_DISCOVERY_RUNTIME_ENABLED: "1" })
        .AUTERIM_DISCOVERY_RUNTIME_ENABLED,
    ).toBe("1");
    expect(() => parseEnvironment({ AUTERIM_DISCOVERY_RUNTIME_ENABLED: "true" })).toThrow();
  });

  it("validates OpenAI as the supported provider and checks config without exposing its key", () => {
    expect(() => parseEnvironment({ AUTERIM_CLASSIFIER_PROVIDER: "ai-gateway" })).toThrow();
    const configured = parseEnvironment({
      AUTERIM_CLASSIFIER_PROVIDER: "openai",
      AUTERIM_CLASSIFIER_MODEL: "gpt-6.1-sol",
      OPENAI_API_KEY: "test-secret",
    });
    expect(isIntegrationConfigured("classifier", configured)).toBe(true);
    expect(configured).not.toHaveProperty("AI_GATEWAY_API_KEY");
  });

  it("keeps GitHub App configuration server-side and distinguishes fixture opt-in", () => {
    const unconfigured = parseEnvironment({});
    expect(isIntegrationConfigured("githubApp", unconfigured)).toBe(false);
    const configured = parseEnvironment({
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "auterim",
      GITHUB_APP_CLIENT_ID: "fixture-client-id",
      GITHUB_APP_CLIENT_SECRET: "fixture-client-secret",
      GITHUB_APP_PRIVATE_KEY: "fixture-private-key",
      GITHUB_APP_WEBHOOK_SECRET: "fixture-webhook-secret",
    });
    expect(isIntegrationConfigured("githubApp", configured)).toBe(true);
    expect(configured).not.toHaveProperty("NEXT_PUBLIC_GITHUB_APP_PRIVATE_KEY");
  });

  it("treats blank placeholders as unconfigured", () => {
    expect(
      parseEnvironment({
        NEXT_PUBLIC_SUPABASE_URL: "",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_SECRET_KEY: "",
        TRIGGER_SECRET_KEY: "",
        RESEND_API_KEY: "",
        RESEND_FROM_EMAIL: "",
      }),
    ).toMatchObject({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
  });

  it("requires both a server key and verified sender configuration for Resend", () => {
    const keyOnly = parseEnvironment({ RESEND_API_KEY: "test-key" });
    expect(isIntegrationConfigured("resend", keyOnly)).toBe(false);
    const configured = parseEnvironment({
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "alerts@example.test",
    });
    expect(isIntegrationConfigured("resend", configured)).toBe(false);
    const enabled = parseEnvironment({
      RESEND_API_KEY: "test-key",
      RESEND_FROM_EMAIL: "alerts@example.test",
      AUTERIM_NOTIFICATION_EMAIL_LIVE: "1",
    });
    expect(isIntegrationConfigured("resend", enabled)).toBe(true);
  });

  it("accepts Resend sender display names without loosening address validation", () => {
    expect(
      parseEnvironment({ RESEND_FROM_EMAIL: "Auterim Alerts <alerts@example.test>" })
        .RESEND_FROM_EMAIL,
    ).toBe("Auterim Alerts <alerts@example.test>");
    expect(() => parseEnvironment({ RESEND_FROM_EMAIL: "Auterim Alerts <bad-address>" })).toThrow();
    expect(() =>
      parseEnvironment({ RESEND_FROM_EMAIL: "Auterim\r\nBcc: x@example.test" }),
    ).toThrow();
  });

  it("reports Search Console configuration only when exact-property admin and encryption settings exist", () => {
    const base = {
      GOOGLE_SEARCH_CONSOLE_CLIENT_ID: "fixture-client-id",
      GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET: "fixture-client-secret",
      GOOGLE_SEARCH_CONSOLE_REDIRECT_URI:
        "https://auterim.example/api/internal/growth/search-console/callback",
      GOOGLE_SEARCH_CONSOLE_PROPERTY: "sc-domain:auterim.com",
      AUTERIM_GROWTH_ADMIN_EMAILS: "ops@example.test",
      CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({
        "1": Buffer.alloc(32, 1).toString("base64"),
      }),
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
    };
    expect(isIntegrationConfigured("searchConsole", parseEnvironment(base))).toBe(true);
    expect(() =>
      parseEnvironment({ ...base, GOOGLE_SEARCH_CONSOLE_PROPERTY: "sc-domain:other.example" }),
    ).toThrow();
    expect(
      isIntegrationConfigured(
        "searchConsole",
        parseEnvironment({ ...base, CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS: undefined }),
      ),
    ).toBe(false);
  });

  it("requires the Supabase URL and publishable key as a pair", () => {
    expect(() =>
      parseEnvironment({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co" }),
    ).toThrow("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY together.");
  });

  it("fails explicitly when a feature requests an unconfigured Supabase client", () => {
    expect(() => getSupabasePublicConfig(parseEnvironment({}))).toThrow(
      "Supabase is not configured.",
    );
  });
});
