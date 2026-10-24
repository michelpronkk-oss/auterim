import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readProductionBinding,
  readProductionGraph,
} from "@/lib/coverage-certification/production-repository";
import {
  getVercelConfiguration,
  getVercelProjectDeploymentSnapshot,
} from "@/lib/deployments/vercel";
import { loadInstallation, getFreshProviderCredentials } from "@/lib/connectors/service";

vi.mock("@/lib/connectors/service", () => ({
  loadInstallation: vi.fn(),
  getFreshProviderCredentials: vi.fn(),
}));
vi.mock("@/lib/deployments/vercel", () => ({
  getVercelConfiguration: vi.fn(),
  getVercelProjectDeploymentSnapshot: vi.fn(),
}));
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = new Date("2026-10-24T20:00:00Z");
const scope = {
  workspaceId: id(1),
  productId: id(2),
  repositoryId: id(3),
  surfaceId: id(4),
  seedGraphBuildId: id(5),
};
const commit = "a".repeat(40);
function database() {
  const rows: Record<string, unknown> = {
    workspace_products: { id: id(2) },
    workspace_product_repositories: { id: id(20) },
    workspace_product_deployment_surfaces: { deployment_surface_id: id(4) },
    repositories: { id: id(3), owner: "acme", name: "app", connection_id: id(30) },
    deployment_surfaces: {
      id: id(4),
      installation_id: id(40),
      external_project_id: "prj_app",
      current_production_deployment_id: "dpl_current",
      last_attempt_status: "succeeded",
    },
    impact_graph_builds: {
      id: id(5),
      workspace_id: id(1),
      product_id: id(2),
      repository_id: id(3),
      route_intent_id: id(6),
    },
    repository_connections: { id: id(30) },
    connector_resources: { id: id(50) },
    deployment_sync_attempts: {
      id: id(9),
      status: "succeeded",
      completed_at: "2026-10-24T20:00:00+00:00",
    },
    deployment_observations: {
      id: id(7),
      commit_sha: commit,
      environment_type: "production",
      deployment_state: "ready",
    },
    product_deployment_evidence: {
      id: id(8),
      verified_commit_sha: commit,
      verification_state: "production_verified",
    },
  };
  let running: unknown[] = [];
  let failedTable: string | null = null;
  const calls: Array<{
    table: string;
    filters: Array<[string, unknown]>;
    aborted: boolean;
    selected: boolean;
  }> = [];
  const client = {
    from(table: string) {
      const call = {
        table,
        filters: [] as Array<[string, unknown]>,
        aborted: false,
        selected: false,
      };
      calls.push(call);
      const q = {
        select() {
          call.selected = true;
          return q;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return q;
        },
        in() {
          return q;
        },
        not() {
          return q;
        },
        order() {
          return q;
        },
        limit() {
          return q;
        },
        abortSignal(signal: AbortSignal) {
          expect(signal.aborted).toBe(false);
          call.aborted = true;
          return q;
        },
        maybeSingle() {
          return Promise.resolve(response());
        },
        then(resolve: (value: unknown) => unknown) {
          return Promise.resolve(response()).then(resolve);
        },
      };
      function response() {
        return {
          data: call.filters.some(([k, v]) => k === "status" && v === "running")
            ? running
            : rows[table],
          error: table === failedTable ? { message: "secret must not escape" } : null,
        };
      }
      return q;
    },
  } as unknown as SupabaseClient;
  return {
    client,
    rows,
    calls,
    running: (value: unknown[]) => {
      running = value;
    },
    fail: (table: string) => {
      failedTable = table;
    },
  };
}
function provider() {
  return {
    project: {
      id: "prj_app",
      name: "app",
      accountId: null,
      repository: { owner: "acme", name: "app" },
      safeMetadata: {},
    },
    currentProductionDeploymentId: "dpl_current",
    currentProductionAliases: ["app.acme.test"],
    observations: [
      {
        providerDeploymentId: "dpl_current",
        environment: "production" as const,
        state: "ready" as const,
        commitSha: commit,
        sourceRepository: { owner: "acme", name: "app" },
        isCurrentProduction: true,
        observedAt: now.toISOString(),
        branch: "main",
        url: null,
        readyAt: null,
        createdAt: null,
      },
    ],
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadInstallation).mockResolvedValue({
    id: id(40),
    workspace_id: id(1),
    provider: "vercel",
  } as Awaited<ReturnType<typeof loadInstallation>>);
  vi.mocked(getFreshProviderCredentials).mockResolvedValue({
    accessToken: "fixture-secret",
    refreshToken: null,
    expiresAt: null,
    scopes: [],
    providerMetadata: {},
  });
  vi.mocked(getVercelConfiguration).mockResolvedValue({
    id: "cfg",
    teamId: null,
    projectSelection: "selected",
    projects: ["prj_app"],
    scopes: [],
  });
  vi.mocked(getVercelProjectDeploymentSnapshot).mockResolvedValue(provider());
});
describe("Production binding repository security", () => {
  it("uses scoped bounded SELECTs and complete live aliases; accepts Postgres offset timestamps", async () => {
    const d = database();
    const binding = await readProductionBinding(d.client, scope, now);
    expect(binding).toMatchObject({
      ...scope,
      deploymentId: "dpl_current",
      commitSha: commit,
      evidenceId: id(8),
      syncAttemptId: id(9),
    });
    for (const call of d.calls) {
      expect(call.filters).toContainEqual(["workspace_id", scope.workspaceId]);
      expect(call.aborted).toBe(true);
      expect(call.selected).toBe(true);
    }
    expect(getVercelProjectDeploymentSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      "prj_app",
      null,
      now.toISOString(),
      { requireCompleteAliases: true },
    );
    expect(JSON.stringify(binding)).not.toContain("fixture-secret");
  });
  it.each([
    "workspace_products",
    "workspace_product_repositories",
    "workspace_product_deployment_surfaces",
    "repositories",
    "deployment_surfaces",
    "impact_graph_builds",
    "repository_connections",
    "connector_resources",
  ])("does not analyze missing/cross-tenant %s", async (table) => {
    const d = database();
    d.rows[table] = null;
    expect(await readProductionBinding(d.client, scope, now)).toBeNull();
    expect(getVercelProjectDeploymentSnapshot).not.toHaveBeenCalled();
  });
  it.each(["failed", "running", null])(
    "rejects latest surface attempt status %s",
    async (status) => {
      const d = database();
      d.rows.deployment_surfaces = {
        ...(d.rows.deployment_surfaces as object),
        last_attempt_status: status,
      };
      expect(await readProductionBinding(d.client, scope, now)).toBeNull();
    },
  );
  it("rejects an overlapping sync", async () => {
    const d = database();
    d.running([{ id: id(99) }]);
    expect(await readProductionBinding(d.client, scope, now)).toBeNull();
  });
  it.each(["failed", "running"])("rejects latest finished sync %s", async (status) => {
    const d = database();
    d.rows.deployment_sync_attempts = { ...(d.rows.deployment_sync_attempts as object), status };
    expect(await readProductionBinding(d.client, scope, now)).toBeNull();
  });
  it.each(["2026-10-23T20:00:00Z", "2026-10-24T20:00:01Z", "invalid"])(
    "rejects stale/future sync %s",
    async (completed_at) => {
      const d = database();
      d.rows.deployment_sync_attempts = {
        ...(d.rows.deployment_sync_attempts as object),
        completed_at,
      };
      expect(await readProductionBinding(d.client, scope, now)).toBeNull();
    },
  );
  it.each(["historical", "commit_verified", "inconclusive", "mapped"])(
    "rejects %s evidence",
    async (verification_state) => {
      const d = database();
      d.rows.product_deployment_evidence = {
        ...(d.rows.product_deployment_evidence as object),
        verification_state,
      };
      expect(await readProductionBinding(d.client, scope, now)).toBeNull();
    },
  );
  it("rejects mismatched stored/live SHAs", async () => {
    const d = database();
    d.rows.product_deployment_evidence = {
      ...(d.rows.product_deployment_evidence as object),
      verified_commit_sha: "b".repeat(40),
    };
    expect(await readProductionBinding(d.client, scope, now)).toBeNull();
  });
  it.each(["preview", "custom"])("rejects a live %s deployment", async (environment) => {
    const snapshot = provider();
    Object.assign(snapshot.observations[0], { environment });
    vi.mocked(getVercelProjectDeploymentSnapshot).mockResolvedValue(snapshot);
    expect(await readProductionBinding(database().client, scope, now)).toBeNull();
  });
  it.each(["building", "error", "canceled"])("rejects a live %s deployment", async (state) => {
    const snapshot = provider();
    Object.assign(snapshot.observations[0], { state });
    vi.mocked(getVercelProjectDeploymentSnapshot).mockResolvedValue(snapshot);
    expect(await readProductionBinding(database().client, scope, now)).toBeNull();
  });
  it.each(["missing", "duplicate", "orphan", "wrong_repository", "changed", "ambiguous"])(
    "rejects %s live targets",
    async (kind) => {
      const snapshot = provider();
      if (kind === "missing") snapshot.observations = [];
      if (kind === "duplicate") snapshot.observations.push(snapshot.observations[0]);
      if (kind === "orphan") snapshot.observations[0].isCurrentProduction = false;
      if (kind === "wrong_repository") snapshot.observations[0].sourceRepository.name = "other";
      if (kind === "changed") snapshot.currentProductionDeploymentId = "dpl_other";
      if (kind === "ambiguous") Object.assign(snapshot, { currentProductionDeploymentId: null });
      vi.mocked(getVercelProjectDeploymentSnapshot).mockResolvedValue(snapshot);
      expect(await readProductionBinding(database().client, scope, now)).toBeNull();
    },
  );
  it("fails before provider access when the selected project is revoked", async () => {
    vi.mocked(getVercelConfiguration).mockResolvedValue({
      id: "cfg",
      teamId: null,
      projectSelection: "selected",
      projects: [],
      scopes: [],
    });
    expect(await readProductionBinding(database().client, scope, now)).toBeNull();
    expect(getVercelProjectDeploymentSnapshot).not.toHaveBeenCalled();
  });
  it("does not expose database messages", async () => {
    const d = database();
    d.fail("repositories");
    await expect(readProductionBinding(d.client, scope, now)).rejects.toThrow(
      /^production_analysis_scope_read_failed$/,
    );
  });
  it("binds graph reads to tenant, Product, route, analysis run and exact commit", async () => {
    const d = database();
    const binding = await readProductionBinding(d.client, scope, now);
    d.rows.impact_graph_builds = {
      ...(d.rows.impact_graph_builds as object),
      commit_sha: commit,
      status: "completed",
      assessment_state: "absence_observed",
      analysis_profile: "javascript-typescript-v2.3",
      coverage_state: "complete",
    };
    await readProductionGraph(d.client, binding!, id(5), id(11));
    expect(d.calls.at(-1)?.filters).toEqual(
      expect.arrayContaining([
        ["workspace_id", id(1)],
        ["product_id", id(2)],
        ["repository_id", id(3)],
        ["route_intent_id", id(6)],
        ["analysis_run_id", id(11)],
        ["commit_sha", commit],
      ]),
    );
  });
});
