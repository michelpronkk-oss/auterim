import "server-only";
import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { getEnvironment } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export type PublicRateLimitPolicy = "public_stack_scan" | "public_conversion";

export type PublicRateLimitResult =
  | { status: "allowed"; remaining: number; retryAfterSeconds: 0 }
  | { status: "limited"; remaining: 0; retryAfterSeconds: number }
  | { status: "unavailable" };

const POLICY_LIMITS: Record<PublicRateLimitPolicy, { limit: number; windowSeconds: number }> = {
  public_stack_scan: { limit: 4, windowSeconds: 30 * 60 },
  public_conversion: { limit: 30, windowSeconds: 15 * 60 },
};

/** Fingerprints a trusted client address without persisting or exposing the address itself. */
export function publicClientFingerprint(address: string, secret: string, policy: string) {
  return createHmac("sha256", secret)
    .update(`auterim-public-rate-limit:v1:${policy}:`)
    .update(address)
    .digest("hex");
}

/** Uses the shared service-only Supabase RPC so limits apply across app instances. */
export async function claimPublicRateLimit(
  request: Request,
  policy: PublicRateLimitPolicy,
): Promise<PublicRateLimitResult> {
  const address = request.headers.get("x-real-ip")?.trim();
  if (!address || isIP(address) === 0) return { status: "unavailable" };

  let secret: string | undefined;
  try {
    secret = getEnvironment().PUBLIC_RATE_LIMIT_HMAC_SECRET;
  } catch {
    return { status: "unavailable" };
  }
  if (!secret) return { status: "unavailable" };

  const { limit, windowSeconds } = POLICY_LIMITS[policy];
  const fingerprint = publicClientFingerprint(address, secret, policy);
  try {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("claim_public_rate_limit", {
      p_policy: policy,
      p_fingerprint: fingerprint,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return { status: "unavailable" };

    const row = data[0] as Record<string, unknown> | null;
    if (!row || typeof row.allowed !== "boolean") return { status: "unavailable" };
    if (
      typeof row.remaining !== "number" ||
      !Number.isInteger(row.remaining) ||
      row.remaining < 0 ||
      row.remaining > limit
    )
      return { status: "unavailable" };
    if (
      typeof row.retry_after_seconds !== "number" ||
      !Number.isInteger(row.retry_after_seconds) ||
      row.retry_after_seconds < 0 ||
      row.retry_after_seconds > windowSeconds
    )
      return { status: "unavailable" };

    if (!row.allowed) {
      return {
        status: "limited",
        remaining: 0,
        retryAfterSeconds: Math.max(1, Number(row.retry_after_seconds)),
      };
    }
    return {
      status: "allowed",
      remaining: Number(row.remaining),
      retryAfterSeconds: 0,
    };
  } catch {
    // Public endpoints with expensive or write-capable behavior fail closed if the shared
    // limiter cannot be reached; never fall back to a per-instance counter.
    return { status: "unavailable" };
  }
}

export type PublicScanSlotResult =
  { status: "acquired"; leaseId: string } | { status: "full" } | { status: "unavailable" };

/** Claims one global, expiring scan slot shared by all application instances. */
export async function claimPublicScanSlot(): Promise<PublicScanSlotResult> {
  const leaseId = randomUUID();
  try {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("claim_public_scan_slot", {
      p_lease_id: leaseId,
      p_limit: 2,
      p_lease_seconds: 30,
    });
    if (error || !Array.isArray(data) || data.length !== 1) return { status: "unavailable" };
    const row = data[0] as Record<string, unknown> | null;
    if (!row || typeof row.acquired !== "boolean") return { status: "unavailable" };
    if (!row.acquired) return { status: "full" };
    return row.lease_id === leaseId ? { status: "acquired", leaseId } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Releases a scan slot; an abandoned lease also expires automatically after 30 seconds. */
export async function releasePublicScanSlot(leaseId: string) {
  try {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("release_public_scan_slot", {
      p_lease_id: leaseId,
    });
    return !error && data === true;
  } catch {
    return false;
  }
}
