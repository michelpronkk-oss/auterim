import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig } from "@/lib/env/server";

/** Create a privileged client inside server-only code when a feature explicitly needs it. */
export function createSupabaseServerClient() {
  const { url, secretKey } = getSupabaseServerConfig();
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
