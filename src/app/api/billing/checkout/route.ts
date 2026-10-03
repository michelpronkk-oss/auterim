import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import {
  createDodoClient,
  getWorkspaceRole,
  resolveWorkspaceEntitlementsForMember,
} from "@/lib/billing/server";
import { planProductIds, type PlanSlug } from "@/lib/billing/plan-catalog";
import { getEnvironment } from "@/lib/env/schema";

const inputSchema = z
  .object({ workspaceId: z.string().uuid(), plan: z.enum(["core", "pro", "business"]) })
  .strict();
const subscriptionSchema = z.object({
  dodo_customer_id: z.string().nullable(),
  dodo_subscription_id: z.string().nullable(),
  plan: z.enum(["core", "pro", "business"]).nullable(),
  status: z.string(),
});

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  try {
    const input = inputSchema.parse(await request.json());
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey))
      return Response.json({ error: "idempotency_key_required" }, { status: 400 });
    const role = await getWorkspaceRole(auth.client, input.workspaceId, auth.user.id);
    if (role !== "owner" && role !== "admin")
      return Response.json({ error: "forbidden" }, { status: 403 });
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      auth.client,
      input.workspaceId,
    );
    if (entitlements.nextRequiredBillingAction === "activate_protection")
      return Response.json({ error: "protection_activation_required" }, { status: 409 });

    const environment = getEnvironment();
    const productIds = planProductIds(environment);
    const productId = productIds[input.plan as PlanSlug];
    if (!productId || !environment.DODO_PAYMENTS_API_KEY)
      return Response.json({ error: "billing_not_configured" }, { status: 503 });
    const configuredIds = Object.values(productIds).filter((value): value is string =>
      Boolean(value),
    );
    if (new Set(configuredIds).size !== configuredIds.length)
      return Response.json({ error: "billing_product_mapping_invalid" }, { status: 503 });

    const { data: current, error: currentError } = await auth.client
      .from("workspace_subscriptions")
      .select("dodo_customer_id,dodo_subscription_id,plan,status")
      .eq("workspace_id", input.workspaceId)
      .maybeSingle();
    if (currentError || !current)
      return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
    const subscription = subscriptionSchema.parse(current);
    const dodo = createDodoClient();
    if (
      subscription.dodo_subscription_id &&
      ["active", "past_due", "on_hold"].includes(subscription.status)
    ) {
      if (subscription.plan === input.plan)
        return Response.json({ error: "plan_already_current" }, { status: 409 });
      await dodo.subscriptions.changePlan(
        subscription.dodo_subscription_id,
        {
          product_id: productId,
          quantity: 1,
          // Dodo's plan-change endpoint applies this customer-selected change immediately.
          proration_billing_mode: "difference_immediately",
        },
        { idempotencyKey },
      );
      return Response.json({ status: "plan_change_pending_webhook" }, { status: 202 });
    }

    let customerId = subscription.dodo_customer_id;
    if (!customerId) {
      if (!auth.user.email)
        return Response.json({ error: "verified_email_required" }, { status: 422 });
      const customer = await dodo.customers.create(
        {
          email: auth.user.email,
          name: auth.user.email,
          metadata: { auterim_workspace_id: input.workspaceId },
        },
        { idempotencyKey: `customer:${input.workspaceId}` },
      );
      customerId = customer.customer_id;
      const { error: attachError } = await auth.client.rpc("attach_workspace_dodo_customer", {
        p_workspace_id: input.workspaceId,
        p_customer_id: customerId,
      });
      if (attachError)
        return Response.json({ error: "billing_customer_attach_failed" }, { status: 503 });
    }

    const appUrl = environment.NEXT_PUBLIC_APP_URL;
    const checkout = await dodo.checkoutSessions.create(
      {
        product_cart: [{ product_id: productId, quantity: 1 }],
        customer: { customer_id: customerId },
        metadata: { auterim_workspace_id: input.workspaceId, requested_plan: input.plan },
        return_url: new URL("/app?billing=return", appUrl).toString(),
      },
      { idempotencyKey },
    );
    const checkoutUrl = z.string().url().safeParse(checkout.checkout_url);
    if (!checkoutUrl.success || new URL(checkoutUrl.data).protocol !== "https:") {
      return Response.json({ error: "billing_checkout_unavailable" }, { status: 503 });
    }
    return Response.json({ checkoutUrl: checkoutUrl.data, sessionId: checkout.session_id });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_billing_request" }, { status: 400 });
    return Response.json({ error: "billing_checkout_failed" }, { status: 502 });
  }
}
