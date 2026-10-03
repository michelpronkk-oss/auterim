import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const workspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!workspaceId.success) return Response.json({ error: "invalid_workspace" }, { status: 400 });
  if (!(await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id)))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { data, error } = await auth.client
    .from("workspace_notification_preferences")
    .select(
      "critical_changes,important_changes,informational,monthly_protection_report,in_app_enabled,email_enabled,slack_enabled",
    )
    .eq("workspace_id", workspaceId.data)
    .maybeSingle();
  if (error)
    return Response.json({ error: "notification_preferences_unavailable" }, { status: 503 });
  return Response.json({
    preferences: data ?? {
      critical_changes: "instant",
      important_changes: "daily_digest",
      informational: "off",
      monthly_protection_report: false,
      in_app_enabled: true,
      email_enabled: false,
      slack_enabled: false,
    },
  });
}

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
      slackEnabled: z.boolean().optional(),
    })
    .safeParse(body);
  if (!input.success)
    return Response.json({ error: "invalid_notification_preferences" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id);
  if (!role) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  if (input.data.slackEnabled !== undefined && role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });
  if (input.data.slackEnabled !== undefined) {
    const service = createSupabaseServerClient();
    const { data, error } = await service.rpc("set_notification_preferences_with_slack", {
      p_workspace_id: input.data.workspaceId,
      p_actor_user_id: auth.user.id,
      p_in_app_enabled: input.data.inAppEnabled,
      p_email_enabled: input.data.emailEnabled,
      p_slack_enabled: input.data.slackEnabled,
    });
    if (error) {
      const code = (error as { code?: string }).code;
      return Response.json(
        {
          error:
            code === "42501"
              ? "forbidden"
              : code === "P0002"
                ? "slack_destination_required"
                : "notification_preferences_unavailable",
        },
        { status: code === "42501" ? 403 : code === "P0002" ? 409 : 503 },
      );
    }
    return Response.json(data);
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
