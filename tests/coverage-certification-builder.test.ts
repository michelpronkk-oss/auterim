import { describe, expect, it, vi } from "vitest";
import {
  componentsFromEvidence,
  issueProductCoverageCertificate,
  readProductCoverageEvidence,
  type ProductCoverageEvidence,
} from "@/lib/coverage-certification/builder";
import { CLAIM_LEVELS, COVERAGE_STATES } from "@/lib/coverage-certification/contracts";
import { buildCertificate, claimLevelFor } from "@/lib/coverage-certification/evaluate";
import {
  coverageCertificateView,
  type PersistedCertificate,
  type PersistedComponent,
} from "@/lib/coverage-certification/read";

const WORKSPACE = "b0000000-0000-4000-8000-000000000001";
const PRODUCT = "c0000000-0000-4000-8000-000000000001";
const REPOSITORY = "f0000000-0000-4000-8000-000000000001";
const COMMIT = "94135df6f85bfb34ac83c046e5541e1ad8d73a86";
const OTHER_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-10-24T12:00:00.000Z");
const HOUR_AGO = "2026-10-24T11:00:00.000Z";

function evidence(overrides: Partial<ProductCoverageEvidence> = {}): ProductCoverageEvidence {
  return {
    dependencies: [
      {
        id: "dep-1",
        sources: ["pricing", "changelog", "deprecation"].map((type, index) => ({
          id: `src-${index}`,
          sourceType: type,
          lastSuccessAt: HOUR_AGO,
        })),
      },
    ],
    repositories: [
      {
        repositoryId: REPOSITORY,
        analyses: [{ id: "run-1", commitSha: COMMIT, coverageState: "complete" }],
      },
    ],
    surfaces: [
      {
        surfaceId: "surface-1",
        evidence: {
          id: "evidence-1",
          repositoryId: REPOSITORY,
          verificationState: "production_verified",
          verifiedCommitSha: COMMIT,
        },
        lastSync: { status: "succeeded", completedAt: HOUR_AGO },
      },
    ],
    ...overrides,
  };
}

const claimOf = (input: ProductCoverageEvidence) =>
  buildCertificate({ components: componentsFromEvidence(input, NOW), issuedAt: NOW }).claimLevel;
const codeOf = (input: ProductCoverageEvidence) =>
  componentsFromEvidence(input, NOW).find((c) => c.dimension === "repository_code")!;

describe("componentsFromEvidence", () => {
  it("certifies deployment-verified protection only from fresh, production-bound evidence", () => {
    const components = componentsFromEvidence(evidence(), NOW);
    expect(components.map((c) => [c.dimension, c.state])).toEqual([
      ["dependency_sources", "complete"],
      ["repository_code", "complete"],
      ["deployment_exposure", "complete"],
      ["runtime_signals", "unknown"],
    ]);
    expect(claimOf(evidence())).toBe("deployment_verified_protection");
  });

  it("binds code to the production-verified commit, preferring an analysis at that commit", () => {
    const analyses = [
      { id: "run-new", commitSha: OTHER_COMMIT, coverageState: "complete" as const },
      { id: "run-prod", commitSha: COMMIT, coverageState: "complete" as const },
    ];
    const code = codeOf(evidence({ repositories: [{ repositoryId: REPOSITORY, analyses }] }));
    expect(code).toMatchObject({ state: "complete" });
    expect(code.evidenceRefs).toEqual([
      { kind: "code_analysis_run", id: "run-prod", commitSha: COMMIT },
    ]);

    // Only an analysis at another commit: never stronger than unknown.
    expect(
      codeOf(evidence({ repositories: [{ repositoryId: REPOSITORY, analyses: [analyses[0]!] }] })),
    ).toMatchObject({ state: "unknown", reason: "analysis_commit_behind_head" });
  });

  it("never certifies code without a single production-verified commit", () => {
    // No deployment surface: the head commit is unknown here, so code cannot be bound.
    expect(codeOf(evidence({ surfaces: [] }))).toMatchObject({
      state: "unknown",
      reason: "analysis_commit_unverified",
    });
    expect(claimOf(evidence({ surfaces: [] }))).toBe("unverified");

    // Two surfaces disagree on the production commit.
    const base = evidence().surfaces[0]!;
    const disagreeing = evidence({
      surfaces: [
        base,
        {
          ...base,
          surfaceId: "surface-2",
          evidence: { ...base.evidence!, id: "evidence-2", verifiedCommitSha: OTHER_COMMIT },
        },
      ],
    });
    expect(codeOf(disagreeing)).toMatchObject({ state: "unknown" });

    // Commit-verified evidence is not production identity.
    const commitOnly = evidence({
      surfaces: [
        { ...base, evidence: { ...base.evidence!, verificationState: "commit_verified" } },
      ],
    });
    expect(codeOf(commitOnly)).toMatchObject({ state: "unknown" });
  });

  it("keeps an honest unsupported analysis and stale sync as weaker states", () => {
    const unsupported = evidence({
      repositories: [
        {
          repositoryId: REPOSITORY,
          analyses: [{ id: "run-1", commitSha: COMMIT, coverageState: "unsupported" }],
        },
      ],
    });
    expect(codeOf(unsupported)).toMatchObject({ state: "unsupported" });
    expect(claimOf(unsupported)).toBe("partial_protection");

    const stale = evidence({
      surfaces: [
        {
          ...evidence().surfaces[0]!,
          lastSync: { status: "succeeded", completedAt: "2026-10-22T12:00:00.000Z" },
        },
      ],
    });
    expect(claimOf(stale)).toBe("code_verified_protection");
  });
});

