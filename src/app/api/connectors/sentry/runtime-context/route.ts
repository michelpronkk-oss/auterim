import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { connectorProviderEntitled } from "@/lib/connectors/entitlements";
import { classifyRuntimeContext, ConnectorError } from "@/lib/connectors/model";
import { readSentryRuntimeContext } from "@/lib/connectors/providers";
import {
  getFreshProviderCredentials,
  loadInstallation,
  serverConnectors,
  setConnectorHealth,
} from "@/lib/connectors/service";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";

const inputSchema = z.object({
  workspaceId: z.string().uuid(),
  impactAssessmentId: z.string().uuid(),
});

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const input = inputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success)
    return Response.json({ error: "invalid_runtime_context_request" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const entitlements = await resolveWorkspaceEntitlementsForMember(
      auth.client,
      input.data.workspaceId,
    );
    if (!connectorProviderEntitled(entitlements, "sentry"))
      return Response.json({ error: "pro_plan_required" }, { status: 402 });
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }
  const { data: assessment, error: assessmentError } = await auth.client
    .from("impact_assessments")
    .select("id,workspace_dependency_id,source_change_classification_id,status,relevant")
    .eq("id", input.data.impactAssessmentId)
    .eq("workspace_id", input.data.workspaceId)
    .maybeSingle();
  if (assessmentError)
    return Response.json({ error: "runtime_context_unavailable" }, { status: 503 });
  if (!assessment || assessment.status !== "assessed" || assessment.relevant !== true)
    return Response.json({ error: "relevant_assessment_required" }, { status: 409 });
  const [{ data: dependency }, { data: classification }] = await Promise.all([
    auth.client
      .from("workspace_dependencies")
      .select("dependency_catalog(name,slug)")
      .eq("id", assessment.workspace_dependency_id)
      .eq("workspace_id", input.data.workspaceId)
      .maybeSingle(),
    auth.client
      .from("source_change_classifications")
      .select("id,classified_at,status")
      .eq("id", assessment.source_change_classification_id)
      .maybeSingle(),
  ]);
  const catalog = dependency?.dependency_catalog as { name?: string; slug?: string } | null;
  if (!catalog?.slug || !classification || classification.status !== "classified")
    return Response.json({ error: "runtime_context_evidence_unavailable" }, { status: 409 });
  const changeTime = Date.parse(classification.classified_at);
  const now = Date.now();
  const windowStart = Number.isFinite(changeTime)
    ? new Date(changeTime).toISOString()
    : new Date(now - 86_400_000).toISOString();
  const windowEnd = new Date(now).toISOString();
  let result: ReturnType<typeof classifyRuntimeContext>;
  const service = serverConnectors();
  try {
    const { data: installationRow, error: installError } = await service
      .from("connector_installations")
      .select(
        "id,workspace_id,provider,external_account_id,account_name,lifecycle_state,health_state,scopes,safe_metadata,connected_at,last_checked_at",
      )
      .eq("workspace_id", input.data.workspaceId)
      .eq("provider", "sentry")
      .maybeSingle();
    if (installError || !installationRow)
      return Response.json({ error: "sentry_not_connected" }, { status: 409 });
    if (
      installationRow.lifecycle_state !== "connected" ||
      installationRow.health_state !== "healthy"
    )
      return Response.json({ error: "sentry_reconnect_required" }, { status: 409 });
    const { data: previousSignal, error: previousSignalError } = await service
      .from("connector_runtime_signals")
      .select("result,evidence_count,safe_issue_ids,window_start,window_end")
      .eq("workspace_id", input.data.workspaceId)
      .eq("installation_id", installationRow.id)
      .eq("impact_assessment_id", input.data.impactAssessmentId)
      .maybeSingle();
    if (previousSignalError)
      return Response.json({ error: "runtime_context_unavailable" }, { status: 503 });
    if (previousSignal)
      return Response.json({
        result: previousSignal.result,
        evidenceCount: previousSignal.evidence_count,
        matchedIssueIds: previousSignal.safe_issue_ids,
        causalConclusion: null,
        correlationWindow: { start: previousSignal.window_start, end: previousSignal.window_end },
        deduplicated: true,
      });
    const installation = await loadInstallation(
      service,
      input.data.workspaceId,
      installationRow.id,
      "sentry",
    );
    const { data: selected, error: resourceError } = await service
      .from("connector_resources")
      .select("external_resource_id,safe_metadata")
      .eq("workspace_id", input.data.workspaceId)
      .eq("installation_id", installation.id)
      .eq("resource_type", "project")
      .eq("selected", true)
      .eq("access_state", "available")
      .limit(5);
    if (resourceError || !selected?.length)
      return Response.json({ error: "sentry_project_required" }, { status: 409 });
    if (!Number.isFinite(changeTime) || changeTime < now - 86_400_000 || changeTime > now) {
      result = { result: "runtime_signal_inconclusive", matchedIssueIds: [], evidenceCount: 0 };
    } else {
      const credentials = await getFreshProviderCredentials(service, installation);
      const organizationSlug =
        typeof installation.safe_metadata.organizationSlug === "string"
          ? installation.safe_metadata.organizationSlug
          : "";
      result = await readSentryRuntimeContext(credentials, {
        organizationSlug,
        projectSlugs: selected
          .map((item) =>
            typeof item.safe_metadata.slug === "string" ? item.safe_metadata.slug : "",
          )
          .filter(Boolean),
        windowStart,
        windowEnd,
        providerIdentifiers: [catalog.slug, catalog.name ?? ""],
      });
    }
    const { error: saveError } = await service.from("connector_runtime_signals").upsert(
      {
        workspace_id: input.data.workspaceId,
        installation_id: installationRow.id,
        impact_assessment_id: input.data.impactAssessmentId,
        result: result.result,
        evidence_count: Math.min(result.evidenceCount, 250),
        safe_issue_ids: result.matchedIssueIds.slice(0, 20),
        window_start: windowStart,
        window_end: windowEnd,
      },
      { onConflict: "installation_id,impact_assessment_id" },
    );
    if (saveError)
      return Response.json({ error: "runtime_context_persistence_failed" }, { status: 503 });
    await service.from("connector_audit_events").insert({
      workspace_id: input.data.workspaceId,
      installation_id: installationRow.id,
      provider: "sentry",
      actor_user_id: auth.user.id,
      event_kind:
        result.result === "runtime_signal_found"
          ? "runtime_signal_found"
          : "runtime_context_checked",
      safe_metadata: { result: result.result, evidenceCount: result.evidenceCount },
    });
    await service
      .from("connector_installations")
      .update({ last_checked_at: new Date().toISOString() })
      .eq("id", installationRow.id)
      .eq("workspace_id", input.data.workspaceId);
    return Response.json({
      ...result,
      causalConclusion: null,
      correlationWindow: { start: windowStart, end: windowEnd },
    });
  } catch (error) {
    if (error instanceof ConnectorError) {
      const lifecycle = error.category === "AUTH_REQUIRED" ? "reauth_required" : "degraded";
      const health =
        error.category === "AUTH_REQUIRED"
          ? "reauth_required"
          : error.category === "PERMISSION_MISSING"
            ? "permission_missing"
            : error.category === "RESOURCE_NOT_FOUND"
              ? "resource_missing"
              : "provider_unavailable";
      try {
        const { data: row } = await service
          .from("connector_installations")
          .select(
            "id,workspace_id,provider,external_account_id,account_name,lifecycle_state,health_state,scopes,safe_metadata,connected_at,last_checked_at",
          )
          .eq("workspace_id", input.data.workspaceId)
          .eq("provider", "sentry")
          .maybeSingle();
        if (row)
          await setConnectorHealth(
            service,
            row,
            lifecycle,
            health,
            error.category === "AUTH_REQUIRED"
              ? "refresh_failed"
              : error.category === "PERMISSION_MISSING"
                ? "permission_lost"
                : undefined,
          );
      } catch {
        // Response intentionally contains only normalized connector errors.
      }
      return Response.json(
        { error: "runtime_context_unavailable", category: error.category },
        { status: error.category === "AUTH_REQUIRED" ? 409 : 503 },
      );
    }
    return Response.json({ error: "runtime_context_unavailable" }, { status: 503 });
  }
}
