import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { buildImpactGraphFacts, IMPACT_GRAPH_BUILDER_VERSION, type GraphEdge, type GraphNode } from "@/lib/impact-graph/builder";

const claimSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed"), graphBuildId: z.string().uuid(), claimToken: z.string().uuid(),
    workspaceId: z.string().uuid(), productId: z.string().uuid(), repositoryId: z.string().uuid(),
    sourceChangeId: z.string().uuid(), workspaceDependencyId: z.string().uuid(), decisionId: z.string().uuid(), analysisRunId: z.string().uuid(),
    commitSha: z.string().regex(/^[a-f0-9]{40,64}$/), coverageState: z.enum(["complete", "partial", "unsupported", "failed"]),
    graphBuilderVersion: z.string(), coverageTruth: z.string(), policyVersion: z.string(), route: z.string(), routeTarget: z.string() }),
  z.object({ status: z.enum(["completed", "busy"]), replayed: z.boolean(), graphBuildId: z.string().uuid() }),
]);

const pageSize = 800;
const maxRows = 50_000;
type RangeQuery = { range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> };
async function readAll<T>(query: RangeQuery, label: string): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await query.range(offset, offset + pageSize - 1);
    if (error || !Array.isArray(data)) throw new Error(`${label}_read_failed`);
    rows.push(...(data as T[]));
    if (data.length < pageSize) return rows;
  }
  throw new Error("impact_graph_fact_bound_exceeded");
}

async function upsertBatched<T extends Record<string, unknown>>(
  client: ReturnType<typeof createSupabaseServerClient>, table: string, rows: T[], conflict: string, selectColumns: string, label: string,
): Promise<Array<{ id: string; identity_key?: string; edge_fingerprint?: string }>> {
  const returned: Array<{ id: string; identity_key?: string; edge_fingerprint?: string }> = [];
  for (let offset = 0; offset < rows.length; offset += 300) {
    const { data, error } = await client.from(table).upsert(rows.slice(offset, offset + 300) as never, { onConflict: conflict })
      .select(selectColumns);
    if (error || !Array.isArray(data)) {
      const safeCode = error?.code && /^[A-Z0-9]{4,8}$/.test(error.code) ? error.code : "unknown";
      throw new Error(`${label}_persist_failed:${safeCode}`);
    }
    returned.push(...(data as unknown as Array<{ id: string; identity_key?: string; edge_fingerprint?: string }>));
  }
  if (returned.length !== rows.length) throw new Error(`${label}_persistence_integrity_failed`);
  return returned;
}