/** A chainable stand-in for the Supabase query builder that records every filter. */
function recordingClient(data: Record<string, unknown[]>, failTable?: string) {
  const calls: Array<{ table: string; ops: Array<[string, ...unknown[]]> }> = [];
  const client = {
    calls,
    from(table: string) {
      const call = { table, ops: [] as Array<[string, ...unknown[]]> };
      calls.push(call);
      const query: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "not", "or", "order", "limit"])
        query[op] = (...args: unknown[]) => {
          call.ops.push([op, ...args]);
          return query;
        };
      query.then = (resolve: (value: unknown) => void) =>
        resolve(
          table === failTable
            ? { data: null, error: { code: "XX000" } }
            : { data: data[table] ?? [], error: null },
        );
      return query;
    },
    rpc: vi.fn(),
  };
  return client;
}

describe("readProductCoverageEvidence", () => {
  const data = {
    workspace_dependencies: [{ id: "dep-1", dependency_id: "catalog-1" }],
    source_catalog: [{ id: "src-1", source_type: "pricing", last_success_at: HOUR_AGO }],
    workspace_product_repositories: [{ repository_id: REPOSITORY }],
    code_analysis_runs: [
      { id: "run-1", commit_sha: COMMIT, coverage_state: "complete", product_id: null },
    ],
    workspace_product_deployment_surfaces: [{ deployment_surface_id: "surface-1" }],
    product_deployment_evidence: [
      {
        id: "evidence-1",
        repository_id: REPOSITORY,
        verification_state: "production_verified",
        verified_commit_sha: COMMIT,
      },
    ],
    deployment_sync_attempts: [{ status: "succeeded", completed_at: HOUR_AGO }],
  };

  it("scopes every workspace-owned read to the workspace and selects like the guard", async () => {
    const client = recordingClient(data);
    const read = await readProductCoverageEvidence(client as never, {
      workspaceId: WORKSPACE,
      productId: PRODUCT,
    });
    expect(read.surfaces[0]!.evidence?.verifiedCommitSha).toBe(COMMIT);
    for (const call of client.calls) {
      if (call.table === "source_catalog") continue; // global catalog, keyed by dependency
      expect(call.ops, call.table).toContainEqual(["eq", "workspace_id", WORKSPACE]);
    }
    const ops = (table: string) => client.calls.find((call) => call.table === table)!.ops;
    expect(ops("source_catalog")).toEqual(
      expect.arrayContaining([
        ["eq", "enabled", true],
        ["eq", "source_mode", "provider"],
      ]),
    );
    expect(ops("workspace_dependencies")).toContainEqual(["eq", "monitoring_enabled", true]);
    expect(ops("workspace_product_repositories")).toContainEqual(["eq", "status", "active"]);
    expect(ops("product_deployment_evidence")).toEqual(
      expect.arrayContaining([
        ["eq", "protected_product_id", PRODUCT],
        ["order", "observed_at", { ascending: false }],
        ["order", "id", { ascending: false }],
        ["limit", 1],
      ]),
    );
    expect(ops("deployment_sync_attempts")).toEqual(
      expect.arrayContaining([
        ["in", "status", ["succeeded", "failed"]],
        ["order", "completed_at", { ascending: false }],
      ]),
    );
  });

  it("aborts on any read error and rejects non-UUID subjects", async () => {
    await expect(
      readProductCoverageEvidence(recordingClient(data, "source_catalog") as never, {
        workspaceId: WORKSPACE,
        productId: PRODUCT,
      }),
    ).rejects.toThrow(/coverage_evidence_unavailable:sources/);
    await expect(
      readProductCoverageEvidence(recordingClient(data) as never, {
        workspaceId: WORKSPACE,
        productId: "x,product_id.not.is.null",
      }),
    ).rejects.toThrow(/coverage_evidence_invalid_subject/);
  });

  it("issues through the guarded RPC and surfaces its failure", async () => {
    const client = recordingClient(data);
    client.rpc.mockResolvedValueOnce({
      data: { status: "issued", certificateId: "cert-1", sequence: 1, claimLevel: "x" },
      error: null,
    });
    const { certificate } = await issueProductCoverageCertificate(client as never, {
      workspaceId: WORKSPACE,
      productId: PRODUCT,
      now: NOW,
    });
    const [name, args] = client.rpc.mock.calls[0]!;
    expect(name).toBe("issue_product_coverage_certificate");
    expect(args).toMatchObject({
      p_workspace_id: WORKSPACE,
      p_product_id: PRODUCT,
      p_components_fingerprint: certificate.componentsFingerprint,
    });
    client.rpc.mockResolvedValueOnce({ data: null, error: { code: "42501" } });
    await expect(
      issueProductCoverageCertificate(client as never, {
        workspaceId: WORKSPACE,
        productId: PRODUCT,
        now: NOW,
      }),
    ).rejects.toThrow(/coverage_certificate_issue_failed:42501/);
  });
});

