import "server-only";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import {
  createPreflightFingerprint,
  inspectRepositories,
  isRetryableProviderFailure,
  parseExplicitChangeDates,
  PREFLIGHT_VERSION,
  MAX_REPOSITORIES,
  type PreflightChange,
  type PreflightResult,
  type RepositoryProvider,
  type RepositoryTarget,
} from "@/lib/preflight/preflight";
import { getEnvironment } from "@/lib/env/schema";
import { isRepositoryProtectedForProduct } from "@/lib/repositories/product-repository-protection";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export { isRepositoryProtectedForProduct } from "@/lib/repositories/product-repository-protection";

type PreflightInput = {
  change: PreflightChange & { workspaceId: string };
  repositories: RepositoryTarget[];
};

export interface PreflightRepository {
  loadEligibleInput(impactAssessmentId: string): Promise<PreflightInput | null>;
  getOrCreateRun(input: {
    workspaceId: string;
    impactAssessmentId: string;
    repositorySetFingerprint: string;
    changeFingerprint: string;
    preflightVersion: string;
  }): Promise<{ id: string; status: string }>;
  markRunning(runId: string): Promise<string | null>;
  saveResult(
    runId: string,
    workspaceId: string,
    result: PreflightResult,
    repositoryIds: string[],
    claimToken: string,
  ): Promise<void>;
  loadResult(runId: string): Promise<PreflightResult | null>;
}

function throwSupabaseError(error: { code?: string; message?: string } | null) {
  if (!error) return;
  // Never pass provider/database response bodies or secrets to logs/callers.
  throw new Error(error.code ?? "preflight_persistence_error");
}

export class SupabasePreflightRepository implements PreflightRepository {
  private readonly client = createSupabaseServerClient();

