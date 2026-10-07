import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  latestDependencyScan,
  latestTerminalPreflightRuns,
} from "@/lib/protection/read-model-helpers";

const PAGE_SIZE = 25;
const MAX_DAYS = 366;
type Cursor = { at: string; id: string };

function parseCursor(value: string | null): Cursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
    if (!/^\d{4}-\d\d-\d\dT/.test(decoded.at) || !/^[0-9a-f-]{36}$/i.test(decoded.id)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function encodeCursor(at: string, id: string) {
  return Buffer.from(JSON.stringify({ at, id })).toString("base64url");
}

function periodStart(days: number) {
  const safeDays = Number.isInteger(days) ? Math.min(Math.max(days, 1), MAX_DAYS) : 7;
  return new Date(Date.now() - safeDays * 86_400_000).toISOString();
}

export async function getProtectionSummary(client: SupabaseClient, workspaceId: string, days = 7) {
  const start = periodStart(days);
  const end = new Date().toISOString();
  const { data, error } = await client.rpc("get_protection_summary", {
    p_workspace_id: workspaceId,
    p_period_start: start,
    p_period_end: end,
  });
  if (error) throw new Error("protection_summary_unavailable");
  return data as Record<string, number | string>;
}

export async function getDependenciesOverview(
  client: SupabaseClient,
  workspaceId: string,
  cursorValue?: string | null,
) {
  const cursor = parseCursor(cursorValue ?? null);
  if (cursorValue && !cursor) throw new Error("invalid_cursor");
  let query = client
    .from("workspace_dependencies")
    .select(
      "id,dependency_id,origin,monitoring_enabled,created_at,dependency_catalog(name,slug,category),dependency_context(criticality,production_critical,used_for)",
      { count: "exact" },
    )
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE * 4 + 1);
  if (cursor)
    query = query.or(
      `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const { data, error, count } = await query;
  if (error) throw new Error("dependencies_overview_unavailable");
  const allItems = data ?? [];
  const items = allItems.slice(0, PAGE_SIZE);
  const dependencyIds = items.map((item) => item.dependency_id);
  const workspaceDependencyIds = items.map((item) => item.id);
  const [sources, impacts, dependencyAccess] = await Promise.all([
    dependencyIds.length
      ? client
          .from("source_catalog")
          .select("id,dependency_id,source_type,enabled")
          .in("dependency_id", dependencyIds)
          .eq("enabled", true)
      : Promise.resolve({ data: [], error: null }),
    workspaceDependencyIds.length
      ? client
          .from("impact_assessments")
          .select(
            "id,workspace_dependency_id,relevant,severity,status,assessed_at,source_change_classification_id",
          )
          .eq("workspace_id", workspaceId)
          .in("workspace_dependency_id", workspaceDependencyIds)
          .eq("status", "assessed")
          .order("assessed_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    workspaceDependencyIds.length
      ? client
          .from("workspace_repository_access")
          .select("workspace_dependency_id,repository_id")
          .eq("workspace_id", workspaceId)
          .in("workspace_dependency_id", workspaceDependencyIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (sources.error || impacts.error || dependencyAccess.error)
    throw new Error("dependencies_overview_unavailable");
  const accessibleRepositoryIds = (dependencyAccess.data ?? []).map((entry) => entry.repository_id);
  const repositories = accessibleRepositoryIds.length
    ? await client
        .from("repositories")
        .select("id,status,selected_for_protection")
        .eq("workspace_id", workspaceId)
        .in("id", accessibleRepositoryIds)
    : { data: [], error: null };
  if (repositories.error) throw new Error("dependencies_overview_unavailable");
  const sourceRows = sources.data ?? [];
  const sourceIds = sourceRows.map((source) => source.id);
  const [snapshots, queue, scanRuns] = await Promise.all([
    sourceIds.length
      ? client.from("source_snapshots").select("id,source_id,created_at").in("source_id", sourceIds)
      : Promise.resolve({ data: [], error: null }),
    sourceIds.length
      ? client.from("baseline_scan_queue").select("source_id,status").in("source_id", sourceIds)
      : Promise.resolve({ data: [], error: null }),
    sourceIds.length
      ? client.rpc("get_dependency_source_scan_states", {
          p_workspace_id: workspaceId,
          p_source_ids: sourceIds,
        })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (snapshots.error || queue.error || scanRuns.error)
    throw new Error("dependencies_overview_unavailable");
  const itemsWithState = items.map((dependency) => {
    const covered = sourceRows.filter(
      (source) => source.dependency_id === dependency.dependency_id,
    );
    const coveredIds = new Set(covered.map((source) => source.id));
    const latestImpact = (impacts.data ?? []).find(
      (impact) => impact.workspace_dependency_id === dependency.id,
    );
    const lastChecked = latestDependencyScan(scanRuns.data ?? [], coveredIds);
    const hasBaseline = covered.some((source) =>
      (snapshots.data ?? []).some((snapshot) => snapshot.source_id === source.id),
    );
    const hasPending = (queue.data ?? []).some(
      (row) => coveredIds.has(row.source_id) && row.status !== "complete",
    );
    const linkedRepositoryIds = new Set(
      (dependencyAccess.data ?? [])
        .filter((entry) => entry.workspace_dependency_id === dependency.id)
        .map((entry) => entry.repository_id),
    );
    const brokenRepoAccess = (repositories.data ?? []).some(
      (repository) =>
        linkedRepositoryIds.has(repository.id) && repository.status === "access_revoked",
    );
    const failedScan = lastChecked?.status === "failed";
    const state = !dependency.monitoring_enabled
      ? "unsupported"
      : brokenRepoAccess || failedScan
        ? "access_problem"
        : !covered.length
          ? "coverage_pending"
          : !hasBaseline && hasPending
            ? "baseline_pending"
            : latestImpact?.relevant
              ? "attention_required"
              : hasBaseline && lastChecked
                ? "protected_and_quiet"
                : "incomplete_coverage";
    const rawContext = dependency.dependency_context;
    const context = Array.isArray(rawContext) ? rawContext[0] : rawContext;
    const provider = Array.isArray(dependency.dependency_catalog)
      ? dependency.dependency_catalog[0]
      : dependency.dependency_catalog;
    return {
      id: dependency.id,
      dependencyId: dependency.dependency_id,
      provider,
      origin: dependency.origin,
      protected: dependency.monitoring_enabled,
      criticality: context?.criticality ?? "normal",
      productionCritical: context?.production_critical ?? false,
      usedFor: context?.used_for ?? [],
      authoritativeSources: covered.length,
      sourcesWithBaseline: covered.filter((source) =>
        (snapshots.data ?? []).some((snapshot) => snapshot.source_id === source.id),
      ).length,
      latestMaterialChange: latestImpact
        ? {
            severity: latestImpact.severity,
            relevant: latestImpact.relevant,
            assessedAt: latestImpact.assessed_at,
          }
        : null,
      lastCheckedAt: lastChecked?.finished_at ?? null,
      protectionState: state,
    };
  });
  return {
    items: itemsWithState,
    nextCursor:
      allItems.length > PAGE_SIZE ? encodeCursor(items.at(-1)!.created_at, items.at(-1)!.id) : null,
    total: count ?? items.length,
  };
}

export async function getChangesOverview(
  client: SupabaseClient,
  workspaceId: string,
  options: {
    cursor?: string | null;
    relevantOnly?: boolean;
    verifiedOnly?: boolean;
    unresolvedOnly?: boolean;
  } = {},
) {
  const cursor = parseCursor(options.cursor ?? null);
  if (options.cursor && !cursor) throw new Error("invalid_cursor");
  let query = client
    .from("impact_assessments")
    .select(
      "id,workspace_dependency_id,source_change_classification_id,relevant,severity,impact_summary,why_it_matters,recommended_action,action_required,confidence,assessed_at,created_at,status,workspace_dependencies!inner(dependency_id,monitoring_enabled,dependency_catalog(name,category),dependency_context(criticality,production_critical))",
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "assessed")
    .order("assessed_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE * 4 + 1);
  if (options.relevantOnly) query = query.eq("relevant", true);
  if (cursor)
    query = query.or(
      `assessed_at.lt.${cursor.at},and(assessed_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const { data, error } = await query;
  if (error) throw new Error("changes_overview_unavailable");
  const rows = data ?? [];
  const classificationIds = rows.map((row) => row.source_change_classification_id);
  const [runs, classifications, activation] = await Promise.all([
    rows.length
      ? client
          .from("preflight_runs")
          .select(
            "id,impact_assessment_id,status,verified_impact,deadline,announced_at,effective_at,completed_at,created_at",
          )
          .eq("workspace_id", workspaceId)
          .in(
            "impact_assessment_id",
            rows.map((row) => row.id),
          )
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    classificationIds.length
      ? client
          .from("source_change_classifications")
          .select(
            "id,change_id,material,category,summary,confidence,classified_at,created_at,status",
          )
          .in("id", classificationIds)
      : Promise.resolve({ data: [], error: null }),
    client
      .from("workspace_onboarding")
      .select("activated_at")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
  ]);
  if (runs.error || classifications.error || activation.error)
    throw new Error("changes_overview_unavailable");
  const classificationRows = classifications.data ?? [];
  const changeIds = [...new Set(classificationRows.map((item) => item.change_id))];
  const [allCurrentClassifications, changes] = await Promise.all([
    changeIds.length
      ? client
          .from("source_change_classifications")
          .select("id,change_id,created_at,status")
          .in("change_id", changeIds)
          .eq("status", "classified")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    changeIds.length
      ? client.from("source_changes").select("id,source_id,created_at").in("id", changeIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (allCurrentClassifications.error || changes.error)
    throw new Error("changes_overview_unavailable");
  const currentClassificationIds = new Set<string>();
  for (const classification of allCurrentClassifications.data ?? []) {
    if (!currentClassificationIds.has(classification.change_id))
      currentClassificationIds.add(classification.id);
  }
  const changeById = new Map((changes.data ?? []).map((change) => [change.id, change]));
  const sourceIds = [...new Set((changes.data ?? []).map((change) => change.source_id))];
  const { data: sources, error: sourceError } = sourceIds.length
    ? await client.from("source_catalog").select("id,name,source_type,url").in("id", sourceIds)
    : { data: [], error: null };
  if (sourceError) throw new Error("changes_overview_unavailable");
  const sourceById = new Map((sources ?? []).map((source) => [source.id, source]));
  const latestByDependencyChange = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const classification = classificationRows.find(
      (item) => item.id === row.source_change_classification_id,
    );
    const rawDependency = row.workspace_dependencies;
    const dependency = Array.isArray(rawDependency) ? rawDependency[0] : rawDependency;
    const change = classification ? changeById.get(classification.change_id) : undefined;
    if (
      !classification ||
      !change ||
      !dependency?.monitoring_enabled ||
      !currentClassificationIds.has(classification.id)
    )
      continue;
    if (activation.data?.activated_at && change.created_at < activation.data.activated_at) continue;
    const key = `${row.workspace_dependency_id}:${classification.change_id}`;
    if (!latestByDependencyChange.has(key)) latestByDependencyChange.set(key, row);
  }
  const deduped = [...latestByDependencyChange.values()];
  const resolutionResult = deduped.length
    ? await client
        .from("customer_risk_resolutions")
        .select("impact_assessment_id,resolution_kind,resolved_at,resolved_by")
        .eq("workspace_id", workspaceId)
        .in(
          "impact_assessment_id",
          deduped.map((row) => row.id),
        )
    : { data: [], error: null };
  if (resolutionResult.error) throw new Error("changes_overview_unavailable");
  const resolutions = new Map(
    (resolutionResult.data ?? []).map((resolution) => [
      resolution.impact_assessment_id,
      resolution,
    ]),
  );
  const runRows = runs.data ?? [];
  const latestTerminalRunByAssessment = latestTerminalPreflightRuns(runRows);
  const verifiedAssessmentIds = new Set(
    [...latestTerminalRunByAssessment.values()]
      .filter((run) => run.verified_impact === "verified")
      .map((run) => run.impact_assessment_id),
  );
  const filtered = deduped.filter(
    (row) =>
      (!options.verifiedOnly || verifiedAssessmentIds.has(row.id)) &&
      (!options.unresolvedOnly || (row.relevant && !resolutions.has(row.id))),
  );
  const visible = filtered.slice(0, PAGE_SIZE);
  return {
    items: visible.map((row) => {
      const classification = classificationRows.find(
        (item) => item.id === row.source_change_classification_id,
      );
      const preflight = latestTerminalRunByAssessment.get(row.id);
      const sourceChange = classification ? changeById.get(classification.change_id) : undefined;
      return {
        id: row.id,
        dependency: row.workspace_dependencies,
        source: sourceChange ? (sourceById.get(sourceChange.source_id) ?? null) : null,
        change: classification
          ? {
              category: classification.category,
              summary: classification.summary,
              material: classification.material,
              confidence: classification.confidence,
              classifiedAt: classification.classified_at,
              detectedAt: sourceChange?.created_at ?? null,
            }
          : null,
        customerImpact: {
          relevant: row.relevant,
          severity: row.severity,
          summary: row.impact_summary,
          whyItMatters: row.why_it_matters,
          recommendedAction: row.recommended_action,
          actionRequired: row.action_required,
          confidence: row.confidence,
          resolution: resolutions.get(row.id)
            ? {
                kind: resolutions.get(row.id)!.resolution_kind,
                resolvedAt: resolutions.get(row.id)!.resolved_at,
                resolvedBy: resolutions.get(row.id)!.resolved_by,
              }
            : null,
        },
        preflight: preflight
          ? {
              id: preflight.id,
              status: preflight.status,
              verifiedImpact: preflight.verified_impact,
              announcedAt: preflight.announced_at,
              effectiveAt: preflight.effective_at,
              deadline: preflight.deadline,
              completedAt: preflight.completed_at,
            }
          : null,
        assessedAt: row.assessed_at,
      };
    }),
    nextCursor:
      visible.length === PAGE_SIZE
        ? encodeCursor(visible.at(-1)!.assessed_at, visible.at(-1)!.id)
        : rows.length > PAGE_SIZE * 4
          ? encodeCursor(rows[PAGE_SIZE * 4 - 1]!.assessed_at, rows[PAGE_SIZE * 4 - 1]!.id)
          : null,
  };
}

export async function getActionsOverview(
  client: SupabaseClient,
  workspaceId: string,
  preflightAllowed = true,
) {
  const [changes, connections] = await Promise.all([
    getChangesOverview(client, workspaceId, { relevantOnly: true, unresolvedOnly: true }),
    client
      .from("repository_connections")
      .select("id,status,account_login,updated_at")
      .eq("workspace_id", workspaceId)
      .in("status", ["revoked", "error"])
      .limit(PAGE_SIZE),
  ]);
  if (connections.error) throw new Error("actions_overview_unavailable");
  const actions = [
    ...changes.items.flatMap((change) => {
      const items = [];
      if (change.customerImpact.actionRequired)
        items.push({
          type: "review_impact",
          id: `impact:${change.id}`,
          priority:
            change.customerImpact.severity === "critical" ||
            change.customerImpact.severity === "high"
              ? "high"
              : "normal",
          relatedImpactAssessmentId: change.id,
          recommendedAction: change.customerImpact.recommendedAction,
          createdAt: change.assessedAt,
        });
      if (
        change.preflight?.verifiedImpact === "verified" ||
        change.preflight?.verifiedImpact === "likely"
      )
        items.push({
          type:
            change.preflight.verifiedImpact === "verified"
              ? "review_verified_risk"
              : "review_likely_risk",
          id: `preflight:${change.preflight.id}`,
          priority: change.preflight.verifiedImpact === "verified" ? "high" : "normal",
          eligibility: preflightAllowed ? "eligible" : "blocked",
          blockedReason: preflightAllowed ? null : "plan_upgrade_required",
          entitlementRequirement: "pro",
          relatedPreflightRunId: change.preflight.id,
          relatedImpactAssessmentId: change.id,
          createdAt: change.preflight.completedAt,
        });
      return items;
    }),
    ...(connections.data ?? []).map((connection) => ({
      type: "reconnect_github",
      id: `repository:${connection.id}`,
      priority: "high",
      relatedRepositoryConnectionId: connection.id,
      createdAt: connection.updated_at,
    })),
  ];
  return {
    items: actions.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, PAGE_SIZE),
  };
}

export async function getUpcomingDeadlines(client: SupabaseClient, workspaceId: string) {
  const { data: runs, error } = await client.rpc("get_upcoming_protection_deadlines", {
    p_workspace_id: workspaceId,
    p_limit: PAGE_SIZE,
  });
  if (error) throw new Error("upcoming_deadlines_unavailable");
  const rows = (runs ?? []) as {
    id: string;
    impact_assessment_id: string;
    deadline: string;
    days_remaining: number;
    status: string;
  }[];
  const { data: impacts, error: impactError } = rows.length
    ? await client
        .from("impact_assessments")
        .select("id,workspace_dependency_id,relevant,severity")
        .eq("workspace_id", workspaceId)
        .eq("status", "assessed")
        .eq("relevant", true)
        .in(
          "id",
          rows.map((run) => run.impact_assessment_id),
        )
    : { data: [], error: null };
  if (impactError) throw new Error("upcoming_deadlines_unavailable");
  const relevantImpacts = impacts ?? [];
  const dependencyIds = [
    ...new Set(relevantImpacts.map((impact) => impact.workspace_dependency_id)),
  ];
  const { data: dependencies, error: dependencyError } = dependencyIds.length
    ? await client
        .from("workspace_dependencies")
        .select("id,dependency_catalog(name,category)")
        .eq("workspace_id", workspaceId)
        .in("id", dependencyIds)
    : { data: [], error: null };
  if (dependencyError) throw new Error("upcoming_deadlines_unavailable");
  const impactById = new Map(relevantImpacts.map((impact) => [impact.id, impact]));
  const dependencyById = new Map(
    (dependencies ?? []).map((dependency) => [dependency.id, dependency]),
  );
  return rows
    .filter((run) => impactById.has(run.impact_assessment_id))
    .map((run) => ({
      id: run.id,
      deadline: run.deadline,
      daysRemaining: run.days_remaining,
      dependency:
        dependencyById.get(impactById.get(run.impact_assessment_id)!.workspace_dependency_id)
          ?.dependency_catalog ?? null,
      severity: impactById.get(run.impact_assessment_id)!.severity,
      preflightStatus: run.status,
    }));
}
