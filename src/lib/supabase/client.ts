import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@/lib/env/schema";

/** Create a browser client only when a feature explicitly needs Supabase. */
export function createSupabaseBrowserClient() {
  const { url, publishableKey } = getSupabasePublicConfig();
  return createClient(url, publishableKey, {
    auth: {
      detectSessionInUrl: true,
      flowType: "implicit",
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}
