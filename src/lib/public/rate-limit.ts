import "server-only";
import { createHash } from "node:crypto";

type WindowEntry = { count: number; resetAt: number };
const windows = new Map<string, WindowEntry>();
const MAX_ENTRIES = 10_000;

export function publicClientKey(request: Request) {
  const address = request.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(address).digest("hex");
}

export function consumePublicRateLimit(
  key: string,
  options: { now?: number; limit?: number; windowMs?: number } = {},
) {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? 4;
  const windowMs = options.windowMs ?? 30 * 60 * 1000;
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    if (windows.size >= MAX_ENTRIES) {
      for (const [entryKey, entry] of windows) {
        if (entry.resetAt <= now) windows.delete(entryKey);
      }
      if (windows.size >= MAX_ENTRIES) windows.clear();
    }
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  if (current.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }
  current.count += 1;
  return { allowed: true, remaining: limit - current.count, retryAfterSeconds: 0 };
}

export function resetPublicRateLimitsForTests() {
  windows.clear();
}
