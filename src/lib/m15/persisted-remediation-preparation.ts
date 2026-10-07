import "server-only";
import { createHash } from "node:crypto";
import { resolveWorkspaceEntitlementsForService } from "@/lib/billing/server";
import { prepareGroundedPatch } from "@/lib/preflight/patch-preparation";
import {
  redactSecretShapedContent,
  type RepositoryProvider,
  type RepositoryTarget,
} from "@/lib/preflight/preflight";
import { SupabasePreflightRepository } from "@/lib/preflight/preflight-service";
import { buildRemediationGuidance } from "@/lib/preflight/remediation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isM15LocalAcceptanceRuntime } from "@/lib/m15/local-trigger-proof";

type Outcome = "patch_prepared" | "grounded_guidance" | "no_safe_patch";

export type PersistedRemediationPreparation = {
  proposalKind: "patch" | "grounded_guidance";
  outcome: Outcome;
  proposalCandidate: Record<string, unknown>;
};

function fail(code: string): never {
  throw new Error(code);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedReason(value: string) {
  return value.replace(/[^a-z0-9_]/gi, "_").slice(0, 80) || "safe_patch_unavailable";
}

function localQaEvidenceEnabled() {
  return process.env["NODE_ENV"] !== "production" && isM15LocalAcceptanceRuntime();
}

function throwDb(error: { code?: string } | null) {
  if (error) fail(error.code ?? "remediation_persistence_unavailable");
}

function value<T>(row: Record<string, unknown> | null, key: string): T | null {
  return row && key in row ? (row[key] as T) : null;
}

/**
 * Prepare a proposal exclusively from persisted production-eligible evidence and a persisted
 * verified Preflight run. The injected provider is used only for an exact repository SHA.
 */
export async function preparePersistedRemediation(input: {
  preflightRunId: string;
  provider: RepositoryProvider;
}): Promise<PersistedRemediationPreparation> {
  const client = createSupabaseServerClient();
  const [runResult, preflight] = await Promise.all([
    client
      .from("preflight_runs")
      .select("id,workspace_id,impact_assessment_id,status,verified_impact")
      .eq("id", input.preflightRunId)
      .maybeSingle(),
    new SupabasePreflightRepository().loadResult(input.preflightRunId),
  ]);
  throwDb(runResult.error);
  const run = runResult.data as Record<string, unknown> | null;
  if (
    !run ||
    run.status !== "completed" ||
    run.verified_impact !== "verified" ||
    !preflight ||
    preflight.status !== "completed" ||
    preflight.verifiedImpact !== "verified" ||
    !preflight.findings.some((finding) => finding.verification === "verified")
  ) {
    fail("verified_persisted_preflight_required");
  }
  const workspaceId = value<string>(run, "workspace_id");
  const assessmentId = value<string>(run, "impact_assessment_id");
  if (!workspaceId || !assessmentId) fail("preflight_scope_unavailable");

  const [workspaceResult, assessmentResult, entitlements] = await Promise.all([
    client.from("workspaces").select("id").eq("id", workspaceId).maybeSingle(),
    client
      .from("impact_assessments")
      .select(
        "id,workspace_id,workspace_dependency_id,source_change_classification_id,status,relevant",
      )
      .eq("id", assessmentId)
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    resolveWorkspaceEntitlementsForService(workspaceId),
  ]);
  throwDb(workspaceResult.error);
  if (!workspaceResult.data) fail("workspace_unavailable");
  throwDb(assessmentResult.error);
  const assessment = assessmentResult.data as Record<string, unknown> | null;
  if (!assessment || assessment.status !== "assessed" || assessment.relevant !== true) {
    fail("customer_impact_not_eligible");
  }
  if (
    !entitlements.capabilities.generateFix ||
    entitlements.usage.remediationRuns >= entitlements.limits.remediationRuns
  ) {
    fail("generate_fix_not_entitled");
  }

  const workspaceDependencyId = value<string>(assessment, "workspace_dependency_id");
  const classificationId = value<string>(assessment, "source_change_classification_id");
  if (!workspaceDependencyId || !classificationId) fail("dependency_scope_unavailable");
  const { data: dependencyData, error: dependencyError } = await client
    .from("workspace_dependencies")
    .select("id,workspace_id,dependency_id,protected_product_id,monitoring_enabled")
    .eq("id", workspaceDependencyId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  throwDb(dependencyError);
  const dependency = dependencyData as Record<string, unknown> | null;
  const productId = value<string>(dependency, "protected_product_id");
  const dependencyCatalogId = value<string>(dependency, "dependency_id");
  if (!dependency || !productId || dependency.monitoring_enabled !== true) {
    fail("protected_dependency_required");
  }
  const { data: productData, error: productError } = await client
    .from("workspace_products")
    .select("id,status")
    .eq("id", productId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  throwDb(productError);
  if (!productData || productData.status !== "protected") fail("protected_product_required");

  const { data: classificationData, error: classificationError } = await client
    .from("source_change_classifications")
    .select("id,change_id,status,material")
    .eq("id", classificationId)
    .maybeSingle();
  throwDb(classificationError);
  const classification = classificationData as Record<string, unknown> | null;
  const sourceChangeId = value<string>(classification, "change_id");
  if (
    !classification ||
    classification.status !== "classified" ||
    classification.material !== true ||
    !sourceChangeId
  ) {
    fail("material_source_change_required");
  }
  const { data: sourceChangeData, error: sourceChangeError } = await client
    .from("source_changes")
    .select("id,source_id")
    .eq("id", sourceChangeId)
    .maybeSingle();
  throwDb(sourceChangeError);
  const sourceId = value<string>(sourceChangeData as Record<string, unknown> | null, "source_id");
  if (!sourceId || !dependencyCatalogId) fail("source_dependency_mismatch");
  const { data: sourceData, error: sourceError } = await client
    .from("source_catalog")
    .select("id,dependency_id")
    .eq("id", sourceId)
    .maybeSingle();
  throwDb(sourceError);
  if ((sourceData as Record<string, unknown> | null)?.dependency_id !== dependencyCatalogId) {
    fail("source_dependency_mismatch");
  }

  // A replacement is eligible only when explicitly marked public-eligible and outside internal QA.
  // This query intentionally excludes synthetic rows before any evidence is read by the planner.
  const replacementQuery = client
    .from("source_remediation_replacements")
    .select(
      "id,old_expression,new_expression,evidence_source_url,evidence_fingerprint,synthetic,internal_qa,public_eligible",
    )
    .eq("source_change_id", sourceChangeId)
    .eq("source_change_classification_id", classificationId);
  const { data: replacementsData, error: replacementsError } = await (
    localQaEvidenceEnabled()
      ? replacementQuery.or(
          "and(synthetic.eq.false,internal_qa.eq.false,public_eligible.eq.true),and(synthetic.eq.true,internal_qa.eq.true,public_eligible.eq.false)",
        )
      : replacementQuery.eq("synthetic", false).eq("internal_qa", false).eq("public_eligible", true)
  )
    .order("created_at", { ascending: true })
    .limit(20);
  throwDb(replacementsError);
  const eligibleReplacementRows = (
    (replacementsData as Record<string, unknown>[] | null) ?? []
  ).filter(
    (row) =>
      (row.synthetic === false && row.internal_qa === false && row.public_eligible === true) ||
      (localQaEvidenceEnabled() &&
        row.synthetic === true &&
        row.internal_qa === true &&
        row.public_eligible === false),
  );
  const replacementRow = eligibleReplacementRows[0] ?? null;
  if (
    replacementRow &&
    (typeof replacementRow.evidence_source_url !== "string" ||
      !replacementRow.evidence_source_url.startsWith("https://") ||
      typeof replacementRow.evidence_fingerprint !== "string" ||
      !/^[a-f0-9]{64}$/.test(replacementRow.evidence_fingerprint))
  ) {
    fail("replacement_evidence_invalid");
  }
  const replacement = replacementRow
    ? {
        authoritative: true as const,
        oldExpression: String(replacementRow.old_expression ?? ""),
        newExpression: String(replacementRow.new_expression ?? ""),
        evidenceId: String(replacementRow.id ?? ""),
      }
    : null;

  const verifiedFindings = preflight.findings.filter(
    (finding) => finding.verification === "verified",
  );
  if (verifiedFindings.length > 20) fail("preflight_finding_limit_exceeded");
  const repositoryIds = [...new Set(verifiedFindings.map((finding) => finding.repositoryId))];
  if (repositoryIds.length !== 1) fail("single_pinned_repository_required");
  const repositoryId = repositoryIds[0]!;
  const commitShas = [...new Set(verifiedFindings.map((finding) => finding.commitSha))];
  if (commitShas.length !== 1) fail("single_pinned_commit_required");
  const commitSha = commitShas[0]!;
  const { data: repositoryData, error: repositoryError } = await client
    .from("repositories")
    .select(
      "id,workspace_id,connection_id,external_id,owner,name,default_branch,status,selected_for_protection",
    )
    .eq("id", repositoryId)
    .eq("workspace_id", workspaceId)
    .eq("status", "available")
    .eq("selected_for_protection", true)
    .maybeSingle();
  throwDb(repositoryError);
  const repository = repositoryData as Record<string, unknown> | null;
  if (!repository) fail("repository_unavailable");
  const connectionId = value<string>(repository, "connection_id");
  const { data: accessData, error: accessError } = await client
    .from("workspace_repository_access")
    .select("repository_id")
    .eq("workspace_id", workspaceId)
    .eq("workspace_dependency_id", workspaceDependencyId)
    .eq("repository_id", repositoryId)
    .maybeSingle();
  throwDb(accessError);
  if (!accessData || !connectionId) fail("dependency_repository_access_required");
  const { data: connectionData, error: connectionError } = await client
    .from("repository_connections")
    .select("id,installation_id,status")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .eq("status", "connected")
    .maybeSingle();
  throwDb(connectionError);
  if (!connectionData) fail("repository_connection_required");

  const target: RepositoryTarget = {
    id: repositoryId,
    workspaceId,
    owner: String(repository.owner),
    name: String(repository.name),
    defaultBranch: String(repository.default_branch),
    externalId: Number(repository.external_id),
    installationId: Number((connectionData as Record<string, unknown>).installation_id),
  };
  if (!Number.isSafeInteger(target.installationId) || target.installationId <= 0) {
    fail("repository_connection_required");
  }

  const { data: policyData, error: policyError } = await client
    .from("product_remediation_policies")
    .select("enabled,draft_pr_preparation_allowed,allowed_repository_ids")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .maybeSingle();
  throwDb(policyError);
  const policy = policyData as Record<string, unknown> | null;
  const policyAllowsPatch = Boolean(
    policy?.enabled === true &&
    policy.draft_pr_preparation_allowed === true &&
    Array.isArray(policy.allowed_repository_ids) &&
    policy.allowed_repository_ids.includes(repositoryId),
  );

  // Avoid persisting the old line if it contains secret-shaped material. No file bodies are stored.
  const files = new Map<
    string,
    Awaited<ReturnType<RepositoryProvider["getFile"]>> extends infer T ? Exclude<T, null> : never
  >();
  let fileUnavailable = false;
  if (replacement && policyAllowsPatch) {
    for (const finding of verifiedFindings) {
      const fetched = await input.provider.getFile(target, finding.path, commitSha);
      if (!fetched) {
        fileUnavailable = true;
        break;
      }
      const line = fetched.text.split(/\r?\n/)[finding.lineStart - 1] ?? "";
      if (redactSecretShapedContent(line) !== line) {
        fileUnavailable = true;
        break;
      }
      files.set(finding.path, fetched);
    }
  }

  const unavailableReason = !replacement
    ? "explicit_authoritative_replacement_required"
    : !policyAllowsPatch
      ? "product_patch_policy_not_enabled"
      : fileUnavailable
        ? "pinned_file_unavailable_or_sensitive"
        : null;
  const prepared =
    unavailableReason !== null
      ? {
          outcome: "NO_SAFE_PATCH" as const,
          reason: unavailableReason,
        }
      : prepareGroundedPatch({ preflight, files, replacement });
  const guidance = buildRemediationGuidance({
    preflightRunId: input.preflightRunId,
    result: preflight,
    findings: verifiedFindings,
  });
  const outcome: Outcome =
    prepared.outcome === "PATCH_PREPARED"
      ? "patch_prepared"
      : prepared.outcome === "NO_SAFE_PATCH"
        ? "no_safe_patch"
        : "grounded_guidance";
  const proposalKind = prepared.outcome === "PATCH_PREPARED" ? "patch" : "grounded_guidance";
  const proposalFingerprint =
    prepared.outcome === "PATCH_PREPARED"
      ? prepared.fingerprint
      : sha256(`${guidance.fingerprint}\n${outcome}\n${boundedReason(prepared.reason)}`);
  const rationale =
    prepared.outcome === "PATCH_PREPARED"
      ? `A bounded replacement was prepared from explicit provider evidence for ${prepared.affectedFiles.length} verified file${prepared.affectedFiles.length === 1 ? "" : "s"}. Human review remains required.`
      : guidance.rationale;
  const generationMetadata = {
    version: 1,
    outcome,
    repository: {
      id: repositoryId,
      owner: String(repository.owner).slice(0, 100),
      name: String(repository.name).slice(0, 100),
      commitSha,
    },
    source:
      replacementRow?.synthetic === true
        ? "synthetic_internal_qa"
        : replacement
          ? "public_evidence"
          : "none",
    reason: prepared.outcome === "PATCH_PREPARED" ? null : boundedReason(prepared.reason),
    replacementEvidenceId: replacement?.evidenceId ?? null,
    replacementEvidenceFingerprint: replacementRow?.evidence_fingerprint ?? null,
    syntheticEvidenceExcluded: replacementRow?.synthetic !== true,
    internalQaOnly: replacementRow?.synthetic === true,
  };
  const payload = {
    workspace_id: workspaceId,
    preflight_run_id: input.preflightRunId,
    proposal_kind: proposalKind,
    proposal_fingerprint: proposalFingerprint,
    rationale: rationale.slice(0, 2000),
    migration_notes: guidance.migrationNotes,
    validation_requirements: guidance.validationRequirements,
    affected_files:
      prepared.outcome === "PATCH_PREPARED" ? prepared.affectedFiles : guidance.affectedFiles,
    patch: prepared.outcome === "PATCH_PREPARED" ? prepared.patch : null,
    base_commit_sha: commitSha,
    created_by: null,
    product_id: productId,
    workspace_dependency_id: workspaceDependencyId,
    source_change_id: sourceChangeId,
    source_change_classification_id: classificationId,
    patch_fingerprint: prepared.outcome === "PATCH_PREPARED" ? prepared.fingerprint : null,
    generation_metadata: generationMetadata,
  };
  return {
    proposalKind,
    outcome,
    proposalCandidate: payload,
  };
}
