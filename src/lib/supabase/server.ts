import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfig } from "@/lib/env/server";
import {
  assertM15LocalSupabaseBinding,
  assertM15LocalSupabaseUrlsMatch,
} from "@/lib/m15/local-supabase-binding";
import { loadM15LocalSupabaseCredentials } from "@/lib/m15/local-supabase-credentials";

/** Create a privileged client inside server-only code when a feature explicitly needs it. */
export function createSupabaseServerClient() {
  if (process.env.AUTERIM_M15_LOCAL_INTEGRATION === "1") {
    const local = loadM15LocalSupabaseCredentials(process.env.NODE_ENV);
    assertM15LocalSupabaseUrlsMatch(local.url, process.env.NEXT_PUBLIC_SUPABASE_URL);
    return createClient(local.url, local.secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  assertM15LocalSupabaseBinding({
    enabled: process.env.AUTERIM_M15_LOCAL_INTEGRATION,
    nodeEnv: process.env.NODE_ENV,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  const { url, secretKey } = getSupabaseServerConfig();
  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
