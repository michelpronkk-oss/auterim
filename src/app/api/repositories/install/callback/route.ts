import { createHash } from "node:crypto";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const installationId = Number(url.searchParams.get("installation_id"));
  const setupAction = url.searchParams.get("setup_action");
  if (
    !state ||
    state.length > 128 ||
    !Number.isSafeInteger(installationId) ||
    installationId <= 0 ||
    !["install", "update"].includes(setupAction ?? "")
  ) {
    return Response.json({ error: "invalid_installation_callback" }, { status: 400 });
  }
  const environment = getEnvironment();
  if (!isIntegrationConfigured("githubApp", environment))
    return Response.json({ error: "github_app_not_configured" }, { status: 503 });
  const service = createSupabaseServerClient();
  const stateHash = createHash("sha256").update(state).digest("hex");
  const { data: stateRow, error: stateError } = await service
    .from("repository_installation_states")
    .select("workspace_id,actor_user_id,state_hash,github_login,oauth_completed_at")
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (stateError)
    return Response.json({ error: "installation_state_unavailable" }, { status: 503 });
  if (!stateRow) return Response.json({ error: "installation_state_expired" }, { status: 400 });
  if (!stateRow.github_login || !stateRow.oauth_completed_at)
    return Response.json({ error: "github_identity_required" }, { status: 403 });
  const { data: membership, error: membershipError } = await service
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", stateRow.workspace_id)
    .eq("user_id", stateRow.actor_user_id)
    .maybeSingle();
  if (membershipError || !membership)
    return Response.json({ error: "workspace_access_revoked" }, { status: 403 });
  const role = await getWorkspaceRole(service, stateRow.workspace_id, stateRow.actor_user_id);
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "workspace_access_revoked" }, { status: 403 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForService(stateRow.workspace_id);
    if (!entitlements.capabilities.repositoryConnections)
      return Response.json({ error: "pro_plan_required" }, { status: 402 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }
  let accountLogin: string;
  let repositories: Awaited<
    ReturnType<GitHubAppRepositoryProvider["listInstallationRepositories"]>
  >;
  try {
    const provider = new GitHubAppRepositoryProvider({
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
    });
    [accountLogin, repositories] = await Promise.all([
      provider.getInstallationAccount(installationId),
      provider.listInstallationRepositories(installationId),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "github_repository_limit_exceeded") {
      return Response.json(
        { error: "github_installation_repository_limit_exceeded", maximumRepositories: 500 },
        { status: 422 },
      );
    }
    return Response.json({ error: "github_installation_unavailable" }, { status: 503 });
  }
  if (accountLogin.toLowerCase() !== String(stateRow.github_login).toLowerCase())
    return Response.json({ error: "github_account_mismatch" }, { status: 403 });

  const { data: connection, error: connectionError } = await service
    .from("repository_connections")
    .upsert(
      {
        workspace_id: stateRow.workspace_id,
        provider: "github",
        installation_id: installationId,
        account_login: accountLogin,
        status: "connected",
        connected_by: stateRow.actor_user_id,
        connected_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "workspace_id,provider,installation_id" },
    )
    .select("id")
    .single();
  if (connectionError || !connection)
    return Response.json({ error: "repository_connection_failed" }, { status: 503 });
  if (repositories.length > 0) {
    const { error } = await service.from("repositories").upsert(
      repositories.map((repository) => ({
        workspace_id: stateRow.workspace_id,
        connection_id: connection.id,
        external_id: repository.id,
        owner: repository.owner.login,
        name: repository.name,
        default_branch: repository.default_branch,
        private: repository.private,
        archived: repository.archived,
        status: repository.archived ? "archived" : "available",
        last_synced_at: new Date().toISOString(),
      })),
      { onConflict: "workspace_id,external_id" },
    );
    if (error) return Response.json({ error: "repository_sync_failed" }, { status: 503 });
  }
  const { data: consumed, error: consumeError } = await service
    .from("repository_installation_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state_hash", stateHash)
    .is("consumed_at", null)
    .eq("github_login", stateRow.github_login)
    .gt("expires_at", new Date().toISOString())
    .select("state_hash")
    .maybeSingle();
  if (consumeError)
    return Response.json({ error: "installation_state_unavailable" }, { status: 503 });
  if (!consumed) return Response.json({ error: "installation_state_replayed" }, { status: 409 });
  return Response.json({
    connected: true,
    account: accountLogin,
    repositoriesImported: repositories.length,
  });
}
