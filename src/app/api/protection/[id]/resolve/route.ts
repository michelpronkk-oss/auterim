import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";

const bodySchema = z.object({
  workspaceId: z.string().uuid(),
  resolutionKind: z.enum([
    "reviewed",
    "mitigated_externally",
    "accepted_risk",
    "no_longer_applicable",
  ]),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const { id } = await context.params;
  const impactAssessmentId = z.string().uuid().safeParse(id);
  if (!impactAssessmentId.success) {
    return Response.json({ error: "invalid_impact_assessment_id" }, { status: 400 });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "invalid_request_body" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: "invalid_risk_resolution" }, { status: 400 });

  const { data: result, error } = await auth.client.rpc("resolve_customer_risk", {
    p_workspace_id: parsed.data.workspaceId,
    p_impact_assessment_id: impactAssessmentId.data,
    p_resolution_kind: parsed.data.resolutionKind,
  });
  if (error) {
    if (error.code === "42501") return Response.json({ error: "forbidden" }, { status: 403 });
    if (error.code === "P0002")
      return Response.json({ error: "active_risk_not_found" }, { status: 404 });
    if (error.code === "40001")
      return Response.json({ error: "risk_already_resolved" }, { status: 409 });
    if (error.code === "22023")
      return Response.json({ error: "invalid_risk_resolution" }, { status: 400 });
    return Response.json({ error: "risk_resolution_unavailable" }, { status: 503 });
  }
  return Response.json({ resolution: result });
}
