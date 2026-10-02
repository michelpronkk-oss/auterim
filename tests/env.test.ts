import { describe, expect, it } from "vitest";
import { getSupabasePublicConfig, parseEnvironment } from "@/lib/env/schema";

describe("environment validation", () => {
  it("allows all future integrations to be absent", () => {
    expect(parseEnvironment({})).toMatchObject({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
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
