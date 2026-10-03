import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@/lib/env/schema";

let browserClient: ReturnType<typeof createClient> | undefined;

/** Create a browser client only when a feature explicitly needs Supabase. */
export function createSupabaseBrowserClient() {
  if (browserClient) return browserClient;
  const { url, publishableKey } = getSupabasePublicConfig();
  browserClient = createClient(url, publishableKey, {
    auth: {
      detectSessionInUrl: true,
      flowType: "implicit",
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  return browserClient;
}
