import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnvironment } from "@/lib/env/schema";
import { parseBaselineAcceptanceEnvironment } from "@/lib/m15/baseline-acceptance-environment";
import { createBaselineAcceptanceSupabaseClient } from "@/lib/supabase/baseline-acceptance";

const requiredBaselineEnvironment = {
  NEXT_PUBLIC_SUPABASE_URL: "https://lnljaacbptrubppoypaz.supabase.co",
  SUPABASE_SECRET_KEY: "baseline-supabase-secret-marker",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_PRIVATE_KEY: "baseline-github-private-key-marker",
};

describe("M15.7 baseline acceptance environment", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("initializes without connector encryption configuration", () => {
    expect(parseBaselineAcceptanceEnvironment(requiredBaselineEnvironment)).toMatchObject({
      NEXT_PUBLIC_SUPABASE_URL: requiredBaselineEnvironment.NEXT_PUBLIC_SUPABASE_URL,
      GITHUB_APP_ID: requiredBaselineEnvironment.GITHUB_APP_ID,
    });
  });

  it("constructs the baseline Supabase client without connector keyring settings", () => {
    for (const [name, value] of Object.entries(requiredBaselineEnvironment)) {
      vi.stubEnv(name, value);
    }
    vi.stubEnv("CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS", "");
    vi.stubEnv("CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION", "");
    expect(createBaselineAcceptanceSupabaseClient()).toBeTruthy();
  });

  it("does not require the active connector key version", () => {
    expect(
      parseBaselineAcceptanceEnvironment({
        ...requiredBaselineEnvironment,
        CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS: undefined,
        CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION: undefined,
      }).GITHUB_APP_ID,
    ).toBe("123456");
  });

  it.each([
    ["server Supabase credential", { SUPABASE_SECRET_KEY: undefined }],
    ["GitHub App ID", { GITHUB_APP_ID: undefined }],
    ["GitHub App key", { GITHUB_APP_PRIVATE_KEY: undefined }],
  ])("fails closed when %s is missing without echoing secret values", (_name, missing) => {
    let errorText = "";
    try {
      parseBaselineAcceptanceEnvironment({ ...requiredBaselineEnvironment, ...missing });
    } catch (error) {
      errorText = error instanceof Error ? error.message : "unknown";
    }
    expect(errorText).not.toContain("baseline-supabase-secret-marker");
    expect(errorText).not.toContain("baseline-github-private-key-marker");
    expect(errorText.length).toBeGreaterThan(0);
    expect(() =>
      parseBaselineAcceptanceEnvironment({ ...requiredBaselineEnvironment, ...missing }),
    ).toThrow();
  });

  it("rejects any Supabase URL outside the fixed Auterim project", () => {
    expect(() =>
      parseBaselineAcceptanceEnvironment({
        ...requiredBaselineEnvironment,
        NEXT_PUBLIC_SUPABASE_URL: "https://other-project.supabase.co",
      }),
    ).toThrow("Baseline acceptance is restricted to the authorized Auterim Supabase project.");
  });

  it("preserves strict normal application connector encryption validation", () => {
    expect(() =>
      parseEnvironment({
        VERCEL_CLIENT_ID: "configured-vercel-client",
        CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS: undefined,
        CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION: undefined,
      }),
    ).toThrow("Connector OAuth requires versioned connector credential encryption keys.");
  });

  it("does not log baseline credentials during parsing", () => {
    const originalLog = console.log;
    const originalError = console.error;
    const output: unknown[][] = [];
    console.log = (...args: unknown[]) => output.push(args);
    console.error = (...args: unknown[]) => output.push(args);
    try {
      parseBaselineAcceptanceEnvironment(requiredBaselineEnvironment);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(JSON.stringify(output)).not.toContain("baseline-supabase-secret-marker");
    expect(JSON.stringify(output)).not.toContain("baseline-github-private-key-marker");
  });
});
