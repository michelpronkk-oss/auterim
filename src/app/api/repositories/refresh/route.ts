import { z } from "zod";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";
import {
  GitHubAppInstallationError,
  GitHubAppRepositoryProvider,
} from "@/lib/preflight/github-provider";
import { refreshGitHubInstallationCatalog } from "@/lib/preflight/github-installation-connection";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const inputSchema = z.object({ workspaceId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      auth.client,
      input.workspaceId,
    );
    if (!entitlements.capabilities.repositoryConnections)
      return Response.json({ error: "pro_plan_required" }, { status: 402 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }

  const environment = getEnvironment();
  if (!isIntegrationConfigured("githubApp", environment))
    return Response.json({ error: "github_app_not_configured" }, { status: 503 });

  const service = createSupabaseServerClient();
  const { data: connections, error } = await service
    .from("repository_connections")
    .select("id")
    .eq("workspace_id", input.workspaceId)
    .eq("provider", "github")
    .eq("status", "connected")
    .limit(2);
  if (error) return Response.json({ error: "github_connection_unavailable" }, { status: 503 });
  if (!connections?.length)
    return Response.json({ error: "github_not_connected" }, { status: 409 });
  if (connections.length !== 1)
    return Response.json({ error: "github_installation_selection_required" }, { status: 409 });

  try {
    const provider = new GitHubAppRepositoryProvider({
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
    });
    const result = await refreshGitHubInstallationCatalog({
      service,
      provider,
      workspaceId: input.workspaceId,
      connectionId: connections[0]!.id,
    });
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const category =
      error instanceof GitHubAppInstallationError
        ? `${error.stage}_${error.category}`
        : error instanceof Error &&
            [
              "github_connection_not_found",
              "github_connection_unavailable",
              "github_connection_invalid",
              "github_installation_identity_mismatch",
              "github_repository_catalog_persistence_failed",
              "github_repository_catalog_read_failed",
              "github_repository_catalog_reconcile_failed",
              "github_repository_access_reconcile_failed",
            ].includes(error.message)
          ? error.message
          : "safe_failure";
    return Response.json({ error: "github_catalog_refresh_failed", category }, { status: 503 });
  }
}
