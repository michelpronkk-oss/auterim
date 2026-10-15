import { describe, expect, it } from "vitest";
import { loadProductDeploymentProtectionGraph } from "@/lib/protection/deployment-graph";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const repositoryId = "33333333-3333-4333-8333-333333333333";
const surfaceId = "44444444-4444-4444-8444-444444444444";
const observationId = "55555555-5555-4555-8555-555555555555";
const baselineId = "66666666-6666-4666-8666-666666666666";
const deploymentId = "dpl_testCurrentProduction";
const sha = "a".repeat(40);

function fixtures(overrides: Record<string, Record<string, unknown>[]> = {}) {
  return {
    workspace_products: [{ id: productId, workspace_id: workspaceId, status: "protected" }],
    workspace_product_repositories: [
      {
        workspace_id: workspaceId,
        protected_product_id: productId,
        repository_id: repositoryId,
        status: "active",
        provenance: "user_confirmed",
      },
    ],
    repositories: [
      {
        id: repositoryId,
        workspace_id: workspaceId,
        owner: "michelpronkk-oss",
        name: "auterim",
        status: "available",
        selected_for_protection: true,
      },
    ],
    workspace_product_deployment_surfaces: [
      {
        id: "77777777-7777-4777-8777-777777777777",
        workspace_id: workspaceId,
        protected_product_id: productId,
        deployment_surface_id: surfaceId,
        repository_id: repositoryId,
        provenance: "protected_repository_identity",
        created_at: "2026-10-15T10:00:00Z",
      },
    ],
    deployment_surfaces: [
      {
        id: surfaceId,
        workspace_id: workspaceId,
        installation_id: "88888888-8888-4888-8888-888888888888",
        provider: "vercel",
        external_project_id: "prj_auterim",
        project_name: "auterim",
        environment_scope: "all",
        current_production_deployment_id: deploymentId,
        last_successful_sync_at: "2026-10-15T10:00:00Z",
        last_attempt_at: "2026-10-15T10:00:00Z",
        last_attempt_status: "succeeded",
      },
    ],
    connector_installations: [
      {
        id: "88888888-8888-4888-8888-888888888888",
        workspace_id: workspaceId,
        lifecycle_state: "connected",
        health_state: "healthy",
      },
    ],
    deployment_observations: [
      {
        id: observationId,
        workspace_id: workspaceId,
        deployment_surface_id: surfaceId,
        external_deployment_id: deploymentId,
        environment_type: "production",
        deployment_state: "ready",
        commit_sha: sha,
        source_repository_owner: "michelpronkk-oss",
        source_repository_name: "auterim",
        source_branch: "main",
        deployment_url: "https://auterim.com",
        provider_created_at: "2026-10-15T09:00:00Z",
        provider_ready_at: "2026-10-15T09:01:00Z",
        observed_at: "2026-10-15T10:00:00Z",
        provenance: "vercel_rest_api",
      },
    ],
    product_deployment_evidence: [
      {
        deployment_observation_id: observationId,
        workspace_id: workspaceId,
        protected_product_id: productId,
        repository_id: repositoryId,
        preflight_finding_id: null,
        baseline_preflight_evidence_id: baselineId,
        verification_state: "production_verified",
        verified_commit_sha: sha,
        observed_at: "2026-10-15T10:00:00Z",
        safe_metadata: { exactCommitMatch: true },
      },
    ],
    baseline_preflight_evidence: [
      {
        id: baselineId,
        preflight_run_id: "99999999-9999-4999-8999-999999999999",
        workspace_id: workspaceId,
        protected_product_id: productId,
        repository_id: repositoryId,
        commit_sha: sha,
        verification_state: "verified",
      },
    ],
    preflight_runs: [
      {
        id: "99999999-9999-4999-8999-999999999999",
        workspace_id: workspaceId,
        protected_product_id: productId,
        preflight_mode: "baseline",
        status: "completed",
      },
    ],
    ...overrides,
  } as Record<string, Record<string, unknown>[]>;
}

