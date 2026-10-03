import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/internal/growth/search-console/callback/route";

describe("Search Console OAuth callback", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns a controlled denial and clears state when OAuth parameters are absent", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://auterim.com");
    const response = await GET(
      new Request("https://auterim.com/api/internal/growth/search-console/callback"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://auterim.com/app/settings?searchConsole=denied",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "auterim_gsc_state=; Path=/api/internal/growth/search-console/callback",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a controlled denial for a malformed browser-binding cookie", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://auterim.com");
    const response = await GET(
      new Request("https://auterim.com/api/internal/growth/search-console/callback", {
        headers: { cookie: "auterim_gsc_state=%ZZ" },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://auterim.com/app/settings?searchConsole=denied",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
