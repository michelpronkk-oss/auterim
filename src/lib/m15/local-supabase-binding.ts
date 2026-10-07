type LocalSupabaseBinding = {
  enabled: string | undefined;
  nodeEnv: string | undefined;
  url: string | undefined;
};

const expectedOrigins = new Set([
  "http://127.0.0.1:65431",
  "http://localhost:65431",
  "http://[::1]:65431",
]);

/** Fail closed if an M15 local acceptance worker is accidentally given hosted persistence. */
export function assertM15LocalSupabaseBinding(binding: LocalSupabaseBinding) {
  if (binding.enabled !== "1") return;
  if (binding.nodeEnv === "production") throw new Error("m15_local_worker_production_forbidden");

  let origin: string;
  try {
    const url = new URL(binding.url ?? "");
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("m15_local_worker_supabase_target_forbidden");
    }
    origin = url.origin;
  } catch {
    throw new Error("m15_local_worker_supabase_target_forbidden");
  }
  if (!expectedOrigins.has(origin)) throw new Error("m15_local_worker_supabase_target_forbidden");
}

/** Prevent acceptance-only synthetic writes from running in normal or production app flows. */
export function assertM15LocalAcceptanceEnabled(binding: LocalSupabaseBinding) {
  if (binding.nodeEnv === "production")
    throw new Error("m15_local_acceptance_production_forbidden");
  if (binding.enabled !== "1") throw new Error("m15_local_acceptance_flag_required");
  if (binding.url) assertM15LocalSupabaseBinding(binding);
}
