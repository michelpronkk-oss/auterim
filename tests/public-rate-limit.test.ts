import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  getEnvironment: vi.fn(),
}));

vi.mock("@/lib/env/schema", () => ({ getEnvironment: mocks.getEnvironment }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ rpc: mocks.rpc }),
}));

import {
  claimPublicRateLimit,
  claimPublicScanSlot,
  publicClientFingerprint,
  releasePublicScanSlot,
} from "@/lib/public/rate-limit";
import { POST as conversion } from "@/app/api/public/conversion/route";
import { POST as stackScan } from "@/app/api/public/stack-scan/route";

const key = "test-only-hmac-key-with-at-least-32-characters";

function request(ip?: string) {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip !== undefined) headers.set("x-real-ip", ip);
  return new Request("https://auterim.com/api/public/stack-scan", {
    method: "POST",
    headers,
    body: JSON.stringify({ websiteUrl: "https://example.com" }),
  });
}

describe("distributed public rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getEnvironment.mockReturnValue({ PUBLIC_RATE_LIMIT_HMAC_SECRET: key });
    mocks.rpc.mockResolvedValue({
      data: [{ allowed: true, remaining: 3, retry_after_seconds: 0 }],
      error: null,
    });
  });

  it("creates a stable keyed fingerprint without retaining the client address", () => {
    const fingerprint = publicClientFingerprint("198.51.100.24", key, "public_stack_scan");
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint).toBe(publicClientFingerprint("198.51.100.24", key, "public_stack_scan"));
    expect(fingerprint).not.toContain("198.51.100.24");
    expect(fingerprint).not.toBe(
      publicClientFingerprint("198.51.100.24", key, "public_conversion"),
    );
  });

  it("claims a shared policy bucket with the keyed fingerprint and bounded policy", async () => {
    await expect(
      claimPublicRateLimit(request("198.51.100.24"), "public_stack_scan"),
    ).resolves.toEqual({
      status: "allowed",
      remaining: 3,
      retryAfterSeconds: 0,
    });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_public_rate_limit", {
      p_policy: "public_stack_scan",
      p_fingerprint: publicClientFingerprint("198.51.100.24", key, "public_stack_scan"),
      p_limit: 4,
      p_window_seconds: 1800,
    });
  });

  it("keeps conversion under its separate existing per-client policy", async () => {
    await claimPublicRateLimit(request("198.51.100.24"), "public_conversion");
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_public_rate_limit",
      expect.objectContaining({
        p_policy: "public_conversion",
        p_limit: 30,
        p_window_seconds: 900,
      }),
    );
  });

  it("claims and releases a bounded global scan slot", async () => {
    mocks.rpc.mockImplementationOnce((_name: string, args: { p_lease_id: string }) =>
      Promise.resolve({ data: [{ acquired: true, lease_id: args.p_lease_id }], error: null }),
    );
    const claim = await claimPublicScanSlot();
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") throw new Error("expected scan slot");
    const leaseId = claim.leaseId;
    expect(mocks.rpc).toHaveBeenCalledWith("claim_public_scan_slot", {
      p_lease_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      p_limit: 2,
      p_lease_seconds: 30,
    });
    mocks.rpc.mockResolvedValueOnce({ data: true, error: null });
    await expect(releasePublicScanSlot(leaseId)).resolves.toBe(true);
    expect(mocks.rpc).toHaveBeenLastCalledWith("release_public_scan_slot", {
      p_lease_id: leaseId,
    });
  });

  it("fails closed without a trusted, syntactically valid client address", async () => {
    for (const ip of [undefined, "", "unknown", "198.51.100.24, 203.0.113.1"]) {
      await expect(claimPublicRateLimit(request(ip), "public_stack_scan")).resolves.toEqual({
        status: "unavailable",
      });
    }
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("fails closed when the HMAC key is missing or the RPC is unavailable", async () => {
    mocks.getEnvironment.mockReturnValue({});
    await expect(
      claimPublicRateLimit(request("198.51.100.24"), "public_stack_scan"),
    ).resolves.toEqual({
      status: "unavailable",
    });
    expect(mocks.rpc).not.toHaveBeenCalled();

    mocks.getEnvironment.mockReturnValue({ PUBLIC_RATE_LIMIT_HMAC_SECRET: key });
    mocks.rpc.mockRejectedValue(new Error("storage unavailable"));
    await expect(claimPublicRateLimit(request(), "public_stack_scan")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("fails closed on malformed RPC output", async () => {
    mocks.rpc.mockResolvedValue({ data: [{ allowed: true, remaining: "3" }], error: null });
    await expect(claimPublicRateLimit(request(), "public_stack_scan")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("returns shared rate-limit decisions from the public scan route", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ allowed: false, remaining: 0, retry_after_seconds: 37 }],
      error: null,
    });
    const response = await stackScan(request("198.51.100.24"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("37");
    expect(await response.json()).toMatchObject({ error: "rate_limited" });
  });

  it("returns shared rate-limit decisions from the public conversion route", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{ allowed: false, remaining: 0, retry_after_seconds: 23 }],
      error: null,
    });
    const response = await conversion(
      new Request("https://auterim.com/api/public/conversion", {
        method: "POST",
        headers: { "x-real-ip": "198.51.100.24", "content-type": "application/json" },
        body: JSON.stringify({ event: "homepage_view" }),
      }),
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("23");
    expect(await response.json()).toEqual({ error: "rate_limited" });
    expect(mocks.rpc).toHaveBeenCalledWith(
      "claim_public_rate_limit",
      expect.objectContaining({ p_policy: "public_conversion", p_limit: 30 }),
    );
  });

  it("returns an unavailable response instead of using an instance-local fallback", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "not ready" } });
    const response = await stackScan(request("198.51.100.24"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    expect(await response.json()).toEqual({
      error: "rate_limiter_unavailable",
      message: "Please retry shortly.",
    });
  });
});