function clientFor(rows: Record<string, Record<string, unknown>[]>) {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const sets: Array<[string, unknown[]]> = [];
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return query;
        },
        in(column: string, values: unknown[]) {
          sets.push([column, values]);
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        maybeSingle() {
          return Promise.resolve({ data: filtered()[0] ?? null, error: null });
        },
        then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) {
          return Promise.resolve(resolve({ data: filtered(), error: null }));
        },
      };
      function filtered() {
        return (rows[table] ?? []).filter(
          (row) =>
            filters.every(([column, value]) => row[column] === value) &&
            sets.every(([column, values]) => values.includes(row[column])),
        );
      }
      return query;
    },
  } as never;
}

async function graph(rows: Record<string, Record<string, unknown>[]>) {
  return loadProductDeploymentProtectionGraph(clientFor(rows), {
    workspaceId,
    productId,
    verificationCapabilityAvailable: true,
  });
}

describe("canonical Product deployment Protection Graph", () => {
  it("marks only the exact READY current Production deployment with fresh baseline evidence current", async () => {
    const result = await graph(fixtures());
    expect(result?.surfaces[0]).toMatchObject({
      provider: "vercel",
      repository: { id: repositoryId, owner: "michelpronkk-oss", name: "auterim" },
      mappingProvenance: "protected_repository_identity",
      observations: [
        {
          providerDeploymentId: deploymentId,
          currentProduction: true,
          verification: {
            state: "production_verified",
            exactCommitMatch: true,
            baselinePreflightEvidenceId: baselineId,
          },
        },
      ],
    });
  });

  it("preserves current evidence backed by a verified completed Preflight finding", async () => {
    const rows = fixtures({
      product_deployment_evidence: [
        {
          ...fixtures().product_deployment_evidence[0],
          baseline_preflight_evidence_id: null,
          preflight_finding_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      ],
      preflight_findings: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          workspace_id: workspaceId,
          preflight_run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          repository_id: repositoryId,
          commit_sha: sha,
          verification: "verified",
        },
      ],
      preflight_runs: [
        {
          id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          workspace_id: workspaceId,
          protected_product_id: productId,
          preflight_mode: "live",
          status: "completed",
        },
      ],
      baseline_preflight_evidence: [],
    });
    const result = await graph(rows);
    expect(result?.surfaces[0]?.observations[0]?.currentProduction).toBe(true);
  });

  it.each([
    [
      "missing current Production pointer",
      {
        deployment_surfaces: [
          { ...fixtures().deployment_surfaces[0], current_production_deployment_id: null },
        ],
      },
    ],
    [
      "mismatched commit",
      {
        deployment_observations: [
          { ...fixtures().deployment_observations[0], commit_sha: "b".repeat(40) },
        ],
      },
    ],
    [
      "historical evidence",
      {
        product_deployment_evidence: [
          { ...fixtures().product_deployment_evidence[0], verification_state: "historical" },
        ],
      },
    ],
    [
      "unhealthy connector",
      {
        connector_installations: [
          { ...fixtures().connector_installations[0], health_state: "degraded" },
        ],
      },
    ],
    ["inactive Product", { workspace_products: [{ id: productId, status: "archived" }] }],
    [
      "inactive repository mapping",
      {
        workspace_product_repositories: [
          { ...fixtures().workspace_product_repositories[0], status: "inactive" },
        ],
      },
    ],
    ["missing baseline evidence", { baseline_preflight_evidence: [] }],
  ] as const)("does not mark %s as current", async (_name, override) => {
    const result = await graph(
      fixtures(override as unknown as Record<string, Record<string, unknown>[]>),
    );
    expect(
      result === null || result?.surfaces[0]?.observations[0]?.currentProduction === false,
    ).toBe(true);
  });
});
