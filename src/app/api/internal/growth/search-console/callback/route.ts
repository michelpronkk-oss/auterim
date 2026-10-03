import { createHash } from "node:crypto";
import {
  decryptOAuthActorToken,
  decryptOAuthVerifier,
  exchangeSearchConsoleCode,
  saveSearchConsoleConnection,
  searchConsoleAdminEmails,
  verifySearchConsoleProperty,
} from "@/lib/growth-v2/search-console";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment } from "@/lib/env/schema";
import { isAllowedVerifiedGrowthAdmin } from "@/lib/growth-v2/contract";

export const runtime = "nodejs";

function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") ?? "";
  const entry = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function redirect(result: "connected" | "denied" | "failed") {
  const target = new URL("/app/settings", getEnvironment().NEXT_PUBLIC_APP_URL);
  target.searchParams.set("searchConsole", result);
  const response = Response.redirect(target, 303);
  const secure =
    new URL(getEnvironment().NEXT_PUBLIC_APP_URL).protocol === "https:" ? " Secure;" : "";
  response.headers.append(
    "set-cookie",
    `auterim_gsc_state=; Path=/api/internal/growth/search-console/callback; Max-Age=0; HttpOnly; SameSite=Lax;${secure}`,
  );
  response.headers.set("cache-control", "no-store");
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const browserSecret = readCookie(request, "auterim_gsc_state");
  if (!state || !code || !browserSecret || state.length > 256 || code.length > 4096)
    return redirect("denied");
  const stateHash = createHash("sha256").update(state).digest("hex");
  const browserHash = createHash("sha256").update(browserSecret).digest("hex");
  const service = createSupabaseServerClient();
  const { data, error } = await service.rpc("claim_growth_search_console_oauth_state", {
    p_state_hash: stateHash,
    p_browser_hash: browserHash,
  });
  const binding = Array.isArray(data) ? data[0] : null;
  if (error || !binding) return redirect("denied");
  let actorAccessToken: string;
  try {
    actorAccessToken = decryptOAuthActorToken({
      ciphertext: binding.actor_token_ciphertext,
      nonce: binding.actor_token_nonce,
      authenticationTag: binding.actor_token_authentication_tag,
      keyVersion: binding.actor_token_key_version,
      stateHash,
    });
  } catch {
    return redirect("denied");
  }
  const { data: userResult, error: userError } = await service.auth.getUser(actorAccessToken);
  if (
    userError ||
    userResult.user?.id !== binding.actor_user_id ||
    !isAllowedVerifiedGrowthAdmin(
      userResult.user?.email,
      userResult.user?.email_confirmed_at,
      searchConsoleAdminEmails(),
    )
  )
    return redirect("denied");
  try {
    const verifier = decryptOAuthVerifier({
      ciphertext: binding.verifier_ciphertext,
      nonce: binding.verifier_nonce,
      authenticationTag: binding.verifier_authentication_tag,
      keyVersion: binding.verifier_key_version,
      stateHash,
    });
    const grant = await exchangeSearchConsoleCode({ code, verifier });
    await verifySearchConsoleProperty(grant.credential.accessToken);
    await saveSearchConsoleConnection({
      actorUserId: binding.actor_user_id,
      credential: grant.credential,
    });
    return redirect("connected");
  } catch {
    return redirect("failed");
  }
}
