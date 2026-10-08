type LocalSupabaseBinding = {
  enabled: string | undefined;
  nodeEnv: string | undefined;
  url: string | undefined;
};

function isLoopbackHostname(hostname: string) {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

/** Fail closed if an M15 local acceptance worker is accidentally given hosted persistence. */
export function assertM15LocalSupabaseBinding(binding: LocalSupabaseBinding) {
  if (binding.enabled !== "1") return;
  if (binding.nodeEnv === "production") throw new Error("m15_local_worker_production_forbidden");

  try {
    const url = new URL(binding.url ?? "");
    const port = Number(url.port);
    if (
      url.protocol !== "http:" ||
      !isLoopbackHostname(url.hostname) ||
      !url.port ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      throw new Error("m15_local_worker_supabase_target_forbidden");
    }
  } catch {
    throw new Error("m15_local_worker_supabase_target_forbidden");
  }
}

/** Keep browser and server clients bound to one exact local QA Supabase origin. */
export function assertM15LocalSupabaseUrlsMatch(
  localUrl: string | undefined,
  publicUrl: string | undefined,
) {
  if (!localUrl || localUrl !== publicUrl)
    throw new Error("m15_local_worker_supabase_target_mismatch");
}

/** Prevent acceptance-only synthetic writes from running in normal or production app flows. */
export function assertM15LocalAcceptanceEnabled(binding: LocalSupabaseBinding) {
  if (binding.nodeEnv === "production")
    throw new Error("m15_local_acceptance_production_forbidden");
  if (binding.enabled !== "1") throw new Error("m15_local_acceptance_flag_required");
  if (binding.url) assertM15LocalSupabaseBinding(binding);
}
