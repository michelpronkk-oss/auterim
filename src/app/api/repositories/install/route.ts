import { createHash, randomBytes } from "node:crypto";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";
import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { z } from "zod";

const inputSchema = z.object({ workspaceId: z.string().uuid() });

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  let input: z.infer<typeof inputSchema>;
  try {
    input = inputSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  let role: Awaited<ReturnType<typeof getWorkspaceRole>>;
  try {
    role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id);
  } catch {
    return Response.json({ error: "workspace_access_unavailable" }, { status: 503 });
  }
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
  const state = randomBytes(32).toString("base64url");
  const stateHash = createHash("sha256").update(state).digest("hex");
  const service = createSupabaseServerClient();
  const { error } = await service.from("repository_installation_states").insert({
    state_hash: stateHash,
    workspace_id: input.workspaceId,
    actor_user_id: auth.user.id,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  if (error) return Response.json({ error: "installation_state_failed" }, { status: 503 });
  const authorization = new URL("https://github.com/login/oauth/authorize");
  authorization.searchParams.set("client_id", environment.GITHUB_APP_CLIENT_ID!);
  authorization.searchParams.set("scope", "read:user");
  authorization.searchParams.set("state", state);
  return Response.json({ authorizationUrl: authorization.toString(), expiresInSeconds: 600 });
}
