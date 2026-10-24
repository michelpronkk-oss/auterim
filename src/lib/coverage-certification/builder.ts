import type { SupabaseClient } from "@supabase/supabase-js";
import type { CoverageCertificate, SubjectEvaluation } from "./contracts";
import {
  buildCertificate,
  evaluateDependencySources,
  evaluateDeploymentExposure,
  evaluateRepositoryCode,
  evaluateRuntimeSignals,
} from "./evaluate";
import { certificateIssueArguments } from "./issue";

/** Raw evidence for one Product, read with exactly the selection rules the issuing RPC checks. */
export type ProductCoverageEvidence = {
  dependencies: Array<{
    id: string;
    sources: Array<{ id: string; sourceType: string; lastSuccessAt: string | null }>;
  }>;
  repositories: Array<{
    repositoryId: string;
    /** Recent completed analyses of this repository, newest first. */
    analyses: Array<{
      id: string;
      commitSha: string;
      coverageState: "complete" | "partial" | "unsupported" | "failed";
    }>;
  }>;
  surfaces: Array<{
    surfaceId: string;
    /** The latest evidence row for the surface (by `observed_at`, then `id`). */
    evidence: {
      id: string;
      repositoryId: string;
      verificationState:
        "mapped" | "commit_verified" | "production_verified" | "inconclusive" | "historical";
      verifiedCommitSha: string | null;
    } | null;
    /** The latest finished sync attempt (by `completed_at`, then `id`). */
    lastSync: { status: "succeeded" | "failed"; completedAt: string } | null;
  }>;
};

/**
 * The commit verified as running in Production for a repository, or null when there is none or
 * the Product's surfaces disagree (then no code evidence can be bound to Production).
 */
function productionCommitFor(repositoryId: string, evidence: ProductCoverageEvidence) {
  const commits = new Set(
    evidence.surfaces
      .map((surface) => surface.evidence)
      .filter(
        (row) =>
          row?.repositoryId === repositoryId &&
          row.verificationState === "production_verified" &&
          row.verifiedCommitSha,
      )
      .map((row) => row!.verifiedCommitSha!.toLowerCase()),
  );
  return commits.size === 1 ? [...commits][0]! : null;
}

/**
 * Components for every current subject of the Product. The repository head commit is not
 * known here, so code evidence counts only at a production-verified commit; without one the
 * repository is `unknown` (`analysis_commit_unverified`), never stronger.
 */
export function componentsFromEvidence(
  evidence: ProductCoverageEvidence,
  now: Date,
): SubjectEvaluation[] {
  const sources = evidence.dependencies.map((dependency) =>
    evaluateDependencySources({
      dependencyId: dependency.id,
      catalogReadComplete: true,
      sources: dependency.sources.map((source) => ({
        sourceId: source.id,
        sourceType: source.sourceType,
        lastSuccessAt: source.lastSuccessAt,
      })),
      now,
    }),
  );
  const code = evidence.repositories.map((repository) => {
    const productionCommitSha = productionCommitFor(repository.repositoryId, evidence);
    const analysis =
      (productionCommitSha &&
        repository.analyses.find((run) => run.commitSha.toLowerCase() === productionCommitSha)) ||
      repository.analyses[0] ||
      null;
    return evaluateRepositoryCode({
      repositoryId: repository.repositoryId,
      analysis: analysis && {
        runId: analysis.id,
        commitSha: analysis.commitSha,
        status: "completed",
        coverageState: analysis.coverageState,
      },
      headCommitSha: null,
      productionCommitSha,
    });
  });
  const deployments = evidence.surfaces.map((surface) =>
    evaluateDeploymentExposure({
      surfaceId: surface.surfaceId,
      evidence: surface.evidence && {
        evidenceId: surface.evidence.id,
        verificationState: surface.evidence.verificationState,
        verifiedCommitSha: surface.evidence.verifiedCommitSha,
      },
      lastSync: surface.lastSync,
      now,
    }),
  );
  return [...sources, ...code, ...deployments, evaluateRuntimeSignals()];
}

const ANALYSES_PER_REPOSITORY = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rows<T>(result: { data: T[] | null; error: unknown }, what: string): T[] {
  if (result.error || !result.data) throw new Error(`coverage_evidence_unavailable:${what}`);
  return result.data;
}

/**
 * Reads the Product's evidence with a service-role client. Every query is scoped to the
 * workspace and Product; any read error aborts the build so a partial read is never certified.
 */
