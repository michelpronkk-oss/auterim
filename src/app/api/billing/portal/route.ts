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
      .select("dodo_customer_id")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
    if (!data?.dodo_customer_id)
      return Response.json({ error: "billing_customer_missing" }, { status: 409 });
    const session = await createDodoClient().customers.customerPortal.create(data.dodo_customer_id);
    const link = z.string().url().safeParse(session.link);
    if (!link.success || new URL(link.data).protocol !== "https:")
      return Response.json({ error: "billing_portal_unavailable" }, { status: 502 });
    return Response.json({ url: link.data });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_billing_request" }, { status: 400 });
    return Response.json({ error: "billing_portal_unavailable" }, { status: 502 });
  }
}
