import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";

export async function PUT(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const input = z
    .object({
      workspaceId: z.string().uuid(),
      inAppEnabled: z.boolean(),
      emailEnabled: z.boolean(),
    })
    .safeParse(body);
  if (!input.success)
    return Response.json({ error: "invalid_notification_preferences" }, { status: 400 });
  if (!(await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const { data, error } = await auth.client.rpc("set_notification_channel_preferences", {
    p_workspace_id: input.data.workspaceId,
    p_in_app_enabled: input.data.inAppEnabled,
    p_email_enabled: input.data.emailEnabled,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    return Response.json(
      { error: code === "42501" ? "forbidden" : "notification_preferences_unavailable" },
      { status: code === "42501" ? 403 : 503 },
    );
  }
  return Response.json(data);
}
