#!/usr/bin/env node
// External Supabase reachability probe. Uses only the public project URL and publishable
// key. Exits non-zero on any DNS, transport, timeout or non-200 result, including missing
// configuration, so a scheduled CI run fails (and notifies) instead of passing silently.
import { lookup } from "node:dns/promises";

/**
 * @param {{
 *   url?: string;
 *   publishableKey?: string;
 *   fetchImpl?: (input: URL, init?: RequestInit) => Promise<Response>;
 *   resolve?: (hostname: string) => Promise<unknown>;
 * }} options
 */
export async function probeSupabase({ url, publishableKey, fetchImpl = fetch, resolve = lookup }) {
  if (!url || !publishableKey) return { ok: false, stage: "configuration", detail: "missing" };
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, stage: "configuration", detail: "invalid_url" };
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co"))
    return { ok: false, stage: "configuration", detail: "not_a_supabase_project_url" };
  try {
    await resolve(parsed.hostname);
  } catch (error) {
    return { ok: false, stage: "dns", detail: error?.code ?? "lookup_failed" };
  }
  try {
    const response = await fetchImpl(new URL("/auth/v1/health", parsed), {
      headers: { apikey: publishableKey },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 200) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: true, stage: "http", detail: "200" };
    }
    // A rejected publishable key means browser clients are broken too; name it explicitly.
    const body =
      response.status === 401 ? (await response.text().catch(() => "")).slice(0, 512) : "";
    if (/invalid api key/i.test(body))
      return { ok: false, stage: "http", detail: "401 invalid_api_key" };
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, stage: "http", detail: String(response.status) };
  } catch (error) {
    return { ok: false, stage: "transport", detail: error?.name ?? "request_failed" };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await probeSupabase({
    url: process.env.SUPABASE_URL,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY,
  });
  console.log(
    `supabase health: ${result.ok ? "ok" : "FAILED"} (${result.stage}: ${result.detail})`,
  );
  process.exit(result.ok ? 0 : 1);
}
