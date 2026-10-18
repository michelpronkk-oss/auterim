import { describe, expect, it } from "vitest";
import {
  freshAcceptanceDispatchKey,
  M1578R_FRESH_ACCEPTANCE_KEY,
  M1578R_FRESH_V3_ACCEPTANCE_KEY,
  M1578R_FRESH_FIXTURE_COMMIT_SHA,
  M1578RInternalTestAcceptanceInputSchema,
  sanitizeFreshEndpointReferences,
  sanitizeM1578RVerificationChecks,
} from "../src/trigger/m1578r-internal-test-acceptance";

describe("M15.78R bounded Fix Run status readback", () => {
  it("accepts only the fixed readback action without caller-supplied IDs", () => {
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({ action: "read_fix_status" }).success,
    ).toBe(true);
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({
        action: "read_fix_status",
        fixRunId: "caller-controlled",
      }).success,
    ).toBe(false);
  });

  it("exposes a distinct fixed-scope fresh acceptance generation without caller identities", () => {
    expect(M1578R_FRESH_ACCEPTANCE_KEY).not.toBe("m1578r-internal-qa-fix-engine-v1");
    expect(M1578R_FRESH_FIXTURE_COMMIT_SHA).toBe("94135df6f85bfb34ac83c046e5541e1ad8d73a86");
    for (const action of [
      "verify_fresh",
      "create_fresh_source",
      "dispatch_fresh_intelligence",
      "read_fresh_status",
      "start_fresh_fix_run",
    ] as const) {
      expect(M1578RInternalTestAcceptanceInputSchema.safeParse({ action }).success).toBe(true);
      expect(
        M1578RInternalTestAcceptanceInputSchema.safeParse({
          action,
          workspaceId: "caller-controlled",
          repositoryId: "caller-controlled",
          fixRunId: "caller-controlled",
        }).success,
      ).toBe(false);
    }
    expect(M1578R_FRESH_V3_ACCEPTANCE_KEY).toBe("m1578r-internal-qa-fix-engine-v3");
    expect(M1578R_FRESH_V3_ACCEPTANCE_KEY).not.toBe(M1578R_FRESH_ACCEPTANCE_KEY);
    for (const action of [
      "verify_fresh_v3",
      "create_fresh_v3_source",
      "dispatch_fresh_v3_intelligence",
      "read_fresh_v3_status",
      "start_fresh_v3_fix_run",
    ] as const) {
      expect(M1578RInternalTestAcceptanceInputSchema.safeParse({ action }).success).toBe(true);
      expect(
        M1578RInternalTestAcceptanceInputSchema.safeParse({
          action,
          workspaceId: "caller-controlled",
          repositoryId: "caller-controlled",
          sourceChangeId: "11111111-1111-4111-8111-111111111111",
          fixRunId: "caller-controlled",
        }).success,
      ).toBe(false);
    }
    expect(freshAcceptanceDispatchKey("11111111-1111-4111-8111-111111111111", "classify")).toBe(
      "m1578r-fresh-v2:11111111-1111-4111-8111-111111111111:classify",
    );
    expect(
      freshAcceptanceDispatchKey("11111111-1111-4111-8111-111111111111", "classify", "v3"),
    ).toBe("m1578r-fresh-v3:11111111-1111-4111-8111-111111111111:classify");
    expect(() => freshAcceptanceDispatchKey("not-a-uuid", "fix")).toThrow(
      "invalid_source_change_id",
    );
    expect(() => freshAcceptanceDispatchKey("000000000000000000000000000000000000", "fix")).toThrow(
      "invalid_source_change_id",
    );
  });

  it("returns verification metadata only and drops output or unknown fields", () => {
    expect(
      sanitizeM1578RVerificationChecks([
        {
          commandClass: "targeted_test",
          status: "passed",
          durationMs: 120,
          outputBytes: 42,
          diagnosticCategory: null,
          stdout: "must not be returned",
          secret: "must not be returned",
        },
        { commandClass: "test", status: "invalid", stdout: "ignored" },
        "malformed",
      ]),
    ).toEqual([
      {
        commandClass: "targeted_test",
        status: "passed",
        durationMs: 120,
        outputBytes: 42,
        diagnosticCategory: null,
      },
    ]);
  });

  it("returns exact safe endpoint provenance but omits query-bearing or unsafe paths", () => {
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      analysis_run_id: "22222222-2222-4222-8222-222222222222",
      workspace_id: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
      repository_id: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe",
      commit_sha: M1578R_FRESH_FIXTURE_COMMIT_SHA,
      reference_type: "endpoint" as const,
      normalized_value: "https://api.openai.com/v1/responses",
      path: "src/endpoint.ts",
      start_line: 12,
      start_column: 9,
      end_line: 12,
      end_column: 47,
      confidence_class: "exact" as const,
      extractor_type: "typescript_ast_v1",
      redacted: false,
      value_fingerprint: null,
    };
    expect(sanitizeFreshEndpointReferences([base])).toMatchObject([
      {
        normalizedValue: "https://api.openai.com/v1/responses",
        path: "src/endpoint.ts",
        startLine: 12,
        startColumn: 9,
        valueRedacted: false,
      },
    ]);

    const unsafeValue = "https://api.example.test/path?token=do-not-return";
    const [sanitized] = sanitizeFreshEndpointReferences([
      { ...base, normalized_value: unsafeValue, path: "../../.env" },
    ])!;
    expect(JSON.stringify(sanitized)).not.toContain(unsafeValue);
    expect(sanitized).toMatchObject({ normalizedValue: null, path: null, valueRedacted: true });

    const [sensitivePath] = sanitizeFreshEndpointReferences([
      { ...base, path: "config/credentials.json" },
    ])!;
    expect(sensitivePath.path).toBeNull();
  });

  it("fails closed on an unbounded or malformed endpoint-reference readback", () => {
    expect(sanitizeFreshEndpointReferences(Array.from({ length: 101 }, () => ({})))).toBeNull();
    expect(sanitizeFreshEndpointReferences([{ reference_type: "package" }])).toBeNull();
  });
});
