import { createHash } from "node:crypto";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";

function settingsRedirect(status: string) {
  const target = new URL("/app/settings", getEnvironment().NEXT_PUBLIC_APP_URL);
  target.searchParams.set("github", status);
  return Response.redirect(target);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const rawInstallationId = url.searchParams.get("installation_id");
  const installationId =
    rawInstallationId && /^[1-9][0-9]{0,15}$/.test(rawInstallationId)
      ? Number(rawInstallationId)
      : Number.NaN;
  const setupAction = url.searchParams.get("setup_action");
  if (
    !state ||
    !/^[A-Za-z0-9_-]{43}$/.test(state) ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0 ||
    !["install", "update"].includes(setupAction ?? "")
  ) {
    return settingsRedirect("invalid_state");
  }
  const environment = getEnvironment();
  if (!isIntegrationConfigured("githubApp", environment)) return settingsRedirect("unavailable");

  const service = createSupabaseServerClient();
  const stateHash = createHash("sha256").update(state).digest("hex");
  const { data: stateRow, error: stateError } = await service
    .from("repository_installation_states")
    .select("workspace_id,actor_user_id,state_hash,github_login,oauth_completed_at")
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (stateError) return settingsRedirect("temporarily_unavailable");
  if (!stateRow) return settingsRedirect("state_expired");
  if (!stateRow.github_login || !stateRow.oauth_completed_at)
    return settingsRedirect("installation_authorization_required");

  const { data: membership, error: membershipError } = await service
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", stateRow.workspace_id)
    .eq("user_id", stateRow.actor_user_id)
    .maybeSingle();
  if (membershipError || !membership) return settingsRedirect("workspace_access_revoked");
  const role = await getWorkspaceRole(service, stateRow.workspace_id, stateRow.actor_user_id);
  if (role !== "owner" && role !== "admin") return settingsRedirect("workspace_access_revoked");
  try {
    const entitlements = await resolveWorkspaceEntitlementsForService(stateRow.workspace_id);
    if (!entitlements.capabilities.repositoryConnections) return settingsRedirect("pro_required");
  } catch {
    return settingsRedirect("temporarily_unavailable");
  }

  // installation_id from this callback is only a candidate. A second short
  // user OAuth round trip proves that this GitHub user can access it before
  // App credentials are used or any connection/catalog data is persisted.
  const authorization = new URL("https://github.com/login/oauth/authorize");
  authorization.searchParams.set("client_id", environment.GITHUB_APP_CLIENT_ID!);
  authorization.searchParams.set("scope", "read:user");
  authorization.searchParams.set("state", `${state}.i${installationId}`);
  return Response.redirect(authorization);
}
