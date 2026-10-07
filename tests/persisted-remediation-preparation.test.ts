import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  resolveWorkspaceEntitlementsForService: vi.fn(),
  loadResult: vi.fn(),
  prepareGroundedPatch: vi.fn(),
  buildRemediationGuidance: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("@/lib/billing/server", () => ({
  resolveWorkspaceEntitlementsForService: mocks.resolveWorkspaceEntitlementsForService,
}));
vi.mock("@/lib/preflight/preflight-service", () => ({
  SupabasePreflightRepository: class {
    loadResult = mocks.loadResult;
  },
}));
vi.mock("@/lib/preflight/patch-preparation", () => ({
  prepareGroundedPatch: mocks.prepareGroundedPatch,
}));
vi.mock("@/lib/preflight/remediation", () => ({
  buildRemediationGuidance: mocks.buildRemediationGuidance,
}));

import { preparePersistedRemediation } from "@/lib/m15/persisted-remediation-preparation";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const dependencyId = "33333333-3333-4333-8333-333333333333";
const assessmentId = "44444444-4444-4444-8444-444444444444";
const classificationId = "55555555-5555-4555-8555-555555555555";
const sourceChangeId = "66666666-6666-4666-8666-666666666666";
const catalogDependencyId = "77777777-7777-4777-8777-777777777777";
const repositoryId = "88888888-8888-4888-8888-888888888888";
const connectionId = "99999999-9999-4999-8999-999999999999";
const evidenceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const pinnedSha = "a".repeat(40);

const persistedResult = {
  status: "completed",
  verifiedImpact: "verified",
  confidence: 0.94,
  repositoriesScanned: 1,
  findings: [
    {
      repositoryId,
      repository: "org/app",
      commitSha: pinnedSha,
      path: "src/provider.ts",
      lineStart: 4,
      lineEnd: 4,
      findingType: "configuration_reference",
      affectedEntity: "Model X",
      confidence: 0.94,
      verification: "verified",
      explanation: "Verified reference.",
      evidenceFingerprint: "c".repeat(64),
    },
  ],
  affectedAreas: ["src"],
  complexity: "low",
  recommendedRemediation: "Update the model.",
  effectiveAt: null,
  announcedAt: null,
  deadline: null,
  daysRemaining: null,
};

