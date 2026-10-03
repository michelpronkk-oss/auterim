import { createHash } from "node:crypto";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { exchangeGitHubAppOAuthCode } from "@/lib/preflight/github-provider";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (!state || state.length > 128 || !code || code.length > 512)
    return Response.json({ error: "invalid_github_oauth_callback" }, { status: 400 });
  const environment = getEnvironment();
  if (!isIntegrationConfigured("githubApp", environment))
    return Response.json({ error: "github_app_not_configured" }, { status: 503 });
  const service = createSupabaseServerClient();
  const stateHash = createHash("sha256").update(state).digest("hex");
  const { data: stateRow, error } = await service
    .from("repository_installation_states")
    .select("workspace_id,actor_user_id,state_hash")
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .is("oauth_completed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) return Response.json({ error: "installation_state_unavailable" }, { status: 503 });
  if (!stateRow) return Response.json({ error: "installation_state_expired" }, { status: 400 });
  const { data: membership, error: membershipError } = await service
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", stateRow.workspace_id)
    .eq("user_id", stateRow.actor_user_id)
    .maybeSingle();
  if (membershipError || !membership)
    return Response.json({ error: "workspace_access_revoked" }, { status: 403 });
  let githubLogin: string;
  try {
    githubLogin = await exchangeGitHubAppOAuthCode({
      clientId: environment.GITHUB_APP_CLIENT_ID!,
      clientSecret: environment.GITHUB_APP_CLIENT_SECRET!,
      code,
    });
  } catch {
    return Response.json({ error: "github_identity_unavailable" }, { status: 503 });
  }
  const { data: updated, error: updateError } = await service
    .from("repository_installation_states")
    .update({
      github_login: githubLogin,
      oauth_completed_at: new Date().toISOString(),
    })
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .is("oauth_completed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("state_hash")
    .maybeSingle();
  if (updateError)
    return Response.json({ error: "installation_state_unavailable" }, { status: 503 });
  if (!updated) return Response.json({ error: "installation_state_replayed" }, { status: 409 });
  const installUrl = new URL(
    `https://github.com/apps/${environment.GITHUB_APP_SLUG}/installations/new`,
  );
  installUrl.searchParams.set("state", state);
  return Response.redirect(installUrl);
}
