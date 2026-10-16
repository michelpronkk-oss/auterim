import "server-only";
import { z } from "zod";
import { authenticateOnboardingRequest } from "@/lib/onboarding/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const querySchema = z.object({
  workspaceId: z.string().uuid(),
  productId: z.string().uuid().optional(),
  repositoryId: z.string().uuid().optional(),
  sourceChangeId: z.string().uuid().optional(),
  commitSha: z.string().regex(/^[a-f0-9]{40,64}$/).optional(),
  asOf: z.string().datetime({ offset: true }).optional(),
}).strict().refine(
  (input) => Boolean(input.productId || input.repositoryId || input.sourceChangeId),
  "At least one graph scope is required.",
);

const pageSize = 500;
const maxBuilds = 100;
const maxRows = 50_000;
type Query = { range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };

function emptyBlastRadius() {
  return {
    potentiallyAffectedProductCount: 0,
    repositoryCount: 0,
    codePathCount: 0,
    codeReferenceCount: 0,
    inferredEdgeCount: 0,
    confidenceClassCounts: { exact: 0, structural: 0, heuristic: 0 },
    coverageStateCounts: { complete: 0, partial: 0, unsupported: 0, failed: 0 },
    changeCriticality: [] as Array<{ sourceChangeId: string; severityHint: string; classifierDecisionStatus: string }>,
    productionExposure: "unknown" as const,
  };
}

async function readBounded(query: Query, label: string, maximum: number): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < maximum; offset += pageSize) {
    const { data, error } = await query.range(offset, Math.min(offset + pageSize - 1, maximum - 1));
    if (error || !Array.isArray(data)) throw new Error(`${label}_read_failed`);
    rows.push(...data as Array<Record<string, unknown>>);
    if (data.length < pageSize) return rows;
  }
  throw new Error(`${label}_bound_exceeded`);
}

/**
 * Internal, workspace-scoped read model. The bearer token is verified here;
 * caller-supplied user IDs are never trusted for privileged reads. It
 * deliberately exposes no deployment-derived truth.
 */
