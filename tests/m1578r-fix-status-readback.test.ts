import { describe, expect, it } from "vitest";
import {
  freshAcceptanceDispatchKey,
  freshAcceptanceFixtureCommitSha,
  freshIntelligenceDispatchDecision,
  freshV4ActionKind,
  freshV4PrewriteDecision,
  freshV4ReplayDecision,
  M1578R_FRESH_ACCEPTANCE_KEY,
  M1578R_FRESH_V3_ACCEPTANCE_KEY,
  M1578R_FRESH_V4_ACCEPTANCE_KEY,
  M1578R_FRESH_FIXTURE_COMMIT_SHA,
  M1578R_INTERNAL_TEST_ACCEPTANCE_TARGET,
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

  it("routes V4 actions through the fixed Test fixture without caller-controlled scope", () => {
    expect(M1578R_FRESH_V4_ACCEPTANCE_KEY).toBe("m1578r-internal-qa-fix-engine-v4");
    expect(M1578R_FRESH_V4_ACCEPTANCE_KEY).not.toBe(M1578R_FRESH_V3_ACCEPTANCE_KEY);
    expect(freshAcceptanceFixtureCommitSha("v4")).toBe("94135df6f85bfb34ac83c046e5541e1ad8d73a86");
    expect(freshAcceptanceFixtureCommitSha("v4")).toBe(M1578R_FRESH_FIXTURE_COMMIT_SHA);
    expect(M1578R_INTERNAL_TEST_ACCEPTANCE_TARGET).toMatchObject({
      workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
      productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
      repositoryId: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe",
      repositoryExternalId: 1409364414,
      owner: "michelpronkk-oss",
      repository: "auterim-m15-github-qa",
      dependencyId: "3cfb1bb7-1d76-4692-932b-24e94b66f346",
      workspaceDependencyId: "867eb92b-2ed2-4917-ac68-44a22773e369",
    });

    const routes = {
      verify_fresh_v4: "verify",
      read_fresh_v4_status: "status",
      create_fresh_v4_source: "create_source",
      dispatch_fresh_v4_intelligence: "dispatch_intelligence",
      start_fresh_v4_fix_run: "start_fix_run",
    } as const;
    for (const [action, kind] of Object.entries(routes)) {
      expect(freshV4ActionKind(action)).toBe(kind);
      expect(M1578RInternalTestAcceptanceInputSchema.safeParse({ action }).success).toBe(true);
      expect(
        M1578RInternalTestAcceptanceInputSchema.safeParse({
          action,
          workspaceId: M1578R_INTERNAL_TEST_ACCEPTANCE_TARGET.workspaceId,
          repositoryId: M1578R_INTERNAL_TEST_ACCEPTANCE_TARGET.repositoryId,
          fixtureCommitSha: M1578R_FRESH_FIXTURE_COMMIT_SHA,
          sourceChangeId: "11111111-1111-4111-8111-111111111111",
        }).success,
      ).toBe(false);
    }
    expect(freshV4ActionKind("create_source")).toBeNull();
    expect(freshV4ActionKind("start_fresh_v3_fix_run")).toBeNull();
  });

  it("uses a V4-only idempotency namespace for every downstream stage", () => {
    const sourceChangeId = "11111111-1111-4111-8111-111111111111";
    for (const stage of ["classify", "intelligence", "fix"] as const) {
      const v4 = freshAcceptanceDispatchKey(sourceChangeId, stage, "v4");
      expect(v4).toBe(`m1578r-fresh-v4:${sourceChangeId}:${stage}`);
      expect(v4).not.toBe(freshAcceptanceDispatchKey(sourceChangeId, stage, "v2"));
      expect(v4).not.toBe(freshAcceptanceDispatchKey(sourceChangeId, stage, "v3"));
    }
    expect(freshAcceptanceDispatchKey(sourceChangeId, "classify", "v3")).toBe(
      `m1578r-fresh-v3:${sourceChangeId}:classify`,
    );
  });

  it("dispatches only one canonical, unclaimed queued V4 intelligence decision", () => {
    const queued = {
      status: "queued",
      engine_version: "jev-shadow-v1",
      policy_version: "intelligence-policy-v1",
      provider: "openrouter",
      model: "typesafe/jev-1.14",
      trigger_run_id: null,
      attempt_number: null,
      attempts_count: 0,
    };

    expect(freshIntelligenceDispatchDecision("v4", [queued])).toEqual({ action: "dispatch" });
    expect(freshIntelligenceDispatchDecision("v4", [])).toEqual({
      action: "blocked",
      category: "fresh_v4_intelligence_decision_missing",
    });
    expect(freshIntelligenceDispatchDecision("v4", [queued, queued])).toEqual({
      action: "blocked",
      category: "fresh_v4_intelligence_decision_ambiguous",
    });
  });

  it("waits on V4 queued decisions with active or ambiguous claim metadata", () => {
    const queued = {
      status: "queued",
      engine_version: "jev-shadow-v1",
      policy_version: "intelligence-policy-v1",
      provider: "openrouter",
      model: "typesafe/jev-1.14",
      trigger_run_id: null,
      attempt_number: null,
      attempts_count: 0,
    };

    expect(
      freshIntelligenceDispatchDecision("v4", [
        { ...queued, trigger_run_id: "run_pending", attempt_number: 1 },
      ]),
    ).toEqual({ action: "waiting", category: "fresh_v4_intelligence_claim_ambiguous" });
    expect(freshIntelligenceDispatchDecision("v4", [{ ...queued, attempts_count: 1 }])).toEqual({
      action: "waiting",
      category: "fresh_v4_intelligence_claim_ambiguous",
    });
    expect(
      freshIntelligenceDispatchDecision("v4", [
        { ...queued, trigger_run_id: "run_orphaned", attempt_number: null },
      ]),
    ).toEqual({ action: "blocked", category: "fresh_v4_intelligence_claim_ambiguous" });
  });

  it("waits for processing V4 decisions and never redispatches them", () => {
    expect(
      freshIntelligenceDispatchDecision("v4", [
        {
          status: "processing",
          engine_version: "jev-shadow-v1",
          policy_version: "intelligence-policy-v1",
          provider: "openrouter",
          model: "typesafe/jev-1.14",
          trigger_run_id: "run_active",
          attempt_number: 1,
          attempts_count: 1,
        },
      ]),
    ).toEqual({ action: "waiting", category: "fresh_v4_intelligence_processing" });
  });

  it("preserves completed V4 decisions and blocks failed V4 decisions from acceptance retries", () => {
    const base = {
      engine_version: "jev-shadow-v1",
      policy_version: "intelligence-policy-v1",
      provider: "openrouter",
      model: "typesafe/jev-1.14",
      trigger_run_id: "run_previous",
      attempt_number: 1,
      attempts_count: 1,
    };

    expect(freshIntelligenceDispatchDecision("v4", [{ ...base, status: "completed" }])).toEqual({
      action: "already_evaluated",
      decisionCount: 1,
    });
    expect(freshIntelligenceDispatchDecision("v4", [{ ...base, status: "failed" }])).toEqual({
      action: "blocked",
      category: "fresh_v4_intelligence_failed",
    });
  });

  it("keeps V4 dispatch idempotency stable and leaves V2/V3 row handling unchanged", () => {
    const sourceChangeId = "11111111-1111-4111-8111-111111111111";
    const v4Decision = {
      status: "queued",
      engine_version: "jev-shadow-v1",
      policy_version: "intelligence-policy-v1",
      provider: "openrouter",
      model: "typesafe/jev-1.14",
      trigger_run_id: null,
      attempt_number: null,
      attempts_count: 0,
    };

    expect(freshAcceptanceDispatchKey(sourceChangeId, "intelligence", "v4")).toBe(
      freshAcceptanceDispatchKey(sourceChangeId, "intelligence", "v4"),
    );
    expect(freshAcceptanceDispatchKey(sourceChangeId, "intelligence", "v4")).toBe(
      `m1578r-fresh-v4:${sourceChangeId}:intelligence`,
    );
    expect(freshIntelligenceDispatchDecision("v2", [v4Decision])).toEqual({
      action: "already_evaluated",
      decisionCount: 1,
    });
    expect(freshIntelligenceDispatchDecision("v3", [v4Decision])).toEqual({
      action: "already_evaluated",
      decisionCount: 1,
    });
  });

  it("allows V4 source creation only when readback proves the key is absent", () => {
    expect(freshV4PrewriteDecision({ status: "not_started" })).toEqual({ allowed: true });
    for (const status of ["source_created", "readback", "blocked", "ambiguous"]) {
      expect(freshV4PrewriteDecision({ status })).toEqual({
        allowed: false,
        category: "fresh_v4_acceptance_already_exists",
      });
    }
    expect(freshV4PrewriteDecision({ status: "unavailable" })).toEqual({
      allowed: false,
      category: "fresh_v4_prewrite_read_unavailable",
    });
    expect(freshV4PrewriteDecision(null)).toEqual({
      allowed: false,
      category: "fresh_v4_prewrite_read_unavailable",
    });
    expect(freshV4PrewriteDecision({})).toEqual({
      allowed: false,
      category: "fresh_v4_prewrite_read_unavailable",
    });
  });

  it("rejects an idempotent V4 source replay instead of claiming a fresh acceptance", () => {
    expect(freshV4ReplayDecision(false)).toEqual({ allowed: true });
    expect(freshV4ReplayDecision(true)).toEqual({
      allowed: false,
      category: "fresh_v4_replay_rejected",
    });
    expect(freshV4ReplayDecision(undefined)).toEqual({
      allowed: false,
      category: "fresh_v4_replay_status_invalid",
    });
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
