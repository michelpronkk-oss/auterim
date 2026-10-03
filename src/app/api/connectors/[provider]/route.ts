import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import {
  getFreshProviderCredentials,
  loadInstallation,
  serverConnectors,
} from "@/lib/connectors/service";
import { getConnectorProvider } from "@/lib/connectors/providers";
import { getWorkspaceRole } from "@/lib/billing/server";
import type { ConnectorProvider } from "@/lib/connectors/model";

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const providerValue = (await context.params).provider;
  if (!(providerValue === "slack" || providerValue === "linear" || providerValue === "sentry"))
    return Response.json({ error: "unsupported_connector" }, { status: 404 });
  const provider = providerValue;
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const input = z
    .object({ workspaceId: z.string().uuid(), installationId: z.string().uuid() })
    .safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json({ error: "invalid_disconnect_request" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });
  const service = serverConnectors();
  let accessToken: string | null = null;
  try {
    const installation = await loadInstallation(
      service,
      input.data.workspaceId,
      input.data.installationId,
      provider,
    );
    const credentials = await getFreshProviderCredentials(service, installation);
    accessToken = credentials.accessToken;
  } catch {
    // Local revocation remains available when the provider is already inaccessible.
  }
  const { data, error } = await service.rpc("disconnect_connector", {
    p_workspace_id: input.data.workspaceId,
    p_installation_id: input.data.installationId,
    p_actor_user_id: auth.user.id,
  });
  if (error || data !== true) {
    const code = (error as { code?: string } | null)?.code;
    return Response.json(
      { error: code === "42501" ? "forbidden" : "connector_disconnect_failed" },
      { status: code === "42501" ? 403 : 503 },
    );
  }
  if (accessToken) {
    try {
      await getConnectorProvider(provider).revoke(accessToken);
    } catch {
      // Credentials are already unusable locally; provider-side revoke is best-effort.
    }
  }
  return Response.json({ disconnected: true, provider: provider as ConnectorProvider });
}