function setup(options?: { duplicate?: boolean; replacement?: boolean; synthetic?: boolean }) {
  const inserted: Record<string, unknown> = {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    proposal_kind: "patch",
    patch_validation_status: "queued",
  };
  const rows: Record<string, unknown> = {
    workspaces: { id: workspaceId },
    preflight_runs: {
      id: runId,
      workspace_id: workspaceId,
      impact_assessment_id: assessmentId,
      status: "completed",
      verified_impact: "verified",
    },
    impact_assessments: {
      id: assessmentId,
      workspace_id: workspaceId,
      workspace_dependency_id: dependencyId,
      source_change_classification_id: classificationId,
      status: "assessed",
      relevant: true,
    },
    workspace_dependencies: {
      id: dependencyId,
      workspace_id: workspaceId,
      dependency_id: catalogDependencyId,
      protected_product_id: productId,
      monitoring_enabled: true,
    },
    workspace_products: { id: productId, status: "protected" },
    source_change_classifications: {
      id: classificationId,
      change_id: sourceChangeId,
      status: "classified",
      material: true,
    },
    source_changes: { id: sourceChangeId, source_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    source_catalog: {
      id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      dependency_id: catalogDependencyId,
    },
    source_remediation_replacements:
      options?.replacement === false
        ? []
        : [
            {
              id: evidenceId,
              old_expression: "Model X",
              new_expression: "Model Y",
              evidence_source_url: "https://provider.example/changelog",
              evidence_fingerprint: "d".repeat(64),
              synthetic: options?.synthetic ?? false,
              internal_qa: options?.synthetic ?? false,
              public_eligible: !(options?.synthetic ?? false),
            },
          ],
    repositories: {
      id: repositoryId,
      workspace_id: workspaceId,
      connection_id: connectionId,
      external_id: 123,
      owner: "org",
      name: "app",
      default_branch: "main",
      status: "available",
      selected_for_protection: true,
    },
    workspace_repository_access: { repository_id: repositoryId },
    repository_connections: { id: connectionId, installation_id: 12, status: "connected" },
    product_remediation_policies: {
      enabled: true,
      draft_pr_preparation_allowed: true,
      allowed_repository_ids: [repositoryId],
    },
    remediation_proposals: options?.duplicate ? null : inserted,
  };
  const filters = new Map<string, Array<[string, unknown]>>();
  const payloads: Record<string, unknown>[] = [];
  const client = {
    from(table: string) {
      const query = {
        select: vi.fn(() => query),
        eq: vi.fn((key: string, expected: unknown) => {
          const current = filters.get(table) ?? [];
          current.push([key, expected]);
          filters.set(table, current);
          return query;
        }),
        order: vi.fn(() => query),
        or: vi.fn(() => query),
        limit: vi.fn(() => query),
        maybeSingle: vi.fn(async () => ({ data: rows[table] ?? null, error: null })),
        single: vi.fn(async () => ({
          data: rows[table] ?? { ...inserted, patch_validation_status: "queued" },
          error: null,
        })),
        then: (resolve: (result: { data: unknown; error: null }) => unknown) =>
          Promise.resolve(resolve({ data: rows[table] ?? null, error: null })),
        upsert: vi.fn((payload: Record<string, unknown>) => {
          payloads.push(payload);
          inserted.proposal_kind = payload.proposal_kind;
          inserted.patch_validation_status = payload.patch_fingerprint ? "queued" : "not_requested";
          return query;
        }),
      };
      // The final select after upsert represents an ignored duplicate when requested.
      if (table === "remediation_proposals" && options?.duplicate) {
        query.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
      }
      return query;
    },
  };
  mocks.createSupabaseServerClient.mockReturnValue(client);
  mocks.loadResult.mockResolvedValue(persistedResult);
  mocks.resolveWorkspaceEntitlementsForService.mockResolvedValue({
    capabilities: { generateFix: true },
    usage: { remediationRuns: 0 },
    limits: { remediationRuns: 10 },
  });
  mocks.buildRemediationGuidance.mockReturnValue({
    proposalKind: "grounded_guidance",
    affectedFiles: ["src/provider.ts"],
    rationale: "Verified references need a reviewed migration.",
    migrationNotes: "Consult provider documentation.",
    validationRequirements: ["Run tests."],
    fingerprint: "e".repeat(64),
  });
  mocks.prepareGroundedPatch.mockReturnValue({
    outcome: "PATCH_PREPARED",
    patch: "diff --git a/src/provider.ts b/src/provider.ts\n",
    baseCommitSha: pinnedSha,
    affectedFiles: ["src/provider.ts"],
    matchedEvidenceIds: [evidenceId],
    fingerprint: "f".repeat(64),
  });
  const provider = {
    getHead: vi.fn(),
    searchCode: vi.fn(),
    getFile: vi.fn(async (_target: unknown, path: string, ref: string) => {
      void ref;
      return { path, text: "const model = Model X;\n", size: 22 };
    }),
  };
  return { provider, filters, payloads };
}

describe("persisted remediation preparation", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("builds a bounded patch candidate from public evidence at the exact verified commit", async () => {
    const { provider, filters, payloads } = setup();
    const result = await preparePersistedRemediation({ preflightRunId: runId, provider });

    expect(result).toMatchObject({
      proposalKind: "patch",
      outcome: "patch_prepared",
    });
    expect(provider.getFile).toHaveBeenCalledWith(
      expect.objectContaining({ installationId: 12, id: repositoryId }),
      "src/provider.ts",
      pinnedSha,
    );
    expect(mocks.prepareGroundedPatch).toHaveBeenCalledWith(
      expect.objectContaining({ replacement: expect.objectContaining({ evidenceId }) }),
    );
    expect(filters.get("source_remediation_replacements")).toEqual(
      expect.arrayContaining([
        ["synthetic", false],
        ["internal_qa", false],
        ["public_eligible", true],
      ]),
    );
    expect(result.proposalCandidate).toMatchObject({
      patch_fingerprint: "f".repeat(64),
      generation_metadata: {
        syntheticEvidenceExcluded: true,
        replacementEvidenceId: evidenceId,
        repository: { id: repositoryId, owner: "org", name: "app", commitSha: pinnedSha },
      },
      created_by: null,
    });
    expect(payloads).toHaveLength(0);
  });

  it("builds grounded guidance when no production-eligible replacement exists", async () => {
    const { provider, payloads } = setup({ replacement: false });
    const result = await preparePersistedRemediation({ preflightRunId: runId, provider });

    expect(result).toMatchObject({ proposalKind: "grounded_guidance", outcome: "no_safe_patch" });
    expect(mocks.prepareGroundedPatch).not.toHaveBeenCalled();
    expect(provider.getFile).not.toHaveBeenCalled();
    expect(result.proposalCandidate).toMatchObject({
      proposal_kind: "grounded_guidance",
      patch: null,
      patch_fingerprint: null,
      generation_metadata: { outcome: "no_safe_patch", replacementEvidenceId: null },
    });
    expect(payloads).toHaveLength(0);
  });

  it("permits synthetic evidence only in the explicitly enabled non-production local integration run", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_SUPABASE_URL", "http://127.0.0.1:65431");
    vi.stubEnv("AUTERIM_M15_LOCAL_REPO_ROOT", "C:\\Users\\miche\\Desktop\\Auterim");
    const { provider, payloads } = setup({ synthetic: true });
    const result = await preparePersistedRemediation({ preflightRunId: runId, provider });

    expect(result.outcome).toBe("patch_prepared");
    expect(result.proposalCandidate).toMatchObject({
      generation_metadata: { syntheticEvidenceExcluded: false, internalQaOnly: true },
    });
    expect(payloads).toHaveLength(0);
  });

  it("rejects synthetic evidence in production even if the local QA flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
    expect(process.env["NODE_ENV"]).toBe("production");
    expect(process.env["AUTERIM_M15_LOCAL_INTEGRATION"]).toBe("1");
    const { provider } = setup({ synthetic: true });
    const result = await preparePersistedRemediation({ preflightRunId: runId, provider });
    expect(result).toMatchObject({ outcome: "no_safe_patch", proposalKind: "grounded_guidance" });
    expect(mocks.prepareGroundedPatch).not.toHaveBeenCalled();
    expect(provider.getFile).not.toHaveBeenCalled();
  });

  it("does not fetch files or persist when canonical Generate Fix entitlement is absent", async () => {
    const { provider, payloads } = setup();
    mocks.resolveWorkspaceEntitlementsForService.mockResolvedValueOnce({
      capabilities: { generateFix: false },
      usage: { remediationRuns: 0 },
      limits: { remediationRuns: 10 },
    });

    await expect(preparePersistedRemediation({ preflightRunId: runId, provider })).rejects.toThrow(
      "generate_fix_not_entitled",
    );
    expect(provider.getFile).not.toHaveBeenCalled();
    expect(payloads).toHaveLength(0);
  });

  it("builds a deterministic candidate without persisting before atomic completion", async () => {
    const { provider } = setup();
    const first = await preparePersistedRemediation({ preflightRunId: runId, provider });
    const second = await preparePersistedRemediation({ preflightRunId: runId, provider });

    expect(first.proposalCandidate).toEqual(second.proposalCandidate);
  });
});
