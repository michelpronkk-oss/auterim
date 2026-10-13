import { z } from "zod";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { serverConnectors } from "@/lib/connectors/service";
import {
  BaselinePreflightError,
  executeBaselinePreflight,
} from "@/lib/preflight/baseline-executor";

const requestSchema = z.object({ workspaceId: z.string().uuid(), repositoryId: z.string().uuid() });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const productId = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  if (!productId.success) return Response.json({ error: "invalid_product" }, { status: 400 });
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const body = requestSchema.safeParse(await request.json().catch(() => null));
  if (!body.success)
    return Response.json({ error: "invalid_baseline_preflight_request" }, { status: 400 });
  const { workspaceId, repositoryId } = body.data;

  let role: string | null;
  try {
    role = await getWorkspaceRole(auth.client, workspaceId, auth.user.id);
  } catch {
    return Response.json({ error: "workspace_access_unavailable" }, { status: 503 });
  }
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, workspaceId);
    if (
      !entitlements.capabilities.automaticPreflight ||
      entitlements.usage.preflightRuns >= entitlements.limits.preflightRuns
    )
      return Response.json({ error: "preflight_not_entitled" }, { status: 402 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }

  try {
    const result = await executeBaselinePreflight({
      service: serverConnectors(),
      actorUserId: auth.user.id,
      workspaceId,
      productId: productId.data,
      repositoryId,
    });
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const code =
      error instanceof BaselinePreflightError ? error.code : "repository_verification_unavailable";
    const status =
      code === "not_found"
        ? 404
        : code === "forbidden"
          ? 403
          : code === "baseline_preflight_ineligible" || code === "repository_unavailable"
            ? 409
            : 503;
    return Response.json({ error: code }, { status });
  }
}
