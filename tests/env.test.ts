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
    });
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
      }),
    ).toMatchObject({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
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
