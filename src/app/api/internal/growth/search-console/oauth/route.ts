import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import {
  createOAuthBinding,
  isSearchConsoleConfigured,
  searchConsoleAdminEmails,
  searchConsoleAuthorizationUrl,
} from "@/lib/growth-v2/search-console";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment } from "@/lib/env/schema";
import { isAllowedVerifiedGrowthAdmin } from "@/lib/growth-v2/contract";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  if (
    !isAllowedVerifiedGrowthAdmin(
      auth.user.email,
      auth.user.email_confirmed_at,
      searchConsoleAdminEmails(),
    )
  )
    return Response.json({ error: "forbidden" }, { status: 403 });
  if (!isSearchConsoleConfigured())
    return Response.json({ error: "search_console_not_configured" }, { status: 503 });

  try {
    const binding = createOAuthBinding(auth.accessToken);
    const service = createSupabaseServerClient();
    const { error } = await service.from("growth_search_console_oauth_states").insert({
      state_hash: binding.stateHash,
      actor_user_id: auth.user.id,
      browser_hash: binding.browserHash,
      verifier_ciphertext: binding.encryptedVerifier.ciphertext,
      verifier_nonce: binding.encryptedVerifier.nonce,
      verifier_authentication_tag: binding.encryptedVerifier.authenticationTag,
      verifier_key_version: binding.encryptedVerifier.keyVersion,
      actor_token_ciphertext: binding.encryptedActorToken.ciphertext,
      actor_token_nonce: binding.encryptedActorToken.nonce,
      actor_token_authentication_tag: binding.encryptedActorToken.authenticationTag,
      actor_token_key_version: binding.encryptedActorToken.keyVersion,
      expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    if (error) return Response.json({ error: "search_console_unavailable" }, { status: 503 });
    const authorizationUrl = searchConsoleAuthorizationUrl({
      state: binding.state,
      challenge: binding.challenge,
    });
    const secure =
      new URL(getEnvironment().NEXT_PUBLIC_APP_URL).protocol === "https:" ? " Secure;" : "";
    const cookie = `auterim_gsc_state=${binding.browserSecret}; Path=/api/internal/growth/search-console/callback; Max-Age=300; HttpOnly; SameSite=Lax;${secure}`;
    if (request.headers.get("accept")?.includes("application/json"))
      return Response.json(
        { authorizationUrl },
        {
          headers: {
            "set-cookie": cookie,
            "cache-control": "no-store",
          },
        },
      );
    return new Response(null, {
      status: 302,
      headers: {
        location: authorizationUrl,
        "set-cookie": cookie,
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "search_console_unavailable" }, { status: 503 });
  }
}
