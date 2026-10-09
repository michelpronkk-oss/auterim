import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ createServerClient: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));

import { getDependenciesOverview } from "@/lib/protection/read-models";

type QueryResult = { data: unknown; error: null; count?: number };
type QueryCall = { client: "tenant" | "server"; table: string; method: string; args: unknown[] };

function mockClient(
  client: QueryCall["client"],
  results: Record<string, QueryResult>,
  calls: QueryCall[],
) {
  return {
    from(table: string) {
      const query = {} as Record<string, (...args: unknown[]) => unknown> & {
        then: (
          resolve: (value: QueryResult) => unknown,
          reject?: (reason: unknown) => unknown,
        ) => Promise<unknown>;
      };
      for (const method of ["select", "eq", "order", "limit", "in", "or"]) {
        query[method] = (...args: unknown[]) => {
          calls.push({ client, table, method, args });
          return query;
        };
      }
      query.then = (resolve, reject) =>
        Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve, reject);
      return query;
    },
    rpc(name: string, args: unknown) {
      calls.push({ client, table: `rpc:${name}`, method: "rpc", args: [args] });
      return Promise.resolve(results[`rpc:${name}`] ?? { data: [], error: null });
    },
  };
}

describe("dependency protection read model global monitoring access", () => {
  afterEach(() => vi.resetAllMocks());

  it("reads global snapshot and queue state server-side and only for tenant-visible source IDs", async () => {
    const calls: QueryCall[] = [];
    const tenantClient = mockClient(
      "tenant",
      {
        workspace_dependencies: {
          data: [
            {
              id: "workspace-dependency-1",
              protected_product_id: "product-1",
              dependency_id: "dependency-1",
              origin: "manual",
              monitoring_enabled: true,
              created_at: "2026-10-08T00:00:00.000Z",
              dependency_catalog: { name: "Example", slug: "example", category: "platform" },
              dependency_context: {
                criticality: "normal",
                production_critical: false,
                used_for: [],
              },
            },
          ],
          error: null,
          count: 1,
        },
        workspace_products: {
          data: [{ id: "product-1", name: "Test Product", status: "protected" }],
          error: null,
        },
        source_catalog: {
          data: [
            {
              id: "source-1",
              dependency_id: "dependency-1",
              source_type: "changelog",
              enabled: true,
            },
          ],
          error: null,
        },
        impact_assessments: { data: [], error: null },
        workspace_repository_access: { data: [], error: null },
        "rpc:get_dependency_source_scan_states": {
          data: [
            {
              source_id: "source-1",
              status: "completed",
              finished_at: "2026-10-08T12:00:00.000Z",
            },
          ],
          error: null,
        },
      },
      calls,
    );
    const serverClient = mockClient(
      "server",
      {
        source_snapshots: {
          data: [
            { id: "snapshot-1", source_id: "source-1", created_at: "2026-10-08T11:00:00.000Z" },
          ],
          error: null,
        },
        baseline_scan_queue: { data: [], error: null },
      },
      calls,
    );
    mocks.createServerClient.mockReturnValue(serverClient);

    const result = await getDependenciesOverview(
      tenantClient as unknown as SupabaseClient,
      "workspace-1",
    );

    expect(result.items[0]?.protectionState).toBe("protected_and_quiet");
    expect(mocks.createServerClient).toHaveBeenCalledTimes(1);
    expect(
      calls.filter(
        (call) =>
          call.client === "tenant" &&
          ["source_snapshots", "baseline_scan_queue"].includes(call.table),
      ),
    ).toEqual([]);
    const privilegedCalls = calls.filter((call) => call.client === "server");
    expect(new Set(privilegedCalls.map((call) => call.table))).toEqual(
      new Set(["source_snapshots", "baseline_scan_queue"]),
    );
    expect(privilegedCalls.filter((call) => call.method === "in").map((call) => call.args)).toEqual(
      [
        ["source_id", ["source-1"]],
        ["source_id", ["source-1"]],
      ],
    );
  });
});
