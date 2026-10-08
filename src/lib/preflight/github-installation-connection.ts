import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  GitHubAppInstallationError,
  GitHubAppRepositoryProvider,
  listUserAccessibleInstallationRepositories,
  type GitHubUserInstallation,
} from "@/lib/preflight/github-provider";

export type VerifiedGitHubConnectionResult = {
  accountLogin: string;
  repositoriesImported: number;
  userAccessibleRepositoryCount: number;
};

function sameInstallationIdentity(left: GitHubUserInstallation, right: GitHubUserInstallation) {
  const sortPermissions = (permissions: Record<string, string>) =>
    Object.entries(permissions).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  return (
    left.id === right.id &&
    left.appId === right.appId &&
    left.accountLogin.toLowerCase() === right.accountLogin.toLowerCase() &&
    left.targetType === right.targetType &&
    left.repositorySelection === right.repositorySelection &&
    left.suspendedAt === right.suspendedAt &&
    JSON.stringify(sortPermissions(left.permissions)) ===
      JSON.stringify(sortPermissions(right.permissions))
  );
}

/**
 * Persists an installation only after both the ephemeral user token and the
 * Auterim App credentials independently verify the same installation.
 */
export async function persistVerifiedGitHubInstallation(input: {
  service: SupabaseClient;
  provider: GitHubAppRepositoryProvider;
  workspaceId: string;
  actorUserId: string;
  stateHash: string;
  githubLogin: string;
  userAccessToken: string;
  userInstallation: GitHubUserInstallation;
}): Promise<VerifiedGitHubConnectionResult> {
  if (input.userInstallation.suspendedAt)
    throw new GitHubAppInstallationError({
      stage: "installation_metadata",
      category: "installation_unavailable",
    });

  let userRepositories;
  try {
    userRepositories = await listUserAccessibleInstallationRepositories({
      accessToken: input.userAccessToken,
      installationId: input.userInstallation.id,
    });
  } catch {
    throw new GitHubAppInstallationError({
      stage: "user_installation_authorization",
      category: "permission_denied",
    });
  }

  const appInstallation = await input.provider.verifyInstallation(input.userInstallation.id);
  if (!sameInstallationIdentity(input.userInstallation, appInstallation))
    throw new GitHubAppInstallationError({
      stage: "installation_metadata",
      category: "invalid_response",
    });

  const repositories = await input.provider.listInstallationRepositories(appInstallation.id);
  const { data: connection, error: connectionError } = await input.service
    .from("repository_connections")
    .upsert(
      {
        workspace_id: input.workspaceId,
        provider: "github",
        installation_id: appInstallation.id,
        account_login: appInstallation.accountLogin,
        status: "connected",
        connected_by: input.actorUserId,
        connected_at: new Date().toISOString(),
        revoked_at: null,
      },
      { onConflict: "workspace_id,provider,installation_id" },
    )
    .select("id")
    .single();
  if (connectionError || !connection)
    throw new Error("github_repository_connection_persistence_failed");

  if (repositories.length > 0) {
    const { error } = await input.service.from("repositories").upsert(
      repositories.map((repository) => ({
        workspace_id: input.workspaceId,
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
    if (error) throw new Error("github_repository_catalog_persistence_failed");
  }

  const { data: consumed, error: consumeError } = await input.service
    .from("repository_installation_states")
    .update({
      github_login: input.githubLogin,
      oauth_completed_at: new Date().toISOString(),
      consumed_at: new Date().toISOString(),
    })
    .eq("state_hash", input.stateHash)
    .is("consumed_at", null)
    .gt("expires_at", new Date().toISOString())
    .select("state_hash")
    .maybeSingle();
  if (consumeError) throw new Error("github_installation_state_persistence_failed");
  if (!consumed) throw new Error("github_installation_state_replayed");

  return {
    accountLogin: appInstallation.accountLogin,
    repositoriesImported: repositories.length,
    userAccessibleRepositoryCount: userRepositories.length,
  };
}
