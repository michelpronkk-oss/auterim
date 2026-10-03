import { getEnvironment, isIntegrationConfigured } from "@/lib/env/schema";
import { readBoundedBody, verifyGitHubWebhookSignature } from "@/lib/preflight/github-webhook";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const environment = getEnvironment();
  if (
    !isIntegrationConfigured("githubApp", environment) ||
    !environment.GITHUB_APP_WEBHOOK_SECRET
  ) {
    return Response.json({ error: "github_app_not_configured" }, { status: 503 });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > 1_000_000)
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  let raw: Buffer;
  try {
    raw = await readBoundedBody(request.body, 1_000_000);
  } catch {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!verifyGitHubWebhookSignature(raw, signature, environment.GITHUB_APP_WEBHOOK_SECRET)) {
    return Response.json({ error: "invalid_signature" }, { status: 401 });
  }
  let payload: {
    action?: string;
    installation?: { id?: number };
    repositories_added?: Array<{
      id: number;
      name: string;
      owner: { login: string };
      default_branch: string;
      private: boolean;
      archived: boolean;
    }>;
    repositories_removed?: Array<{ id: number }>;
  };
  try {
    payload = JSON.parse(raw.toString("utf8")) as typeof payload;
  } catch {
    return Response.json({ error: "invalid_payload" }, { status: 400 });
  }
  const event = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery");
  if (!deliveryId || !/^[0-9a-f-]{36}$/i.test(deliveryId))
    return Response.json({ error: "invalid_delivery_id" }, { status: 400 });
  if (
    (event !== "installation" && event !== "installation_repositories") ||
    !Number.isSafeInteger(payload.installation?.id)
  )
    return Response.json({ received: true, ignored: true });
  const installationId = payload.installation!.id!;
  const service = createSupabaseServerClient();
  const { data: previousDelivery, error: previousDeliveryError } = await service
    .from("github_webhook_deliveries")
    .select("delivery_id")
    .eq("delivery_id", deliveryId)
    .maybeSingle();
  if (previousDeliveryError)
    return Response.json({ error: "delivery_lookup_failed" }, { status: 503 });
  if (previousDelivery) return Response.json({ received: true, replayed: true });
  const now = new Date().toISOString();
  if (event === "installation_repositories") {
    const { data: connections, error } = await service
      .from("repository_connections")
      .select("id,workspace_id")
      .eq("provider", "github")
      .eq("installation_id", installationId)
      .eq("status", "connected");
    if (error) return Response.json({ error: "connection_lookup_failed" }, { status: 503 });
    for (const connection of connections ?? []) {
      const additions = (payload.repositories_added ?? []).slice(0, 100).map((repository) => ({
        workspace_id: connection.workspace_id,
        connection_id: connection.id,
        external_id: repository.id,
        owner: repository.owner.login,
        name: repository.name,
        default_branch: repository.default_branch,
        private: repository.private,
        archived: repository.archived,
        status: repository.archived ? "archived" : "available",
        last_synced_at: now,
      }));
      if (additions.length) {
        const { error: addError } = await service
          .from("repositories")
          .upsert(additions, { onConflict: "workspace_id,external_id" });
        if (addError) return Response.json({ error: "repository_sync_failed" }, { status: 503 });
      }
      const removedIds = (payload.repositories_removed ?? []).slice(0, 100).map((item) => item.id);
      if (removedIds.length) {
        const { data: removed, error: removeError } = await service
          .from("repositories")
          .update({ status: "access_revoked", selected_for_protection: false })
          .eq("workspace_id", connection.workspace_id)
          .eq("connection_id", connection.id)
          .in("external_id", removedIds)
          .select("id");
        if (removeError)
          return Response.json({ error: "repository_update_failed" }, { status: 503 });
        const repositoryIds = (removed ?? []).map((item) => item.id as string);
        if (repositoryIds.length) {
          const { error: accessError } = await service
            .from("workspace_repository_access")
            .delete()
            .in("repository_id", repositoryIds);
          if (accessError)
            return Response.json({ error: "repository_access_cleanup_failed" }, { status: 503 });
        }
      }
    }
    const { error: deliveryError } = await service
      .from("github_webhook_deliveries")
      .insert({ delivery_id: deliveryId, event_kind: event, action: payload.action ?? null });
    if (deliveryError && deliveryError.code !== "23505")
      return Response.json({ error: "delivery_record_failed" }, { status: 503 });
    return Response.json({ received: true });
  }
  if (payload.action === "deleted" || payload.action === "suspend") {
    const { error } = await service
      .from("repository_connections")
      .update({ status: "revoked", revoked_at: now })
      .eq("provider", "github")
      .eq("installation_id", installationId);
    if (error) return Response.json({ error: "connection_update_failed" }, { status: 503 });
    const { data: connections, error: connectionListError } = await service
      .from("repository_connections")
      .select("id,workspace_id")
      .eq("provider", "github")
      .eq("installation_id", installationId);
    if (connectionListError)
      return Response.json({ error: "connection_lookup_failed" }, { status: 503 });
    for (const connection of connections ?? []) {
      const { data: revokedRepositories, error: revokeRepositoriesError } = await service
        .from("repositories")
        .update({ status: "access_revoked", selected_for_protection: false })
        .eq("workspace_id", connection.workspace_id)
        .eq("connection_id", connection.id)
        .select("id");
      if (revokeRepositoriesError)
        return Response.json({ error: "repository_update_failed" }, { status: 503 });
      const repositoryIds = (revokedRepositories ?? []).map((row) => row.id as string);
      if (repositoryIds.length) {
        const { error: accessError } = await service
          .from("workspace_repository_access")
          .delete()
          .eq("workspace_id", connection.workspace_id)
          .in("repository_id", repositoryIds);
        if (accessError)
          return Response.json({ error: "repository_access_cleanup_failed" }, { status: 503 });
      }
    }
  } else if (payload.action === "unsuspend") {
    const { error } = await service
      .from("repository_connections")
      .update({ status: "connected", revoked_at: null })
      .eq("provider", "github")
      .eq("installation_id", installationId);
    if (error) return Response.json({ error: "connection_update_failed" }, { status: 503 });
  }
  const { error: deliveryError } = await service
    .from("github_webhook_deliveries")
    .insert({ delivery_id: deliveryId, event_kind: event, action: payload.action ?? null });
  if (deliveryError && deliveryError.code !== "23505")
    return Response.json({ error: "delivery_record_failed" }, { status: 503 });
  return Response.json({ received: true });
}
