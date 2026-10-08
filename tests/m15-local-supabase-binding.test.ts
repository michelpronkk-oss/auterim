import { describe, expect, it } from "vitest";
import {
  assertM15LocalAcceptanceEnabled,
  assertM15LocalSupabaseBinding,
  assertM15LocalSupabaseUrlsMatch,
} from "@/lib/m15/local-supabase-binding";
import { parseM15LocalSupabaseCredentials } from "@/lib/m15/local-supabase-credentials";

describe("M15 local Supabase binding guard", () => {
  it("accepts only the isolated loopback API origin when local integration is enabled", () => {
    for (const url of [
      "http://127.0.0.1:65431",
      "http://localhost:65431",
      "http://[::1]:65431",
      "http://127.0.0.1:64131",
      "http://localhost:64131",
      "http://[::1]:64131",
    ]) {
      expect(() =>
        assertM15LocalSupabaseBinding({ enabled: "1", nodeEnv: "development", url }),
      ).not.toThrow();
    }
  });

  it.each([
    "https://lnljaacbptrubppoypaz.supabase.co",
    "http://127.0.0.1",
    "http://0.0.0.0:64131",
    "https://127.0.0.1:64131",
    "http://192.168.1.10:64131",
    "http://127.0.0.1:64131/other",
    "http://127.0.0.1:65431/other",
    "http://127.0.0.1:65431?redirect=outside",
    "http://user:password@127.0.0.1:65431",
  ])("rejects a non-isolated worker target: %s", (url) => {
    expect(() =>
      assertM15LocalSupabaseBinding({ enabled: "1", nodeEnv: "development", url }),
    ).toThrow("m15_local_worker_supabase_target_forbidden");
  });

  it("rejects production execution even if its URL is local", () => {
    expect(() =>
      assertM15LocalSupabaseBinding({
        enabled: "1",
        nodeEnv: "production",
        url: "http://127.0.0.1:65431",
      }),
    ).toThrow("m15_local_worker_production_forbidden");
  });

  it("leaves ordinary non-acceptance runtime binding unchanged", () => {
    expect(() =>
      assertM15LocalSupabaseBinding({
        enabled: undefined,
        nodeEnv: "production",
        url: "https://example.supabase.co",
      }),
    ).not.toThrow();
  });

  it("requires the explicit local flag and rejects hosted acceptance targets", () => {
    expect(() =>
      assertM15LocalAcceptanceEnabled({
        enabled: undefined,
        nodeEnv: "test",
        url: undefined,
      }),
    ).toThrow("m15_local_acceptance_flag_required");
    expect(() =>
      assertM15LocalAcceptanceEnabled({
        enabled: "1",
        nodeEnv: "test",
        url: "https://lnljaacbptrubppoypaz.supabase.co",
      }),
    ).toThrow("m15_local_worker_supabase_target_forbidden");
  });

  it("parses only process credentials bound to the isolated local target", () => {
    const local = parseM15LocalSupabaseCredentials(
      {
        url: "http://127.0.0.1:65431",
        secretKey: "local-test-secret-key-material",
      },
      "development",
    );
    expect(local).toEqual({
      url: "http://127.0.0.1:65431",
      secretKey: "local-test-secret-key-material",
    });
  });

  it("requires browser and server Supabase clients to use the same exact local target", () => {
    expect(() =>
      assertM15LocalSupabaseUrlsMatch("http://127.0.0.1:64131", "http://127.0.0.1:64131"),
    ).not.toThrow();
    expect(() =>
      assertM15LocalSupabaseUrlsMatch(
        "http://127.0.0.1:64131",
        "https://lnljaacbptrubppoypaz.supabase.co",
      ),
    ).toThrow("m15_local_worker_supabase_target_mismatch");
  });

  it("fails closed for hosted targets, production, and missing credentials", () => {
    expect(() =>
      parseM15LocalSupabaseCredentials(
        {
          url: "https://lnljaacbptrubppoypaz.supabase.co",
          secretKey: "local-test-secret-key-material",
        },
        "development",
      ),
    ).toThrow("m15_local_supabase_credentials_target_forbidden");
    expect(() =>
      parseM15LocalSupabaseCredentials(
        { url: "http://127.0.0.1:65431", secretKey: "local-test-secret-key-material" },
        "production",
      ),
    ).toThrow("m15_local_supabase_credentials_target_forbidden");
    expect(() =>
      parseM15LocalSupabaseCredentials({ url: undefined, secretKey: undefined }, "development"),
    ).toThrow("m15_local_supabase_credentials_invalid");
  });
});
