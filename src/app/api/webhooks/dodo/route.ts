import { z } from "zod";
import {
  createDodoClient,
  configuredDodoProducts,
  normalizeDodoStatus,
} from "@/lib/billing/server";
import { planForDodoProduct } from "@/lib/billing/plan-catalog";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getEnvironment } from "@/lib/env/schema";
import { readBoundedTextBody } from "@/lib/http/bounded-body";

const MAX_WEBHOOK_BYTES = 256 * 1024;
const eventSchema = z
  .object({
    type: z.string().min(1).max(100),
    timestamp: z.string().datetime({ offset: true }),
    data: z
      .object({
        customer_id: z.string().optional(),
        customer: z.object({ customer_id: z.string() }).optional(),
        subscription_id: z.string().optional(),
        product_id: z.string().optional(),
        status: z.string().optional(),
        previous_billing_date: z.string().datetime({ offset: true }).nullable().optional(),
        next_billing_date: z.string().datetime({ offset: true }).nullable().optional(),
        cancel_at_next_billing_date: z.boolean().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_WEBHOOK_BYTES)
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  const environment = getEnvironment();
  if (!environment.DODO_PAYMENTS_WEBHOOK_KEY)
    return Response.json({ error: "webhook_not_configured" }, { status: 503 });
  const eventId = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (!eventId || !timestamp || !signature)
    return Response.json({ error: "invalid_signature" }, { status: 401 });

  let body: string;
  try {
    body = await readBoundedTextBody(request.body, MAX_WEBHOOK_BYTES);
  } catch (error) {
    return error instanceof Error && error.message === "payload_too_large"
      ? Response.json({ error: "payload_too_large" }, { status: 413 })
      : Response.json({ error: "invalid_payload" }, { status: 400 });
  }

  let verified: unknown;
  try {
    const headers = Object.fromEntries(request.headers.entries());
    verified = createDodoClient().webhooks.unwrap(body, {
      headers,
      key: environment.DODO_PAYMENTS_WEBHOOK_KEY,
    });
  } catch {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }

  const parsed = eventSchema.safeParse(verified);
  if (!parsed.success) return Response.json({ error: "invalid_payload" }, { status: 400 });
  const event = parsed.data;
  const productId = event.data.product_id ?? null;
  const products = configuredDodoProducts();
  const plan = productId ? planForDodoProduct(productId, products) : null;
  let status = normalizeDodoStatus(event.type, event.data.status);
  const cancelAtPeriodEnd = event.data.cancel_at_next_billing_date === true;
  // Dodo includes the scheduled-cancellation flag on subscription events; the paid period remains valid.
  if (event.type === "subscription.cancelled" && cancelAtPeriodEnd && event.data.next_billing_date)
    status = "active";
  const client = createSupabaseServerClient();
  const { data, error } = await client.rpc("process_dodo_subscription_event", {
    p_event_id: eventId,
    p_event_type: event.type,
    p_customer_id: event.data.customer?.customer_id ?? event.data.customer_id ?? null,
    p_subscription_id: event.data.subscription_id ?? null,
    p_product_id: productId,
    p_plan: plan,
    p_status: status,
    p_period_start: event.data.previous_billing_date ?? null,
    p_period_end: event.data.next_billing_date ?? null,
    p_cancel_at_period_end: cancelAtPeriodEnd,
    p_event_at: event.timestamp,
  });
  if (error) return Response.json({ error: "webhook_processing_failed" }, { status: 503 });
  return Response.json({
    status: z.enum(["processed", "duplicate", "ignored", "stale"]).parse(data),
  });
}
