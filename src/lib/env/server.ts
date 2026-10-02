import "server-only";
import { getEnvironment, getSupabasePublicConfig } from "@/lib/env/schema";

export function getSupabaseServerConfig() {
  const { url } = getSupabasePublicConfig();
  const environment = getEnvironment();
  const secretKey = environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;

  if (!secretKey) {
    throw new Error(
      "Supabase server access is not configured. Add the dedicated Auterim server secret to .env.local.",
    );
  }

  return { url, secretKey };
}
