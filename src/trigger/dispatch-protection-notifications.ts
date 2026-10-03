import { schedules } from "@trigger.dev/sdk";
import { isIntegrationConfigured, getEnvironment } from "@/lib/env/schema";
import { createResendNotificationProvider, classifyEmailFailure } from "@/lib/notifications/email";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** A bounded dispatcher; persistent claims and retry counts live in Postgres. */
export const dispatchProtectionNotifications = schedules.task({
  id: "dispatch-protection-notifications",
  cron: { pattern: "*/15 * * * *", timezone: "UTC" },
  run: async () => {
    const service = createSupabaseServerClient();
    const { error: deadlineError } = await service.rpc("create_due_deadline_notifications", {
      p_limit: 100,
    });
    if (deadlineError) throw new Error("deadline_notification_dispatch_failed");

    const environment = getEnvironment();
    if (!isIntegrationConfigured("resend", environment)) {
      return { claimed: 0, sent: 0, emailConfigured: false };
    }
    const provider = createResendNotificationProvider();
    let claimedCount = 0;
    let sentCount = 0;
    for (let batch = 0; batch < 2; batch += 1) {
      const { data, error } = await service.rpc("claim_notification_deliveries", { p_limit: 50 });
      if (error) throw new Error("notification_delivery_claim_failed");
      const deliveries = (data ?? []) as Array<{
        delivery_id: string;
        workspace_id: string;
        recipient_email: string;
        title: string;
        summary: string;
        priority: "critical" | "high" | "normal";
        lease_until: string;
      }>;
      claimedCount += deliveries.length;
      for (const delivery of deliveries) {
        let result: { messageId: string };
        try {
          result = await provider.send({
            deliveryId: delivery.delivery_id,
            recipient: delivery.recipient_email,
            title: delivery.title,
            summary: delivery.summary,
            priority: delivery.priority,
          });
        } catch (error) {
          const failure = classifyEmailFailure(error);
          await service.rpc("fail_notification_delivery", {
            p_delivery_id: delivery.delivery_id,
            p_lease_until: delivery.lease_until,
            p_error_category: failure.category,
            p_transient: failure.transient,
          });
          continue;
        }
        const { error: completeError } = await service.rpc("complete_notification_delivery", {
          p_delivery_id: delivery.delivery_id,
          p_lease_until: delivery.lease_until,
          p_provider_message_id: result.messageId,
        });
        // A provider-accepted email whose DB acknowledgement failed is left leased. A later
        // retry uses the same delivery key/payload, allowing provider idempotency to reconcile it.
        if (completeError) throw new Error("notification_delivery_complete_failed");
        sentCount += 1;
      }
      if (deliveries.length < 50) break;
    }
    return { claimed: claimedCount, sent: sentCount, emailConfigured: true };
  },
});