  async loadEligibleInput(impactAssessmentId: string): Promise<PreflightInput | null> {
    const { data: assessment, error: assessmentError } = await this.client
      .from("impact_assessments")
      .select(
        "id,workspace_id,workspace_dependency_id,source_change_classification_id,relevant,severity,impact_summary,why_it_matters,recommended_action",
      )
      .eq("id", impactAssessmentId)
      .eq("status", "assessed")
      .eq("relevant", true)
      .maybeSingle();
    throwSupabaseError(assessmentError);
    if (!assessment) return null;

    const { data: dependencyState, error: dependencyStateError } = await this.client
      .from("workspace_dependencies")
      .select("protected_product_id,monitoring_enabled")
      .eq("id", assessment.workspace_dependency_id)
      .eq("workspace_id", assessment.workspace_id)
      .maybeSingle();
    throwSupabaseError(dependencyStateError);
    if (!dependencyState?.monitoring_enabled || !dependencyState.protected_product_id) return null;
    const { data: productState, error: productError } = await this.client
      .from("workspace_products")
      .select("status")
      .eq("id", dependencyState.protected_product_id)
      .eq("workspace_id", assessment.workspace_id)
      .maybeSingle();
    throwSupabaseError(productError);
    if (productState?.status !== "protected") return null;

    const [
      { data: classification, error: classificationError },
      { data: context, error: contextError },
    ] = await Promise.all([
      this.client
        .from("source_change_classifications")
        .select("id,change_id,status,material,affected_entities,summary,evidence")
        .eq("id", assessment.source_change_classification_id)
        .eq("status", "classified")
        .eq("material", true)
        .maybeSingle(),
      this.client
        .from("dependency_context")
        .select("used_for,criticality,production_critical")
        .eq("workspace_dependency_id", assessment.workspace_dependency_id)
        .eq("workspace_id", assessment.workspace_id)
        .maybeSingle(),
    ]);
    throwSupabaseError(classificationError);
    throwSupabaseError(contextError);
    if (!classification) return null;

    const { data: change, error: changeError } = await this.client
      .from("source_changes")
      .select("source_id")
      .eq("id", classification.change_id)
      .maybeSingle();
    throwSupabaseError(changeError);
    if (!change) return null;
    const { data: source, error: sourceError } = await this.client
      .from("source_catalog")
      .select("dependency_id")
      .eq("id", change.source_id)
      .maybeSingle();
    throwSupabaseError(sourceError);
    if (!source) return null;
    const { data: dependency, error: dependencyError } = await this.client
      .from("dependency_catalog")
      .select("name")
      .eq("id", source.dependency_id)
      .maybeSingle();
    throwSupabaseError(dependencyError);
    if (!dependency) return null;

    const { data: access, error: accessError } = await this.client
      .from("workspace_repository_access")
      .select("repository_id")
      .eq("workspace_id", assessment.workspace_id)
      .eq("workspace_dependency_id", assessment.workspace_dependency_id);
    throwSupabaseError(accessError);
    const repositoryIds = (access ?? []).map((row) => row.repository_id as string);
    if (repositoryIds.length === 0) return null;
    const { data: repositoryRows, error: repositoriesError } = await this.client
      .from("repositories")
      .select(
        "id,workspace_id,connection_id,external_id,owner,name,default_branch,status,selected_for_protection",
      )
      .in("id", repositoryIds)
      .eq("workspace_id", assessment.workspace_id)
      .eq("status", "available")
      .order("owner", { ascending: true })
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .limit(MAX_REPOSITORIES + 1);
    throwSupabaseError(repositoriesError);
    const candidateRepositoryIds = (repositoryRows ?? []).map((row) => row.id as string);
    const [
      { data: productMappings, error: mappingError },
      { data: repositoryAccessEdges, error: accessEdgesError },
    ] = candidateRepositoryIds.length
      ? await Promise.all([
          this.client
            .from("workspace_product_repositories")
            .select("repository_id,protected_product_id,status")
            .eq("workspace_id", assessment.workspace_id)
            .in("repository_id", candidateRepositoryIds),
          this.client
            .from("workspace_repository_access")
            .select("repository_id,workspace_dependency_id")
            .eq("workspace_id", assessment.workspace_id)
            .in("repository_id", candidateRepositoryIds),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
        ];
    throwSupabaseError(mappingError);
    throwSupabaseError(accessEdgesError);
    const attributedDependencyIds = [
      ...new Set(
        (repositoryAccessEdges ?? []).map((edge) => edge.workspace_dependency_id as string),
      ),
    ];
    const { data: attributedDependencies, error: attributedDependenciesError } =
      attributedDependencyIds.length
        ? await this.client
            .from("workspace_dependencies")
            .select("id,protected_product_id")
            .eq("workspace_id", assessment.workspace_id)
            .in("id", attributedDependencyIds)
        : { data: [], error: null };
    throwSupabaseError(attributedDependenciesError);
    const productIdByDependency = new Map(
      (attributedDependencies ?? []).map((dependency) => [
        dependency.id as string,
        dependency.protected_product_id as string,
      ]),
    );
    const productIdsByRepository = new Map<string, Set<string>>();
    for (const edge of repositoryAccessEdges ?? []) {
      const productId = productIdByDependency.get(edge.workspace_dependency_id as string);
      if (!productId) continue;
      const productIds = productIdsByRepository.get(edge.repository_id as string) ?? new Set();
      productIds.add(productId);
      productIdsByRepository.set(edge.repository_id as string, productIds);
    }
    const mappingsByRepository = new Map<string, typeof productMappings>();
    for (const mapping of productMappings ?? []) {
      const existing = mappingsByRepository.get(mapping.repository_id) ?? [];
      existing.push(mapping);
      mappingsByRepository.set(mapping.repository_id, existing);
    }
    const repositories = (repositoryRows ?? []).filter((repository) => {
      const mappings = mappingsByRepository.get(repository.id) ?? [];
      return isRepositoryProtectedForProduct({
        selectedForProtection: repository.selected_for_protection,
        productId: dependencyState.protected_product_id,
        mappings,
        dependencyProductIds: [...(productIdsByRepository.get(repository.id) ?? [])],
      });
    });
    if (!repositories?.length) return null;
    const connectionIds = [...new Set(repositories.map((row) => row.connection_id as string))];
    const { data: connections, error: connectionsError } = await this.client
      .from("repository_connections")
      .select("id,installation_id,status")
      .in("id", connectionIds)
      .eq("workspace_id", assessment.workspace_id)
      .eq("status", "connected");
    throwSupabaseError(connectionsError);
    const installationByConnection = new Map(
      (connections ?? []).map((row) => [row.id as string, Number(row.installation_id)]),
    );
    const targets = repositories.flatMap((repository) => {
      const installationId = installationByConnection.get(repository.connection_id as string);
      if (!installationId) return [];
      return [
        {
          id: repository.id as string,
          workspaceId: assessment.workspace_id as string,
          owner: repository.owner as string,
          name: repository.name as string,
          defaultBranch: repository.default_branch as string,
          externalId: Number(repository.external_id),
          installationId,
        },
      ];
    });
    if (!targets.length) return null;

    const evidence = Array.isArray(classification.evidence)
      ? classification.evidence
          .flatMap((item: unknown) =>
            item &&
            typeof item === "object" &&
            "excerpt" in item &&
            typeof item.excerpt === "string"
              ? [item.excerpt]
              : [],
          )
          .slice(0, 5)
      : [];
    const dates = parseExplicitChangeDates(evidence);
    const changeInput: PreflightChange = {
      assessmentId: assessment.id as string,
      workspaceDependencyId: assessment.workspace_dependency_id as string,
      dependencyName: dependency.name as string,
      material: classification.material as boolean,
      relevant: assessment.relevant as boolean,
      severity: assessment.severity as string,
      summary: classification.summary as string,
      impactSummary: assessment.impact_summary as string,
      whyItMatters: assessment.why_it_matters as string,
      recommendedAction: assessment.recommended_action as string | null,
      contextCriticality: (context?.criticality as string | undefined) ?? "normal",
      productionCritical: context?.production_critical === true,
      affectedEntities: Array.isArray(classification.affected_entities)
        ? classification.affected_entities
            .filter((value): value is string => typeof value === "string")
            .slice(0, 5)
        : [],
      evidence,
      contextUsedFor: Array.isArray(context?.used_for)
        ? context.used_for
            .filter((value): value is string => typeof value === "string")
            .slice(0, 12)
        : [],
      effectiveAt: dates.effectiveAt,
      announcedAt: dates.announcedAt,
      deadline: dates.deadline,
    };
    // Public provider evidence may contain instruction-like text; it is passed only as search terms, never as instructions.
    return {
      change: { ...changeInput, workspaceId: assessment.workspace_id as string },
      repositories: targets,
    };
  }

  async getOrCreateRun(input: Parameters<PreflightRepository["getOrCreateRun"]>[0]) {
    const identity = {
      workspace_id: input.workspaceId,
      impact_assessment_id: input.impactAssessmentId,
      repository_set_fingerprint: input.repositorySetFingerprint,
      change_fingerprint: input.changeFingerprint,
      preflight_version: input.preflightVersion,
    };
    const { data, error } = await this.client
      .from("preflight_runs")
      .upsert(
        { ...identity, status: "queued" },
        {
          onConflict:
            "workspace_id,impact_assessment_id,repository_set_fingerprint,change_fingerprint,preflight_version",
          ignoreDuplicates: true,
        },
      )
      .select("id,status")
      .maybeSingle();
    throwSupabaseError(error);
    if (data) return { id: data.id as string, status: data.status as string };
    const existing = await this.client
      .from("preflight_runs")
      .select("id,status")
      .match(identity)
      .single();
    throwSupabaseError(existing.error);
    if (!existing.data) throw new Error("preflight_run_create_failed");
    return { id: existing.data.id as string, status: existing.data.status as string };
  }

  async markRunning(runId: string) {
    const { data, error } = await this.client.rpc("claim_preflight_run", { p_run_id: runId });
    throwSupabaseError(error);
    return typeof data === "string" ? data : null;
  }

  async saveResult(
    runId: string,
    _workspaceId: string,
    result: PreflightResult,
    repositoryIds: string[],
    claimToken: string,
  ) {
    const { error } = await this.client.rpc("save_preflight_result", {
      p_run_id: runId,
      p_claim_token: claimToken,
      p_repository_ids: repositoryIds,
      p_result: {
        status: result.status,
        verifiedImpact: result.verifiedImpact,
        confidence: result.confidence,
        complexity: result.complexity,
        recommendedRemediation: result.recommendedRemediation,
        effectiveAt: result.effectiveAt,
        announcedAt: result.announcedAt,
        deadline: result.deadline,
        daysRemaining: result.daysRemaining,
        repositoriesScanned: result.repositoriesScanned,
        findings: result.findings.map((finding) => ({
          repositoryId: finding.repositoryId,
          commitSha: finding.commitSha,
          path: finding.path,
          lineStart: finding.lineStart,
          lineEnd: finding.lineEnd,
          findingType: finding.findingType,
          affectedEntity: finding.affectedEntity,
          confidence: finding.confidence,
          verification: finding.verification,
          explanation: finding.explanation,
          evidenceFingerprint: finding.evidenceFingerprint,
        })),
      },
    });
    throwSupabaseError(error);
  }

  async loadResult(runId: string): Promise<PreflightResult | null> {
    const { data: run, error } = await this.client
      .from("preflight_runs")
      .select("*")
      .eq("id", runId)
      .maybeSingle();
    throwSupabaseError(error);
    if (!run || !["completed", "partial"].includes(run.status)) return null;
    const { data: findings, error: findingsError } = await this.client
      .from("preflight_findings")
      .select("*,repositories(owner,name)")
      .eq("preflight_run_id", runId)
      .limit(200);
    throwSupabaseError(findingsError);
    const cleanFindings = (findings ?? []).map((item) => ({
      repositoryId: item.repository_id,
      repository: `${(item.repositories as { owner: string; name: string } | null)?.owner ?? "unknown"}/${(item.repositories as { owner: string; name: string } | null)?.name ?? "repository"}`,
      commitSha: item.commit_sha,
      path: item.file_path,
      lineStart: item.line_start,
      lineEnd: item.line_end,
      findingType: item.finding_type,
      affectedEntity: item.affected_entity,
      confidence: Number(item.confidence),
      verification: item.verification,
      explanation: item.explanation,
      evidenceFingerprint: item.evidence_fingerprint,
    }));
    return {
      status: run.status,
      verifiedImpact: run.verified_impact,
      confidence: Number(run.confidence),
      repositoriesScanned: run.repositories_scanned,
      findings: cleanFindings,
      affectedAreas: [
        ...new Set(
          cleanFindings.map(
            (finding) => finding.path.split("/").slice(0, -1).join("/") || "repository root",
          ),
        ),
      ],
      complexity: run.complexity,
      recommendedRemediation: run.recommended_remediation,
      effectiveAt: run.effective_at,
      announcedAt: run.announced_at,
      deadline: run.deadline,
      daysRemaining: run.days_remaining,
    } as PreflightResult;
  }
}

export async function runPreflight(input: {
  impactAssessmentId: string;
  repository?: PreflightRepository;
  provider?: RepositoryProvider;
}) {
  const repository = input.repository ?? new SupabasePreflightRepository();
  const loaded = await repository.loadEligibleInput(input.impactAssessmentId);
  if (!loaded || !loaded.change.material || !loaded.change.relevant)
    return { status: "ineligible" as const };
  const provider = input.provider ?? createConfiguredProvider();
  const headResults = await Promise.allSettled(
    loaded.repositories.slice(0, MAX_REPOSITORIES).map(async (target) => ({
      ...target,
      commitSha: await provider.getHead(target),
    })),
  );
  const transientHeadFailure = headResults.find(
    (head) => head.status === "rejected" && isRetryableProviderFailure(head.reason),
  );
  if (transientHeadFailure?.status === "rejected") throw transientHeadFailure.reason;
  const heads = headResults.flatMap((head) => (head.status === "fulfilled" ? [head.value] : []));
  const headFailures = headResults.length - heads.length;
  const repositorySetFingerprint = createPreflightFingerprint({
    targets: [
      ...heads.map(({ id, commitSha, defaultBranch }) => ({
        id,
        commitSha,
        defaultBranch,
        status: "available",
      })),
      ...headResults.flatMap((head, index) =>
        head.status === "rejected"
          ? [
              {
                id: loaded.repositories[index]!.id,
                commitSha: null,
                defaultBranch: loaded.repositories[index]!.defaultBranch,
                status: "unavailable",
              },
            ]
          : [],
      ),
    ].sort((a, b) => a.id.localeCompare(b.id)),
    truncated: loaded.repositories.length > MAX_REPOSITORIES,
  });
  const changeFingerprint = createPreflightFingerprint({
    assessmentId: loaded.change.assessmentId,
    dependency: loaded.change.dependencyName,
    affectedEntities: loaded.change.affectedEntities,
    evidence: loaded.change.evidence,
    summary: loaded.change.summary,
    impactSummary: loaded.change.impactSummary,
    whyItMatters: loaded.change.whyItMatters,
    recommendedAction: loaded.change.recommendedAction,
    contextUsedFor: loaded.change.contextUsedFor,
    contextCriticality: loaded.change.contextCriticality,
    productionCritical: loaded.change.productionCritical,
    severity: loaded.change.severity,
    effectiveAt: loaded.change.effectiveAt,
  });
  const run = await repository.getOrCreateRun({
    workspaceId: loaded.change.workspaceId,
    impactAssessmentId: loaded.change.assessmentId,
    repositorySetFingerprint,
    changeFingerprint,
    preflightVersion: PREFLIGHT_VERSION,
  });
  if (["completed", "partial"].includes(run.status)) {
    const result = await repository.loadResult(run.id);
    return { status: "replayed" as const, runId: run.id, result };
  }
  const claimToken = await repository.markRunning(run.id);
  if (!claimToken) {
    const result = await repository.loadResult(run.id);
    if (result) return { status: "replayed" as const, runId: run.id, result };
    throw new Error("preflight_already_running");
  }
  try {
    const result = await inspectRepositories({
      change: loaded.change,
      repositories: heads,
      provider,
      preexistingFailures: headFailures + (loaded.repositories.length > MAX_REPOSITORIES ? 1 : 0),
    });
    await repository.saveResult(
      run.id,
      loaded.change.workspaceId,
      result,
      loaded.repositories.slice(0, MAX_REPOSITORIES).map((target) => target.id),
      claimToken,
    );
    return { status: result.status, runId: run.id, result };
  } catch (error) {
    // Errors are intentionally categorized; GitHub's response bodies and tokens are not retained.
    const client = createSupabaseServerClient();
    await client
      .from("preflight_runs")
      .update({
        status: "failed",
        error_category: error instanceof Error ? error.message.slice(0, 80) : "preflight_failed",
        completed_at: null,
        run_lease_until: null,
        run_claim_token: null,
      })
      .eq("id", run.id)
      .eq("status", "running")
      .eq("run_claim_token", claimToken);
    throw error;
  }
}

function createConfiguredProvider() {
  const environment = getEnvironment();
  return new GitHubAppRepositoryProvider({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
}
