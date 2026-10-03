import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";

const cursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,400}$/)
  .optional();

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      at: string;
      id: string;
    };
    if (!/^\d{4}-\d\d-\d\dT/.test(parsed.at) || !z.string().uuid().safeParse(parsed.id).success)
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const search = new URL(request.url).searchParams;
  const workspaceId = z.string().uuid().safeParse(search.get("workspaceId"));
  const cursorValue = cursorSchema.safeParse(search.get("cursor") ?? undefined);
  const limitValue = z.coerce
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .safeParse(search.get("limit") ?? 20);
  if (!workspaceId.success || !cursorValue.success || !limitValue.success)
    return Response.json({ error: "invalid_notification_query" }, { status: 400 });
  const cursor = decodeCursor(cursorValue.data);
  if (cursorValue.data && !cursor)
    return Response.json({ error: "invalid_cursor" }, { status: 400 });
  if (!(await getWorkspaceRole(auth.client, workspaceId.data, auth.user.id)))
    return Response.json({ error: "forbidden" }, { status: 403 });
  const { data: preferences, error: preferenceError } = await auth.client
    .from("workspace_notification_preferences")
    .select("in_app_enabled")
    .eq("workspace_id", workspaceId.data)
    .maybeSingle();
  if (preferenceError)
    return Response.json({ error: "notifications_unavailable" }, { status: 503 });
  if (preferences && !preferences.in_app_enabled)
    return Response.json({ items: [], unreadCount: 0, nextCursor: null });
  let query = auth.client
    .from("notifications")
    .select(
      "id,notification_type,priority,title,summary,related_dependency_id,related_impact_assessment_id,related_preflight_run_id,created_at,read_at,resolved_at",
    )
    .eq("workspace_id", workspaceId.data)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limitValue.data + 1);
  if (search.get("unread") === "true") query = query.is("read_at", null);
  const priority = search.get("priority");
  if (priority && ["critical", "high", "normal"].includes(priority))
    query = query.eq("priority", priority);
  if (cursor)
    query = query.or(
      `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const [{ data, error }, { count, error: countError }] = await Promise.all([
    query,
    auth.client
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId.data)
      .is("read_at", null),
  ]);
  if (error || countError)
    return Response.json({ error: "notifications_unavailable" }, { status: 503 });
  const rows = data ?? [];
  const items = rows.slice(0, limitValue.data);
  const last = items.at(-1);
  return Response.json({
    items,
    unreadCount: count ?? 0,
    nextCursor:
      rows.length > limitValue.data && last
        ? Buffer.from(JSON.stringify({ at: last.created_at, id: last.id })).toString("base64url")
        : null,
  });
}

export async function PATCH(request: Request) {
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
      notificationId: z.string().uuid().optional(),
      markAllRead: z.boolean().optional(),
    })
    .refine((value) => Boolean(value.notificationId) !== Boolean(value.markAllRead))
    .safeParse(body);
  if (!input.success)
    return Response.json({ error: "invalid_notification_update" }, { status: 400 });
  try {
    const result = input.data.markAllRead
      ? await auth.client.rpc("mark_all_notifications_read", {
          p_workspace_id: input.data.workspaceId,
        })
      : await auth.client.rpc("mark_notification_read", {
          p_workspace_id: input.data.workspaceId,
          p_notification_id: input.data.notificationId,
        });
    if (result.error) {
      const code = (result.error as { code?: string }).code;
      return Response.json(
        {
          error:
            code === "42501"
              ? "forbidden"
              : code === "P0002"
                ? "not_found"
                : "notification_update_failed",
        },
        { status: code === "42501" ? 403 : code === "P0002" ? 404 : 503 },
      );
    }
    return Response.json({ success: true, updated: input.data.markAllRead ? result.data : 1 });
  } catch {
    return Response.json({ error: "notification_update_failed" }, { status: 503 });
  }
}
