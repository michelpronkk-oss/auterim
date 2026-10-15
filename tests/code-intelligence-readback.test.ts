import { describe, expect, it } from "vitest";
import {
  assessPartialCauses,
  classifySkipReason,
  isSafeReadbackPath,
  persistedCredentialLikeValueCount,
  safeReadbackValue,
  safeSourceSpanMatch,
} from "@/lib/code-intelligence/readback";

describe("bounded Code Intelligence readback", () => {
  it("accepts repository-relative paths and rejects traversal and platform separators", () => {
    expect(isSafeReadbackPath("src/payments/client.ts")).toBe(true);
    expect(isSafeReadbackPath("../.env")).toBe(false);
    expect(isSafeReadbackPath("src\\client.ts")).toBe(false);
    expect(isSafeReadbackPath("/etc/passwd")).toBe(false);
  });

  it("allowlists normalized structural values and withholds credential-like values", () => {
    expect(safeReadbackValue("package", "@stripe/stripe-js@^4.0.0")).toBe(
      "@stripe/stripe-js@^4.0.0",
    );
    expect(safeReadbackValue("package", "stripe@4.0.0?token=ghp_secret123456789012345")).toBeNull();
    expect(safeReadbackValue("endpoint", "https://api.example.test/v1?token=secret")).toBe(
      "https://api.example.test/v1",
    );
    expect(
      persistedCredentialLikeValueCount([
        "OPENAI_API_KEY",
        "ghp_12345678901234567890",
        "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789",
      ]),
    ).toBe(2);
  });

  it("checks package/import facts against exact source without relying on stored line hints", () => {
    const packageJson = '{"dependencies":{"stripe":"^4.0.0"}}';
    expect(safeSourceSpanMatch("package", "stripe@4.0.0", "package.json", packageJson, 1, 1)).toBe(
      true,
    );
    const source = 'const value = 1;\nimport { Stripe } from "stripe";';
    expect(safeSourceSpanMatch("import", "stripe", "src/client.ts", source, 1, 1)).toBe(true);
  });

  it("keeps generated-directory coverage explicitly incomplete", () => {
    expect(classifySkipReason("generated_directory:dist", "dist")).toBe("OTHER_INCOMPLETE");
    expect(
      assessPartialCauses([{ reason: "generated_directory:dist", path: "dist" }]).causes[0]
        ?.classification,
    ).toBe("OTHER_INCOMPLETE");
  });

  it("classifies explicit source bounds and expected security exclusions separately", () => {
    expect(classifySkipReason("file_size_limit", "src/large.ts")).toBe(
      "SUPPORTED_SOURCE_COVERAGE_GAP",
    );
    expect(classifySkipReason("environment_file_excluded", ".env.local")).toBe(
      "EXPECTED_SECURITY_SKIP",
    );
  });
});
