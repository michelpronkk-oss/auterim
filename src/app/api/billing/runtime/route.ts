import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { getWorkspaceRole } from "@/lib/billing/server";
import { planProductIds } from "@/lib/billing/plan-catalog";
import { getEnvironment } from "@/lib/env/schema";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;

  const parsedWorkspaceId = z
    .string()
    .uuid()
    .safeParse(new URL(request.url).searchParams.get("workspaceId"));
  if (!parsedWorkspaceId.success)
    return Response.json({ error: "invalid_workspace_id" }, { status: 400 });

  let role: string | null;
  try {
    role = await getWorkspaceRole(auth.client, parsedWorkspaceId.data, auth.user.id);
  } catch {
    return Response.json({ error: "billing_runtime_unavailable" }, { status: 503 });
  }
  if (role !== "owner" && role !== "admin")
    return Response.json({ error: "forbidden" }, { status: 403 });

  try {
    const environment = getEnvironment();
    const products = planProductIds(environment);
    const configuredProductIds = Object.values(products).filter((productId): productId is string =>
      Boolean(productId),
    );
    const checkoutConfigured = Boolean(
      environment.DODO_PAYMENTS_API_KEY &&
      products.pro &&
      new Set(configuredProductIds).size === configuredProductIds.length,
    );

    return Response.json(
      {
        mode: environment.DODO_PAYMENTS_ENVIRONMENT,
        checkoutConfigured,
      },
      { headers: PRIVATE_NO_STORE },
    );
  } catch {
    return Response.json({ error: "billing_runtime_unavailable" }, { status: 503 });
  }
}
