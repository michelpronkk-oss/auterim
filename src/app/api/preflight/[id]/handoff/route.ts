import { z } from "zod";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { authenticateOnboardingRequest, parseJsonBody } from "@/lib/onboarding/auth";

const requestSchema = z
  .object({
    workspaceId: z.string().uuid(),
    repositoryId: z.string().uuid(),
    idempotencyKey: z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/),
  })
  .strict();
const safeRequestSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["queued", "dispatched", "running", "prepared", "denied", "failed"]),
});

/** Queue a Business-only policy-checked handoff preparation; no GitHub request is made here. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const preflightId = z.string().uuid().safeParse(id);
  if (!preflightId.success)
    return Response.json({ error: "invalid_preflight_id" }, { status: 400 });

  let input: z.infer<typeof requestSchema>;
  try {
    input = requestSchema.parse(await parseJsonBody(request));
  } catch {
    return Response.json({ error: "invalid_business_handoff_request" }, { status: 400 });
  }

  const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      auth.client,
      input.workspaceId,
    );
    if (entitlements.effectivePlan !== "business" || !entitlements.capabilities.automaticDraftPr) {
      return Response.json({ error: "business_plan_required" }, { status: 402 });
    }
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }

  const { data, error } = await auth.client.rpc("request_business_handoff", {
    p_workspace_id: input.workspaceId,
    p_preflight_run_id: preflightId.data,
    p_repository_id: input.repositoryId,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) {
    if (error.code === "42501")
      return Response.json({ error: "business_handoff_not_eligible" }, { status: 409 });
    if (error.code === "23505")
      return Response.json({ error: "business_handoff_conflict" }, { status: 409 });
    if (error.code === "P0002")
      return Response.json({ error: "preflight_not_found" }, { status: 404 });
    return Response.json({ error: "business_handoff_unavailable" }, { status: 503 });
  }
  const safeRequest = safeRequestSchema.safeParse(data);
  if (!safeRequest.success) {
    return Response.json({ error: "business_handoff_unavailable" }, { status: 503 });
  }
  return Response.json(
    {
      requestId: safeRequest.data.id,
      status: safeRequest.data.status,
      externalPullRequestCreated: false,
    },
    { status: 202 },
  );
}