export async function readProductCoverageEvidence(
  client: SupabaseClient,
  input: { workspaceId: string; productId: string },
): Promise<ProductCoverageEvidence> {
  const { workspaceId, productId } = input;
  // productId is interpolated into a PostgREST filter below; accept only UUIDs.
  if (!UUID.test(workspaceId) || !UUID.test(productId))
    throw new Error("coverage_evidence_invalid_subject");
  const dependencyRows = rows<{ id: string; dependency_id: string }>(
    await client
      .from("workspace_dependencies")
      .select("id, dependency_id")
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId)
      .eq("monitoring_enabled", true),
    "dependencies",
  );
  const dependencies = [];
  for (const dependency of dependencyRows) {
    const sources = rows<{ id: string; source_type: string; last_success_at: string | null }>(
      await client
        .from("source_catalog")
        .select("id, source_type, last_success_at")
        .eq("dependency_id", dependency.dependency_id)
        .eq("enabled", true)
        .eq("source_mode", "provider"),
      "sources",
    );
    dependencies.push({
      id: dependency.id,
      sources: sources.map((source) => ({
        id: source.id,
        sourceType: source.source_type,
        lastSuccessAt: source.last_success_at,
      })),
    });
  }

  const repositoryRows = rows<{ repository_id: string }>(
    await client
      .from("workspace_product_repositories")
      .select("repository_id")
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId)
      .eq("status", "active"),
    "repositories",
  );
  const repositories = [];
  for (const repository of repositoryRows) {
    const analyses = rows<{
      id: string;
      commit_sha: string;
      coverage_state: ProductCoverageEvidence["repositories"][number]["analyses"][number]["coverageState"];
      product_id: string | null;
    }>(
      await client
        .from("code_analysis_runs")
        .select("id, commit_sha, coverage_state, product_id")
        .eq("workspace_id", workspaceId)
        .eq("repository_id", repository.repository_id)
        .eq("status", "completed")
        .or(`product_id.is.null,product_id.eq.${productId}`)
        .order("completed_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(ANALYSES_PER_REPOSITORY),
      "analyses",
    );
    repositories.push({
      repositoryId: repository.repository_id,
      analyses: analyses.map((run) => ({
        id: run.id,
        commitSha: run.commit_sha,
        coverageState: run.coverage_state,
      })),
    });
  }

  const surfaceRows = rows<{ deployment_surface_id: string }>(
    await client
      .from("workspace_product_deployment_surfaces")
      .select("deployment_surface_id")
      .eq("workspace_id", workspaceId)
      .eq("protected_product_id", productId),
    "surfaces",
  );
  const surfaces = [];
  for (const surface of surfaceRows) {
    const [evidence] = rows<{
      id: string;
      repository_id: string;
      verification_state: NonNullable<
        ProductCoverageEvidence["surfaces"][number]["evidence"]
      >["verificationState"];
      verified_commit_sha: string | null;
    }>(
      await client
        .from("product_deployment_evidence")
        .select("id, repository_id, verification_state, verified_commit_sha")
        .eq("workspace_id", workspaceId)
        .eq("protected_product_id", productId)
        .eq("deployment_surface_id", surface.deployment_surface_id)
        .order("observed_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
      "deployment_evidence",
    );
    const [sync] = rows<{ status: "succeeded" | "failed"; completed_at: string }>(
      await client
        .from("deployment_sync_attempts")
        .select("status, completed_at")
        .eq("workspace_id", workspaceId)
        .eq("deployment_surface_id", surface.deployment_surface_id)
        .in("status", ["succeeded", "failed"])
        .not("completed_at", "is", null)
        .order("completed_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1),
      "deployment_sync",
    );
    surfaces.push({
      surfaceId: surface.deployment_surface_id,
      evidence: evidence
        ? {
            id: evidence.id,
            repositoryId: evidence.repository_id,
            verificationState: evidence.verification_state,
            verifiedCommitSha: evidence.verified_commit_sha,
          }
        : null,
      lastSync: sync
        ? { status: sync.status, completedAt: new Date(sync.completed_at).toISOString() }
        : null,
    });
  }
  return { dependencies, repositories, surfaces };
}

/**
 * Builds the Product's certificate from current evidence and issues it through the guarded
 * RPC. Service role only; the database rejects any component stronger than its evidence.
 */
export async function issueProductCoverageCertificate(
  client: SupabaseClient,
  input: { workspaceId: string; productId: string; now?: Date },
): Promise<{
  certificate: CoverageCertificate;
  result: {
    status: "issued" | "unchanged";
    certificateId: string;
    sequence: number;
    claimLevel: string;
  };
}> {
  const now = input.now ?? new Date();
  const evidence = await readProductCoverageEvidence(client, input);
  const certificate = buildCertificate({
    components: componentsFromEvidence(evidence, now),
    issuedAt: now,
  });
  const { data, error } = await client.rpc(
    "issue_product_coverage_certificate",
    certificateIssueArguments({
      workspaceId: input.workspaceId,
      productId: input.productId,
      certificate,
    }),
  );
  if (error || !data)
    throw new Error(`coverage_certificate_issue_failed:${error?.code ?? "no_data"}`);
  return { certificate, result: data };
}
