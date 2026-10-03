import { createHash } from "node:crypto";
import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { connectorProviderEntitled } from "@/lib/connectors/entitlements";
import { ConnectorError } from "@/lib/connectors/model";
import { createLinearIssue } from "@/lib/connectors/providers";
import {
  getFreshProviderCredentials,
  loadInstallation,
  serverConnectors,
} from "@/lib/connectors/service";
import { redactRepositoryPath, redactSecretShapedContent } from "@/lib/preflight/preflight";
import { getEnvironment } from "@/lib/env/schema";
import { getWorkspaceRole, resolveWorkspaceEntitlementsForMember } from "@/lib/billing/server";

const inputSchema = z.object({
  workspaceId: z.string().uuid(),
  findingId: z.string().uuid(),
  teamResourceId: z.string().uuid(),
});

export async function POST(request: Request) {
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) return auth.response;
  const input = inputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return Response.json({ error: "invalid_linear_action" }, { status: 400 });
  const role = await getWorkspaceRole(auth.client, input.data.workspaceId, auth.user.id).catch(
    () => null,
  );
  if (!role) return Response.json({ error: "forbidden" }, { status: 403 });
  let entitlements;
  try {
    entitlements = await resolveWorkspaceEntitlementsForMember(auth.client, input.data.workspaceId);
  } catch {
    return Response.json({ error: "billing_state_unavailable" }, { status: 503 });
  }
  if (!connectorProviderEntitled(entitlements, "linear"))
    return Response.json({ error: "pro_plan_required" }, { status: 402 });

  const [{ data: finding, error: findingError }, { data: resource, error: resourceError }] =
    await Promise.all([
      auth.client
        .from("preflight_findings")
        .select(
          "id,workspace_id,preflight_run_id,repository_id,commit_sha,file_path,finding_type,affected_entity,verification,explanation",
        )
        .eq("id", input.data.findingId)
        .eq("workspace_id", input.data.workspaceId)
        .maybeSingle(),
      auth.client
        .from("connector_resources")
        .select(
          "id,workspace_id,installation_id,external_resource_id,resource_type,selected,access_state",
        )
        .eq("id", input.data.teamResourceId)
        .eq("workspace_id", input.data.workspaceId)
        .eq("resource_type", "team")
        .eq("selected", true)
        .eq("access_state", "available")
        .maybeSingle(),
    ]);
  if (findingError || resourceError)
    return Response.json({ error: "linear_action_unavailable" }, { status: 503 });
  if (!finding || !resource)
    return Response.json({ error: "action_source_or_team_not_found" }, { status: 404 });
  const [{ data: run }, { data: repository }, { data: assessment }] = await Promise.all([
    auth.client
      .from("preflight_runs")
      .select("id,workspace_id,status,verified_impact,impact_assessment_id,recommended_remediation")
      .eq("id", finding.preflight_run_id)
      .eq("workspace_id", input.data.workspaceId)
      .maybeSingle(),
    auth.client
      .from("repositories")
      .select("owner,name")
      .eq("id", finding.repository_id)
      .eq("workspace_id", input.data.workspaceId)
      .maybeSingle(),
    auth.client
      .from("preflight_runs")
      .select("impact_assessment_id")
      .eq("id", finding.preflight_run_id)
      .eq("workspace_id", input.data.workspaceId)
      .maybeSingle(),
  ]);
  if (
    !run ||
    !repository ||
    (run.status !== "completed" && run.status !== "partial") ||
    !["verified", "likely"].includes(run.verified_impact ?? "") ||
    finding.verification !== "verified"
  )
    return Response.json({ error: "verified_action_required" }, { status: 409 });
  const impactId = assessment?.impact_assessment_id;
  const { data: impact } = impactId
    ? await auth.client
        .from("impact_assessments")
        .select("status,relevant,impact_summary,why_it_matters,recommended_action")
        .eq("id", impactId)
        .eq("workspace_id", input.data.workspaceId)
        .maybeSingle()
    : { data: null };
  const repositoryPath = redactRepositoryPath(finding.file_path);
  const safePath = /(?:^|\/)(?:\.env(?:\.|$)|secrets?|credentials?)(?:\/|$)/i.test(repositoryPath)
    ? "[sensitive path omitted]"
    : repositoryPath;
  const dependencyNameResult = impactId
    ? await auth.client
        .from("impact_assessments")
        .select("workspace_dependency_id")
        .eq("id", impactId)
        .eq("workspace_id", input.data.workspaceId)
        .maybeSingle()
    : { data: null };
  const dependencyResult = dependencyNameResult.data?.workspace_dependency_id
    ? await auth.client
        .from("workspace_dependencies")
        .select("dependency_catalog(name,slug)")
        .eq("id", dependencyNameResult.data.workspace_dependency_id)
        .eq("workspace_id", input.data.workspaceId)
        .maybeSingle()
    : { data: null };
  const dependency = dependencyResult.data?.dependency_catalog as {
    name?: string;
    slug?: string;
  } | null;
  const provider = dependency?.name ?? "protected provider";
  const headline = `Auterim verified risk: ${provider} ${finding.affected_entity}`.slice(0, 200);
  const appUrl = new URL("/app", getEnvironment().NEXT_PUBLIC_APP_URL).toString();
  const description = [
    "## Auterim verified risk",
    `Provider: ${provider}`,
    `Detected reference: ${finding.finding_type} — ${finding.affected_entity}`,
    `Impact: ${impact?.status === "assessed" && impact.relevant ? (impact.impact_summary ?? impact.why_it_matters ?? "Review this verified exposure in Auterim.") : "A repository reference was verified against the protected dependency."}`,
    `Repository reference: ${repository.owner}/${repository.name}, ${safePath}, commit ${finding.commit_sha.slice(0, 12)}`,
    `Grounded remediation: ${run.recommended_remediation ?? impact?.recommended_action ?? "Review the provider change and update the verified dependency reference."}`,
    `Review in Auterim: ${appUrl}`,
    "",
    "This issue was created by an explicit Auterim action. No source file contents were attached.",
  ]
    .map((line) => redactSecretShapedContent(line))
    .join("\n")
    .slice(0, 7900);
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        finding: finding.id,
        team: resource.external_resource_id,
        headline,
        description,
      }),
    )
    .digest("hex");
  const service = serverConnectors();
  const { data: installation, error: installError } = await service
    .from("connector_installations")
    .select(
      "id,workspace_id,provider,external_account_id,account_name,lifecycle_state,health_state,scopes,safe_metadata,connected_at,last_checked_at",
    )
    .eq("id", resource.installation_id)
    .eq("workspace_id", input.data.workspaceId)
    .eq("provider", "linear")
    .maybeSingle();
  if (installError || !installation)
    return Response.json({ error: "linear_connection_unavailable" }, { status: 503 });

  const { data: existing } = await service
    .from("connector_action_mappings")
    .select("id,status,external_object_id,external_object_key,external_url,updated_at")
    .eq("workspace_id", input.data.workspaceId)
    .eq("action_kind", "preflight_finding")
    .eq("action_id", finding.id)
    .maybeSingle();
  if (existing?.status === "created")
    return Response.json({
      created: true,
      deduplicated: true,
      issue: {
        id: existing.external_object_id,
        identifier: existing.external_object_key,
        url: existing.external_url,
      },
    });
  if (existing?.status === "creating" && Date.parse(existing.updated_at) < Date.now() - 120_000) {
    await service
      .from("connector_action_mappings")
      .update({ status: "unknown_result", updated_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("workspace_id", input.data.workspaceId)
      .eq("status", "creating");
    return Response.json({ error: "linear_action_result_pending_review" }, { status: 409 });
  }
  if (existing && existing.status !== "failed")
    return Response.json({ error: "linear_action_result_pending_review" }, { status: 409 });
  let mappingId = existing?.id as string | undefined;
  if (mappingId) {
    const { data: retried, error } = await service
      .from("connector_action_mappings")
      .update({
        status: "creating",
        request_fingerprint: requestFingerprint,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mappingId)
      .eq("workspace_id", input.data.workspaceId)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();
    if (error || !retried)
      return Response.json({ error: "linear_action_result_pending_review" }, { status: 409 });
  } else {
    const { data: created, error } = await service
      .from("connector_action_mappings")
      .insert({
        workspace_id: input.data.workspaceId,
        installation_id: installation.id,
        action_kind: "preflight_finding",
        action_id: finding.id,
        status: "creating",
        request_fingerprint: requestFingerprint,
        created_by: auth.user.id,
      })
      .select("id")
      .maybeSingle();
    if (error || !created) {
      const { data: raced } = await service
        .from("connector_action_mappings")
        .select("status,external_object_id,external_object_key,external_url")
        .eq("workspace_id", input.data.workspaceId)
        .eq("action_kind", "preflight_finding")
        .eq("action_id", finding.id)
        .maybeSingle();
      if (raced?.status === "created")
        return Response.json({
          created: true,
          deduplicated: true,
          issue: {
            id: raced.external_object_id,
            identifier: raced.external_object_key,
            url: raced.external_url,
          },
        });
      return Response.json({ error: "linear_action_result_pending_review" }, { status: 409 });
    }
    mappingId = created.id;
  }
  try {
    const connectorInstallation = await loadInstallation(
      service,
      input.data.workspaceId,
      installation.id,
      "linear",
    );
    const credentials = await getFreshProviderCredentials(service, connectorInstallation);
    const issue = await createLinearIssue(credentials, {
      teamId: resource.external_resource_id,
      title: headline,
      description,
    });
    const { error: saveError } = await service
      .from("connector_action_mappings")
      .update({
        status: "created",
        external_object_id: issue.id,
        external_object_key: issue.identifier,
        external_url: issue.url,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mappingId)
      .eq("workspace_id", input.data.workspaceId)
      .eq("status", "creating");
    if (saveError)
      return Response.json({ error: "linear_action_result_pending_review" }, { status: 202 });
    await service.from("connector_audit_events").insert({
      workspace_id: input.data.workspaceId,
      installation_id: installation.id,
      provider: "linear",
      actor_user_id: auth.user.id,
      event_kind: "linear_issue_created",
      safe_metadata: { actionKind: "preflight_finding" },
    });
    return Response.json(
      {
        created: true,
        deduplicated: false,
        issue: { id: issue.id, identifier: issue.identifier, url: issue.url },
      },
      { status: 201 },
    );
  } catch (error) {
    const ambiguous = error instanceof ConnectorError && error.retryable;
    await service
      .from("connector_action_mappings")
      .update({
        status: ambiguous ? "unknown_result" : "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", mappingId)
      .eq("workspace_id", input.data.workspaceId)
      .eq("status", "creating");
    return Response.json(
      { error: ambiguous ? "linear_action_result_pending_review" : "linear_issue_creation_failed" },
      { status: ambiguous ? 409 : 503 },
    );
  }
}
