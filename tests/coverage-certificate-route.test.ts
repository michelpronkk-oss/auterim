import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  role: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/onboarding/auth", () => ({
  authenticateOnboardingRequest: mocks.authenticate,
}));
vi.mock("@/lib/billing/server", () => ({ getWorkspaceRole: mocks.role }));

import { GET } from "@/app/api/products/[id]/coverage-certificate/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const productId = "22222222-2222-4222-8222-222222222222";
const future = new Date(Date.now() + 86_400_000).toISOString();

function query(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const op of ["select", "eq", "order", "limit"]) builder[op] = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => result);
  builder.then = (resolve: (value: unknown) => void) => resolve(result);
  return builder;
}

const certificate = {
  id: "33333333-3333-4333-8333-333333333333",
  sequence: 2,
  contract_version: "coverage-cert-v1",
  issued_at: new Date().toISOString(),
  valid_until: future,
  dependency_sources_state: "complete",
  repository_code_state: "complete",
  deployment_exposure_state: "unknown",
  runtime_signals_state: "unknown",
  overall_state: "unknown",
  // Stored stronger than its dimensions support: the response must not repeat it.
  claim_level: "deployment_verified_protection",
  components_fingerprint: "a".repeat(64),
  component_count: 1,
};
const components = [
  {
    dimension: "deployment_exposure",
    subject_type: "deployment_surface",
    subject_id: "44444444-4444-4444-8444-444444444444",
    state: "unknown",
    reason: "sync_stale",
    evidence_refs: [],
    expires_at: null,
  },
];

function tables(overrides: Record<string, { data: unknown; error: unknown }> = {}) {
  const results: Record<string, { data: unknown; error: unknown }> = {
    workspace_products: { data: { id: productId }, error: null },
    product_coverage_certificates: { data: certificate, error: null },
    product_coverage_certificate_components: { data: components, error: null },
    ...overrides,
  };
  mocks.from.mockImplementation((table: string) => query(results[table]!));
}

const get = (product = productId, workspace: string | null = workspaceId) =>
  GET(
    new Request(
      `https://auterim.com/api/products/${product}/coverage-certificate${workspace ? `?workspaceId=${workspace}` : ""}`,
      { headers: { authorization: "Bearer token" } },
    ),
    { params: Promise.resolve({ id: product }) },
  );

describe("GET /api/products/[id]/coverage-certificate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({
      ok: true,
      user: { id: "55555555-5555-4555-8555-555555555555" },
      client: { from: mocks.from },
    });
    mocks.role.mockResolvedValue("member");
    tables();
  });

  it("rejects invalid input, anonymous callers and non-members before reading", async () => {
    expect((await get("not-a-uuid")).status).toBe(400);
    expect((await get(productId, null)).status).toBe(400);
    mocks.authenticate.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: "authentication_required" }, { status: 401 }),
    });
    expect((await get()).status).toBe(401);
    mocks.role.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(403);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("returns 404 for a Product outside the workspace", async () => {
    tables({ workspace_products: { data: null, error: null } });
    expect((await get()).status).toBe(404);
  });

  it("derives the claim from the persisted dimensions, never from the stored label alone", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.claim.level).toBe("code_verified_protection");
    expect(body.claim.text).toContain("Production deployment not verified");
    expect(body.certificate).toMatchObject({ id: certificate.id, sequence: 2, expired: false });
  });

  it("shows no protection without a certificate, and fails closed on read errors", async () => {
    tables({ product_coverage_certificates: { data: null, error: null } });
    expect(await (await get()).json()).toEqual({
      claim: { level: "unverified", text: "Protection not currently verified." },
      certificate: null,
    });
    tables({ product_coverage_certificate_components: { data: null, error: { code: "XX000" } } });
    expect((await get()).status).toBe(503);
  });
});
