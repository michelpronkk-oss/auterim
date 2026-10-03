import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConnectorError } from "./model";
import { sendSlackNotification } from "./providers";
import { getFreshProviderCredentials, loadInstallation, setConnectorHealth } from "./service";

type ClaimedDelivery = {
  delivery_id: string;
  workspace_id: string;
  installation_id: string;
  resource_id: string;
  notification_id: string;
  title: string;
  summary: string;
  priority: "critical" | "high" | "normal";
  lease_until: string;
};

function messageText(title: string, summary: string, appUrl: string) {
  const safe = (value: string) =>
    value
      .replace(/[\u0000-\u001f]/g, " ")
      .replace(/@/g, "(at)")
      .slice(0, 600);
  return `Auterim detected a verified risk\n${safe(title)}\n${safe(summary)}\nReview in Auterim: ${appUrl}`.slice(
    0,
    1400,
  );
}

function failureDetails(error: unknown) {
  if (error instanceof ConnectorError)
    return {
      category: error.category.toLowerCase(),
      transient: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      error,
    };
  return { category: "provider_error", transient: true, retryAfterSeconds: undefined, error: null };
}

export async function dispatchSlackDeliveryBatch(service: SupabaseClient, appUrl: string) {
  let claimedCount = 0;
  let deliveredCount = 0;
  for (let batch = 0; batch < 2; batch += 1) {
    const { data, error } = await service.rpc("claim_slack_notification_deliveries", {
      p_limit: 10,
    });
    if (error) throw new Error("slack_delivery_claim_failed");
    const deliveries = (data ?? []) as ClaimedDelivery[];
    claimedCount += deliveries.length;
    for (const delivery of deliveries) {
      let installation;
      try {
        installation = await loadInstallation(
          service,
          delivery.workspace_id,
          delivery.installation_id,
          "slack",
        );
        const { data: resource, error: resourceError } = await service
          .from("connector_resources")
          .select("id,external_resource_id,selected,access_state")
          .eq("id", delivery.resource_id)
          .eq("workspace_id", delivery.workspace_id)
          .eq("installation_id", installation.id)
          .eq("selected", true)
          .eq("access_state", "available")
          .maybeSingle();
        if (resourceError || !resource)
          throw new ConnectorError(
            "RESOURCE_NOT_FOUND",
            false,
            "slack",
            "Selected Slack channel is unavailable.",
          );
        const credentials = await getFreshProviderCredentials(service, installation);
        const result = await sendSlackNotification(credentials, {
          channelId: resource.external_resource_id,
          deliveryId: delivery.delivery_id,
          text: messageText(delivery.title, delivery.summary, appUrl),
        });
        const { error: completeError } = await service.rpc("complete_notification_delivery", {
          p_delivery_id: delivery.delivery_id,
          p_lease_until: delivery.lease_until,
          p_provider_message_id: result.providerMessageId,
        });
        if (completeError) throw new Error("slack_delivery_complete_failed");
        await setConnectorHealth(service, installation, "connected", "healthy");
        await service.from("connector_audit_events").insert({
          workspace_id: delivery.workspace_id,
          installation_id: installation.id,
          provider: "slack",
          event_kind: "slack_notification_delivered",
          safe_metadata: { notificationType: "high_signal" },
        });
        deliveredCount += 1;
      } catch (error) {
        const failure = failureDetails(error);
        if (installation && failure.error instanceof ConnectorError) {
          if (failure.error.category === "AUTH_REQUIRED")
            await setConnectorHealth(
              service,
              installation,
              "reauth_required",
              "reauth_required",
              "refresh_failed",
            );
          else if (failure.error.category === "PERMISSION_MISSING")
            await setConnectorHealth(
              service,
              installation,
              "degraded",
              "permission_missing",
              "permission_lost",
            );
          else if (failure.error.category === "RESOURCE_NOT_FOUND") {
            await service
              .from("connector_resources")
              .update({
                selected: false,
                selected_at: null,
                access_state: "missing",
                updated_at: new Date().toISOString(),
              })
              .eq("id", delivery.resource_id)
              .eq("workspace_id", delivery.workspace_id)
              .eq("installation_id", installation.id);
            await setConnectorHealth(service, installation, "degraded", "resource_missing");
          } else if (
            failure.error.category === "PROVIDER_UNAVAILABLE" ||
            failure.error.category === "RATE_LIMITED"
          )
            await setConnectorHealth(service, installation, "degraded", "provider_unavailable");
        }
        const { error: failureError } = await service.rpc("fail_notification_delivery", {
          p_delivery_id: delivery.delivery_id,
          p_lease_until: delivery.lease_until,
          p_error_category: failure.category.replace(/[^a-z_]/g, "_").slice(0, 80),
          p_transient: failure.transient,
          p_retry_after_seconds: failure.retryAfterSeconds,
        });
        if (failureError) throw new Error("slack_delivery_failure_persist_failed");
      }
    }
    if (deliveries.length < 10) break;
  }
  return { claimed: claimedCount, delivered: deliveredCount };
}
