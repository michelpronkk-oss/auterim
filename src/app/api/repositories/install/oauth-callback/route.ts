import { createHash, randomUUID } from "node:crypto";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import {
  exchangeGitHubAppOAuthCode,
  GitHubAppInstallationError,
  GitHubAppRepositoryProvider,
  listUserAccessibleGitHubAppInstallations,
} from "@/lib/preflight/github-provider";
import { persistVerifiedGitHubInstallation } from "@/lib/preflight/github-installation-connection";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";
import { recordGrowthFirstPartyEvent } from "@/lib/growth-v2/feedback";

const githubStatePattern = /^([A-Za-z0-9_-]{43})(?:\.i([1-9][0-9]{0,15}))?$/;

function settingsRedirect(status: string) {
  const target = new URL("/app/settings", getEnvironment().NEXT_PUBLIC_APP_URL);
  target.searchParams.set("github", status);
  return Response.redirect(target);
}

function installationStartUrl(state: string) {
  const environment = getEnvironment();
  const target = new URL(
    `https://github.com/apps/${environment.GITHUB_APP_SLUG}/installations/new`,
  );
  target.searchParams.set("state", state);
  return target;
}

function readOnlyInstallation(installation: {
  permissions: Record<string, string>;
  suspendedAt: string | null;
}) {
  return (
    !installation.suspendedAt &&
    installation.permissions.contents === "read" &&
    installation.permissions.metadata === "read" &&
    Object.values(installation.permissions).every((permission) => permission === "read")
  );
}

function reportSafeFailure(correlationId: string, error: unknown, fallbackStage: string) {
  const diagnostic =
    error instanceof GitHubAppInstallationError
      ? {
          stage: error.stage,
          category: error.category,
          upstreamStatus: error.upstreamStatus ?? null,
        }
      : { stage: fallbackStage, category: "safe_failure", upstreamStatus: null };
  console.warn(
    "github_oauth_installation_resolution_failure",
    JSON.stringify({ correlationId, ...diagnostic }),
  );
}

export async function GET(request: Request) {
  const correlationId = randomUUID();
  const url = new URL(request.url);
  const rawState = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const parsedState = rawState ? githubStatePattern.exec(rawState) : null;
  if (!parsedState || !code || code.length > 512) return settingsRedirect("invalid_state");

  const state = parsedState[1]!;
  const candidateInstallationId = parsedState[2] ? Number(parsedState[2]) : null;
  if (
    candidateInstallationId !== null &&
    (!Number.isSafeInteger(candidateInstallationId) || candidateInstallationId <= 0)
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
  if (candidateInstallationId === null && stateRow.oauth_completed_at)
    return settingsRedirect("state_replayed");
  if (candidateInstallationId !== null && !stateRow.oauth_completed_at)
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

  let oauthUser: Awaited<ReturnType<typeof exchangeGitHubAppOAuthCode>>;
  try {
    oauthUser = await exchangeGitHubAppOAuthCode({
      clientId: environment.GITHUB_APP_CLIENT_ID!,
      clientSecret: environment.GITHUB_APP_CLIENT_SECRET!,
      code,
    });
  } catch {
    reportSafeFailure(correlationId, null, "user_token_exchange");
    return settingsRedirect("authorization_unavailable");
  }

  if (
    candidateInstallationId !== null &&
    oauthUser.login.toLowerCase() !== String(stateRow.github_login ?? "").toLowerCase()
  ) {
    return settingsRedirect("installation_identity_mismatch");
  }

  let installations;
  try {
    installations = await listUserAccessibleGitHubAppInstallations({
      accessToken: oauthUser.accessToken,
      appId: environment.GITHUB_APP_ID!,
    });
  } catch {
    reportSafeFailure(correlationId, null, "user_installations");
    return settingsRedirect("authorization_unavailable");
  }

  let selectedInstallation = null;
  if (candidateInstallationId !== null) {
    selectedInstallation =
      installations.find((installation) => installation.id === candidateInstallationId) ?? null;
    if (!selectedInstallation) return settingsRedirect("installation_not_authorized");
  } else if (installations.length === 0) {
    const { data: updated, error: updateError } = await service
      .from("repository_installation_states")
      .update({
        github_login: oauthUser.login,
        oauth_completed_at: new Date().toISOString(),
      })
      .eq("state_hash", stateHash)
      .is("consumed_at", null)
      .is("oauth_completed_at", null)
      .gt("expires_at", new Date().toISOString())
      .select("state_hash")
      .maybeSingle();
    if (updateError) return settingsRedirect("temporarily_unavailable");
    if (!updated) return settingsRedirect("state_replayed");
    return Response.redirect(installationStartUrl(state));
  } else if (installations.length > 1) {
    console.info(
      "github_oauth_installation_selection_required",
      JSON.stringify({ correlationId, installationCount: installations.length }),
    );
    return settingsRedirect("installation_selection_required");
  } else {
    selectedInstallation = installations[0]!;
  }

  if (!selectedInstallation) return settingsRedirect("installation_not_authorized");
  if (selectedInstallation.suspendedAt) return settingsRedirect("installation_suspended");
  if (!readOnlyInstallation(selectedInstallation))
    return settingsRedirect("permissions_unavailable");

  const provider = new GitHubAppRepositoryProvider({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
  let result;
  try {
    result = await persistVerifiedGitHubInstallation({
      service,
      provider,
      workspaceId: stateRow.workspace_id,
      actorUserId: stateRow.actor_user_id,
      stateHash,
      githubLogin: oauthUser.login,
      userAccessToken: oauthUser.accessToken,
      userInstallation: selectedInstallation,
    });
  } catch (error) {
    reportSafeFailure(correlationId, error, "installation_persistence");
    if (error instanceof Error && error.message === "github_installation_state_replayed")
      return settingsRedirect("state_replayed");
    return settingsRedirect("connection_failed");
  }

  console.info(
    "github_oauth_installation_connected",
    JSON.stringify({
      correlationId,
      installationId: selectedInstallation.id,
      repositoryCount: result.repositoriesImported,
      userAccessibleRepositoryCount: result.userAccessibleRepositoryCount,
    }),
  );
  try {
    await recordGrowthFirstPartyEvent({
      eventType: "github_connected",
      stableKey: `${stateRow.workspace_id}:${selectedInstallation.id}`,
    });
  } catch {
    // Product connection success is independent of funnel reporting availability.
  }
  return settingsRedirect("connected");
}
