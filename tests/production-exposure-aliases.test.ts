import { afterEach, describe, expect, it, vi } from "vitest";
import { getVercelProjectDeploymentSnapshot } from "@/lib/deployments/vercel";
const credentials = {
  accessToken: "test-only",
  refreshToken: null,
  expiresAt: null,
  scopes: [],
  providerMetadata: {},
};
function fixture(domains: unknown[], aliases: Record<string, string | null>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input.toString());
    if (url.pathname === "/v9/projects/prj_test")
      return Response.json({
        id: "prj_test",
        name: "app",
        link: { type: "github", org: "acme", repo: "app" },
      });
    if (url.pathname === "/v6/deployments")
      return Response.json({
        deployments: [
          {
            uid: "dpl_current",
            target: "production",
            readyState: "READY",
            gitSource: { sha: "a".repeat(40), org: "acme", repo: "app" },
          },
        ],
      });
    if (url.pathname.endsWith("/domains")) return Response.json({ domains });
    if (url.pathname.startsWith("/v4/aliases/")) {
      const target = aliases[decodeURIComponent(url.pathname.split("/").at(-1)!)];
      return target
        ? Response.json({ deploymentId: target })
        : new Response("unavailable", { status: 404 });
    }
    throw new Error("unexpected_fixture_request");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const snapshot = () =>
  getVercelProjectDeploymentSnapshot(credentials, "prj_test", null, "2026-10-24T20:00:00Z", {
    requireCompleteAliases: true,
  });
afterEach(() => vi.unstubAllGlobals());
describe("complete bounded Production alias verification", () => {
  it("accepts a complete set pointing at the same current deployment", async () => {
    fixture(
      [
        { name: "one.test", verified: true },
        { name: "two.test", verified: true },
      ],
      { "one.test": "dpl_current", "two.test": "dpl_current" },
    );
    expect((await snapshot()).currentProductionDeploymentId).toBe("dpl_current");
  });
  it.each([null, "dpl_other"])(
    "rejects an unreadable or contradictory alias: %s",
    async (second) => {
      fixture(
        [
          { name: "one.test", verified: true },
          { name: "two.test", verified: true },
        ],
        { "one.test": "dpl_current", "two.test": second },
      );
      expect((await snapshot()).currentProductionDeploymentId).toBeNull();
    },
  );
  it("rejects an empty verified-domain set", async () => {
    fixture([{ name: "one.test", verified: false }], {});
    expect((await snapshot()).currentProductionDeploymentId).toBeNull();
  });
  it.each([11, 100])(
    "fails closed before alias requests when %i domains exceed the complete-read bound",
    async (count) => {
      const fetch = fixture(
        Array.from({ length: count }, (_, n) => ({ name: `${n}.test`, verified: true })),
        {},
      );
      await expect(snapshot()).rejects.toThrow("verification bound");
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );
  it("rejects malformed verified domain names rather than silently omitting them", async () => {
    fixture(
      [
        { name: "one.test", verified: true },
        { name: "https://bad.test/?secret", verified: true },
      ],
      { "one.test": "dpl_current" },
    );
    await expect(snapshot()).rejects.toThrow("verification bound");
  });
});