export async function queryImpactGraph(input: z.input<typeof querySchema>, request: Request) {
  const scope = querySchema.parse(input);
  const auth = await authenticateOnboardingRequest(request);
  if (!auth.ok) throw new Error("impact_graph_authentication_required");
  const asOf = scope.asOf ?? new Date().toISOString();
  const client = createSupabaseServerClient();
  const { data: membership, error: membershipError } = await auth.client.from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", scope.workspaceId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (membershipError) throw new Error("impact_graph_workspace_access_unavailable");
  if (!membership) throw new Error("impact_graph_forbidden");
  let buildQuery = client.from("impact_graph_builds")
    .select("id,workspace_id,product_id,repository_id,source_change_id,route_intent_id,intelligence_decision_id,analysis_run_id,commit_sha,analyzer_version,analysis_profile,graph_builder_version,policy_version,review_disposition,review_reason,coverage_state,coverage_truth,assessment_state,production_exposure_state,production_evidence_id,status,build_generation,completed_at")
    .eq("workspace_id", scope.workspaceId).eq("status", "completed").lte("completed_at", asOf)
    .order("build_generation", { ascending: false });
  if (scope.productId) buildQuery = buildQuery.eq("product_id", scope.productId);
  if (scope.repositoryId) buildQuery = buildQuery.eq("repository_id", scope.repositoryId);
  if (scope.sourceChangeId) buildQuery = buildQuery.eq("source_change_id", scope.sourceChangeId);
  if (scope.commitSha) buildQuery = buildQuery.eq("commit_sha", scope.commitSha);
  const builds = await readBounded(buildQuery, "impact_graph_builds", maxBuilds);
  if (builds.length === 0) return { asOf, blastRadius: emptyBlastRadius(), builds: [] };

  const buildIds = builds.map((build) => String(build.id));
  const edgeRows: Array<Record<string, unknown>> = [];
  const nodeRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < buildIds.length; offset += 50) {
    const ids = buildIds.slice(offset, offset + 50);
    const [edges, nodes] = await Promise.all([
      readBounded(client.from("impact_graph_edges")
        .select("id,graph_build_id,workspace_id,analysis_run_id,source_change_id,product_id,repository_id,commit_sha,from_node_id,to_node_id,edge_type,edge_kind,evidence_type,code_relation_id,code_reference_id,evidence_chain,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column,classifier_decision_id,policy_version,graph_builder_version,confidence_class,edge_fingerprint,valid_from,valid_until")
        .in("graph_build_id", ids).order("id"), "impact_graph_edges", maxRows),
      readBounded(client.from("impact_graph_nodes")
        .select("id,graph_build_id,workspace_id,node_type,identity_key,normalized_label,repository_id,commit_sha,path,analysis_run_id,code_entity_id,code_reference_id")
        .in("graph_build_id", ids).order("id"), "impact_graph_nodes", maxRows),
    ]);
    edgeRows.push(...edges);
    nodeRows.push(...nodes);
    if (edgeRows.length > maxRows || nodeRows.length > maxRows) throw new Error("impact_graph_fact_bound_exceeded");
  }

  const activeEdges = edgeRows.filter((edge) =>
    typeof edge.valid_from === "string" && Date.parse(edge.valid_from) <= Date.parse(asOf) &&
    (edge.valid_until === null || (typeof edge.valid_until === "string" && Date.parse(edge.valid_until) > Date.parse(asOf))));
  const activeBuildIds = new Set(activeEdges.map((edge) => String(edge.graph_build_id)));
  const activeNodes = nodeRows.filter((node) => activeBuildIds.has(String(node.graph_build_id)));
  const sourceChangeIds = [...new Set(builds.map((build) => String(build.source_change_id)))];
  const classifications = await readBounded(client.from("source_change_classifications")
    .select("id,change_id,severity_hint,decision_status,classified_at")
    .in("change_id", sourceChangeIds).eq("status", "classified")
    .order("classified_at", { ascending: false }), "impact_graph_classifications", 500);
  const classificationByChange = new Map<string, Record<string, unknown>>();
  for (const row of classifications) {
    const changeId = String(row.change_id);
    if (!classificationByChange.has(changeId)) classificationByChange.set(changeId, row);
  }
  const resultBuilds: Array<Record<string, unknown> & {
    productionExposureState: "unknown";
    changeClassification: Record<string, unknown> | null;
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
  }> = builds.map((build) => ({
      ...build,
      productionExposureState: "unknown" as const,
      changeClassification: classificationByChange.get(String(build.source_change_id)) ?? null,
      nodes: activeNodes.filter((node) => node.graph_build_id === build.id),
      edges: activeEdges.filter((edge) => edge.graph_build_id === build.id),
    }));
  const latestBuildByScope = new Map<string, (typeof resultBuilds)[number]>();
  for (const build of resultBuilds) {
    const key = [build.workspace_id, build.product_id, build.repository_id, build.source_change_id].join(":");
    if (!latestBuildByScope.has(key)) latestBuildByScope.set(key, build);
  }
  const currentBuilds = [...latestBuildByScope.values()];
  const currentBuildIds = new Set(currentBuilds.map((build) => String(build.id)));
  const inferredEdges = activeEdges.filter((edge) => edge.edge_kind === "inferred" && currentBuildIds.has(String(edge.graph_build_id)));
  const potentiallyAffectedBuilds = currentBuilds.filter((build) =>
    build.edges.some((edge) => edge.edge_type === "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE"));
  const evidenceEdges = potentiallyAffectedBuilds.flatMap((build) => build.edges)
    .filter((edge) => edge.edge_kind === "inferred");
  const blastRadius = {
    potentiallyAffectedProductCount: new Set(potentiallyAffectedBuilds.map((build) => String(build.product_id))).size,
    repositoryCount: new Set(potentiallyAffectedBuilds.map((build) => String(build.repository_id))).size,
    codePathCount: new Set(evidenceEdges.map((edge) => edge.evidence_path).filter((path): path is string => typeof path === "string")).size,
    codeReferenceCount: new Set(evidenceEdges.map((edge) => edge.code_reference_id).filter((id): id is string => typeof id === "string")).size,
    inferredEdgeCount: inferredEdges.length,
    confidenceClassCounts: Object.fromEntries(["exact", "structural", "heuristic"].map((confidence) => [
      confidence, inferredEdges.filter((edge) => edge.confidence_class === confidence).length,
    ])),
    coverageStateCounts: Object.fromEntries(["complete", "partial", "unsupported", "failed"].map((coverage) => [
      coverage, currentBuilds.filter((build) => build.coverage_state === coverage).length,
    ])),
    changeCriticality: [...new Map(currentBuilds.map((build) => [String(build.source_change_id), {
      sourceChangeId: build.source_change_id,
      severityHint: build.changeClassification?.severity_hint ?? "unknown",
      classifierDecisionStatus: build.changeClassification?.decision_status ?? "unknown",
    }])).values()],
    productionExposure: "unknown" as const,
  };
  return { asOf, blastRadius, builds: resultBuilds };
}
