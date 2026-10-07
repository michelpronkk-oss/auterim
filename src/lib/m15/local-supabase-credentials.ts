import "server-only";

import { assertM15LocalSupabaseBinding } from "@/lib/m15/local-supabase-binding";

export type M15LocalSupabaseCredentials = {
  url: string;
  secretKey: string;
};

export function parseM15LocalSupabaseCredentials(
  input: { url: string | undefined; secretKey: string | undefined },
  nodeEnv: string | undefined,
): M15LocalSupabaseCredentials {
  if (
    typeof input.url !== "string" ||
    typeof input.secretKey !== "string" ||
    input.secretKey.length < 20
  ) {
    throw new Error("m15_local_supabase_credentials_invalid");
  }

  try {
    assertM15LocalSupabaseBinding({ enabled: "1", nodeEnv, url: input.url });
  } catch {
    throw new Error("m15_local_supabase_credentials_target_forbidden");
  }

  return { url: input.url, secretKey: input.secretKey };
}

/** Load the guarded local-only secret from the worker process environment, never disk. */
export function loadM15LocalSupabaseCredentials(
  nodeEnv: string | undefined,
): M15LocalSupabaseCredentials {
  return parseM15LocalSupabaseCredentials(
    {
      url: process.env.AUTERIM_M15_LOCAL_SUPABASE_URL,
      secretKey: process.env.AUTERIM_M15_LOCAL_SUPABASE_SECRET_KEY,
    },
    nodeEnv,
  );
}
