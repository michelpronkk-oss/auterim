import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { createDodoClient, getWorkspaceRole } from "@/lib/billing/server";

const inputSchema = z.object({ workspaceId: z.string().uuid() }).strict();

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const { workspaceId } = inputSchema.parse(await request.json());
    const role = await getWorkspaceRole(auth.client, workspaceId, auth.user.id);
    if (role !== "owner" && role !== "admin")
      return Response.json({ error: "forbidden" }, { status: 403 });
    const { data, error } = await auth.client
      .from("workspace_subscriptions")
      .select("dodo_subscription_id,status")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
    if (!data?.dodo_subscription_id || data.status !== "active")
      return Response.json({ error: "active_subscription_required" }, { status: 409 });
    await createDodoClient().subscriptions.update(data.dodo_subscription_id, {
      cancel_at_next_billing_date: true,
    });
    return Response.json({ status: "cancellation_pending_webhook" }, { status: 202 });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_billing_request" }, { status: 400 });
    return Response.json({ error: "billing_cancellation_failed" }, { status: 502 });
  }
}
