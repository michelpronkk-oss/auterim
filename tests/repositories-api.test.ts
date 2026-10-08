import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), from: vi.fn() }));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));

import { GET } from "@/app/api/repositories/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productA = "22222222-2222-4222-8222-222222222222";
const productB = "33333333-3333-4333-8333-333333333333";
const dependencyA = "44444444-4444-4444-8444-444444444444";
const dependencyB = "55555555-5555-4555-8555-555555555555";
const repositoryId = "66666666-6666-4666-8666-666666666666";

function queryResult(data: unknown) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    in: vi.fn(() => query),
    order: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data, error: null })),
    then: (resolve: (result: { data: unknown; error: null }) => unknown) =>
      Promise.resolve(resolve({ data, error: null })),
  };
  return query;
}

describe("legacy repositories API attribution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const rows: Record<string, unknown> = {
      workspace_members: { workspace_id: workspaceId },
      repository_connections: [{ id: "connection", status: "connected" }],
      repositories: [
        {
          id: repositoryId,
          workspace_id: workspaceId,
          selected_for_protection: true,
          status: "available",
        },
      ],
      workspace_repository_access: [
        { repository_id: repositoryId, workspace_dependency_id: dependencyA },
        { repository_id: repositoryId, workspace_dependency_id: dependencyB },
      ],
      workspace_dependencies: [
        { id: dependencyA, protected_product_id: productA },
        { id: dependencyB, protected_product_id: productB },
      ],
      workspace_product_repositories: [],
    };
    mocks.from.mockImplementation((table: string) => queryResult(rows[table] ?? []));
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "member" },
      client: { from: mocks.from },
    });
  });

  it("labels ambiguous legacy selection as requiring explicit Product mapping", async () => {
    const response = await GET(
      new Request(`https://auterim.com/api/repositories?workspaceId=${workspaceId}`, {
        headers: { authorization: "Bearer test-token" },
      }),
    );

    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      repositories: [
        {
          id: repositoryId,
          selected_for_protection: true,
          legacyAttribution: "mapping_required",
          activeProductIds: [],
          protectedDependencyIds: [dependencyA, dependencyB],
        },
      ],
    });
    expect(mocks.from).toHaveBeenCalledWith("workspace_dependencies");
    expect(mocks.from).toHaveBeenCalledWith("workspace_product_repositories");
  });
});
