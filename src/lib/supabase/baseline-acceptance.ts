import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getBaselineAcceptanceEnvironment } from "@/lib/m15/baseline-acceptance-environment";

export function createBaselineAcceptanceSupabaseClient() {
  const environment = getBaselineAcceptanceEnvironment();
  const secretKey = environment.SUPABASE_SECRET_KEY ?? environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!secretKey) throw new Error("baseline_acceptance_supabase_credential_missing");

  return createClient(environment.NEXT_PUBLIC_SUPABASE_URL, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