export async function buildImpactGraph(input: {
  routeIntentId: string; analysisRunId: string; productId: string; repositoryId: string;
  graphBuilderVersion?: string;
}) {
  const graphBuilderVersion = input.graphBuilderVersion ?? IMPACT_GRAPH_BUILDER_VERSION;
  const client = createSupabaseServerClient();
  const { data: claimData, error: claimError } = await client.rpc("claim_impact_graph_build", {
    p_route_intent_id: input.routeIntentId,
    p_analysis_run_id: input.analysisRunId,
    p_product_id: input.productId,
    p_repository_id: input.repositoryId,
    p_graph_builder_version: graphBuilderVersion,
  });
  if (claimError) throw new Error("impact_graph_claim_failed");
  const claim = claimSchema.parse(claimData);
  if (claim.status === "completed") return { graphBuildId: claim.graphBuildId, status: "completed", replayed: true };
  if (claim.status !== "claimed") throw new Error("impact_graph_claim_busy");

  try {
  const { data: run, error: runError } = await client.from("code_analysis_runs")
    .select("id,workspace_id,repository_id,commit_sha,analyzer_version,analysis_profile,coverage_state")
    .eq("id", claim.analysisRunId).eq("workspace_id", claim.workspaceId)
    .eq("repository_id", claim.repositoryId).eq("commit_sha", claim.commitSha).eq("status", "completed").maybeSingle();
  if (runError || !run) throw new Error("impact_graph_analysis_unavailable");

  const { data: change, error: changeError } = await client.from("source_changes").select("id,source_id")
    .eq("id", claim.sourceChangeId).maybeSingle();
  if (changeError || !change) throw new Error("impact_graph_source_change_unavailable");
  const { data: source, error: sourceError } = await client.from("source_catalog").select("id,dependency_id")
    .eq("id", change.source_id).maybeSingle();
  if (sourceError || !source) throw new Error("impact_graph_source_unavailable");
  const { data: dependency, error: dependencyError } = await client.from("dependency_catalog")
    .select("id,slug,name,website_url,enabled").eq("id", source.dependency_id).maybeSingle();
  if (dependencyError || !dependency?.enabled) throw new Error("impact_graph_dependency_unavailable");
  const { data: classification, error: classificationError } = await client.from("source_change_classifications")
    .select("id,affected_entities,decision_status").eq("change_id", claim.sourceChangeId).eq("status", "classified")
    .order("classified_at", { ascending: false }).limit(1).maybeSingle();
  if (classificationError) throw new Error("impact_graph_classification_unavailable");
  const changedEntities = classification?.decision_status === "classified" && Array.isArray(classification.affected_entities)
    ? classification.affected_entities.filter((value): value is string => typeof value === "string" && value.length <= 120).slice(0, 5)
    : [];
  const { data: mapping, error: mappingError } = await client.from("workspace_product_repositories")
    .select("id,workspace_id,protected_product_id,repository_id,status,provenance")
    .eq("workspace_id", claim.workspaceId).eq("protected_product_id", claim.productId)
    .eq("repository_id", claim.repositoryId).eq("status", "active").maybeSingle();
  if (mappingError || !mapping) throw new Error("impact_graph_product_mapping_unavailable");
  const { data: dependencyMapping, error: dependencyMappingError } = await client.from("workspace_dependencies")
    .select("id,workspace_id,protected_product_id,dependency_id,monitoring_enabled")
    .eq("id", claim.workspaceDependencyId).eq("workspace_id", claim.workspaceId)
    .eq("protected_product_id", claim.productId).eq("dependency_id", dependency.id)
    .eq("monitoring_enabled", true).maybeSingle();
  if (dependencyMappingError || !dependencyMapping) throw new Error("impact_graph_dependency_mapping_unavailable");

  const [entities, relations, references] = await Promise.all([
    readAll<{ id: string; entity_type: string; name: string; path: string; language: string; confidence_class: "exact" | "structural" | "heuristic" }>(
      client.from("code_entities").select("id,entity_type,name,path,language,confidence_class").eq("analysis_run_id", claim.analysisRunId).order("id"), "impact_graph_entities"),
    readAll<{ id: string; from_entity_id: string; to_entity_id: string; relation_type: string; confidence_class: "exact" | "structural" | "heuristic";
      evidence_path: string; evidence_start_line: number; evidence_start_column: number; evidence_end_line: number; evidence_end_column: number; extractor_type: string }>(
      client.from("code_relations").select("id,from_entity_id,to_entity_id,relation_type,confidence_class,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column,extractor_type").eq("analysis_run_id", claim.analysisRunId).order("id"), "impact_graph_relations"),
    readAll<{ id: string; entity_id: string; reference_type: string; normalized_value: string; path: string; start_line: number; start_column: number | null;
      end_line: number; end_column: number | null; confidence_class: "exact" | "structural" | "heuristic" }>(
      client.from("code_external_references").select("id,entity_id,reference_type,normalized_value,path,start_line,start_column,end_line,end_column,confidence_class").eq("analysis_run_id", claim.analysisRunId).order("id"), "impact_graph_references"),
  ]);
  const facts = buildImpactGraphFacts({
    buildId: claim.graphBuildId, workspaceId: claim.workspaceId, productId: claim.productId, repositoryId: claim.repositoryId,
    sourceChangeId: claim.sourceChangeId, decisionId: claim.decisionId, analysisRunId: claim.analysisRunId,
    sourceClassificationId: typeof classification?.id === "string" ? classification.id : null,
    changedEntities,
    commitSha: claim.commitSha, policyVersion: claim.policyVersion, route: claim.route, routeTarget: claim.routeTarget,
    graphBuilderVersion: claim.graphBuilderVersion,
    dependencyId: dependency.id, dependencySlug: dependency.slug, dependencyName: dependency.name,
    dependencyWebsite: dependency.website_url, mappingId: mapping.id, dependencyMappingId: dependencyMapping.id, entities, relations, references,
    coverageTruth: claim.coverageTruth,
  });

  const nodeRows = facts.nodes.map((node: GraphNode) => ({ graph_build_id: claim.graphBuildId, workspace_id: claim.workspaceId, ...node }));
  const savedNodes = await upsertBatched(client, "impact_graph_nodes", nodeRows,
    "graph_build_id,node_type,identity_key", "id,identity_key", "impact_graph_nodes");
  const nodeByIdentity = new Map(savedNodes.map((row) => [row.identity_key, row.id]));
  if (facts.nodes.some((node) => !nodeByIdentity.has(node.identity_key)))
    throw new Error("impact_graph_node_identity_resolution_failed");
  const edgeRows = facts.edges.map((edge: GraphEdge) => ({
    graph_build_id: claim.graphBuildId, workspace_id: claim.workspaceId, analysis_run_id: claim.analysisRunId,
    source_change_id: claim.sourceChangeId, product_id: claim.productId, repository_id: claim.repositoryId, commit_sha: claim.commitSha,
    ...edge,
    from_node_id: nodeByIdentity.get(edge.from_node_id),
    to_node_id: nodeByIdentity.get(edge.to_node_id),
  }));
  if (edgeRows.some((edge) => !edge.from_node_id || !edge.to_node_id))
    throw new Error("impact_graph_edge_node_resolution_failed");
  const savedEdges = await upsertBatched(client, "impact_graph_edges", edgeRows,
    "graph_build_id,edge_type,edge_fingerprint", "id,edge_fingerprint", "impact_graph_edges");
  const { data: completed, error: completeError } = await client.rpc("complete_impact_graph_build", {
    p_graph_build_id: claim.graphBuildId, p_claim_token: claim.claimToken,
    p_expected_nodes: savedNodes.length, p_expected_edges: savedEdges.length,
    p_assessment_state: facts.assessmentState,
  });
  if (completeError || completed !== true) throw new Error("impact_graph_completion_integrity_failed");
  return {
    graphBuildId: claim.graphBuildId,
    status: "completed",
    replayed: false,
    commitSha: claim.commitSha,
    coverageTruth: claim.coverageTruth,
    assessmentState: facts.assessmentState,
    nodeCount: savedNodes.length,
    edgeCount: savedEdges.length,
    observedEdges: facts.edges.filter((edge) => edge.edge_kind === "observed").length,
    inferredEdges: facts.edges.filter((edge) => edge.edge_kind === "inferred").length,
  };
  } catch (error) {
    try {
      await client.rpc("release_impact_graph_build", {
        p_graph_build_id: claim.graphBuildId,
        p_claim_token: claim.claimToken,
        p_failure_category: "graph_build_failed",
      });
    } catch {
      // The lease remains as the bounded recovery path if the release RPC is unavailable.
    }
    throw error;
  }
}