function persisted(overrides: Partial<PersistedCertificate> = {}): PersistedCertificate {
  return {
    id: "cert-1",
    sequence: 1,
    contract_version: "coverage-cert-v1",
    issued_at: HOUR_AGO,
    valid_until: "2026-10-25T11:00:00.000Z",
    dependency_sources_state: "complete",
    repository_code_state: "complete",
    deployment_exposure_state: "complete",
    runtime_signals_state: "unknown",
    overall_state: "complete",
    claim_level: "deployment_verified_protection",
    components_fingerprint: "a".repeat(64),
    component_count: 1,
    ...overrides,
  };
}
const component: PersistedComponent = {
  dimension: "runtime_signals",
  subject_type: "runtime_provider",
  subject_id: "none",
  state: "unknown",
  reason: "runtime_provider_not_connected",
  evidence_refs: [],
  expires_at: null,
};

describe("coverageCertificateView", () => {
  it("never shows a claim stronger than the persisted certificate supports", () => {
    const rank = (level: string) => CLAIM_LEVELS.indexOf(level as never);
    for (const sources of COVERAGE_STATES)
      for (const code of COVERAGE_STATES)
        for (const deployment of COVERAGE_STATES)
          for (const stored of CLAIM_LEVELS)
            for (const validUntil of ["2026-10-25T11:00:00.000Z", "2026-10-24T11:30:00.000Z"]) {
              const view = coverageCertificateView(
                persisted({
                  dependency_sources_state: sources,
                  repository_code_state: code,
                  deployment_exposure_state: deployment,
                  claim_level: stored,
                  valid_until: validUntil,
                }),
                [component],
                NOW,
              );
              const supported = claimLevelFor({
                dependency_sources: sources,
                repository_code: code,
                deployment_exposure: deployment,
                runtime_signals: "unknown",
              });
              expect(rank(view.claim.level)).toBeGreaterThanOrEqual(rank(stored));
              expect(rank(view.claim.level)).toBeGreaterThanOrEqual(rank(supported));
              if (Date.parse(validUntil) <= NOW.getTime())
                expect(view.claim.level).toBe("unverified");
            }
  });

  it("is unverified without a certificate or with an inconsistent one", () => {
    expect(coverageCertificateView(null, [], NOW)).toEqual({
      claim: { level: "unverified", text: "Protection not currently verified." },
      certificate: null,
    });
    for (const broken of [
      persisted({ contract_version: "coverage-cert-v2" }),
      persisted({ claim_level: "fully_protected" }),
      persisted({ deployment_exposure_state: "verified" }),
      persisted({ component_count: 2 }),
    ])
      expect(coverageCertificateView(broken, [component], NOW).claim.level).toBe("unverified");
    expect(coverageCertificateView(persisted(), [component], NOW).claim.level).toBe(
      "deployment_verified_protection",
    );
  });
});
