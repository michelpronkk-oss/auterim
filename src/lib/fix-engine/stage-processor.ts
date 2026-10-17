import "server-only";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { getEnvironment } from "@/lib/env/schema";
import { GitHubAppRepositoryProvider } from "@/lib/preflight/github-provider";
import type { RepositoryTarget } from "@/lib/preflight/preflight";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { validateProposedDiagnosis, validateProposedFixPlan } from "@/lib/fix-engine/diagnosis";
import {
  buildBoundedModelContext,
  FIX_CODING_PROMPT_CONTRACT_VERSION,
  StructuredChatCompletionFixModel,
  type FixCodingModel,
  type ModelEnvelope,
} from "@/lib/fix-engine/model";
import type { FixStageProcessor } from "@/lib/fix-engine/stage-runtime";
import { hydratePatchProposal, validatePatchProposal } from "@/lib/fix-engine/patch";
import { SupabasePrivatePatchArtifactStore } from "@/lib/fix-engine/artifact-store";
import { withExactBaseGitHubSnapshot } from "@/lib/fix-engine/sandbox";
import { resolveVerificationProfile } from "@/lib/fix-engine/verification-profile";
import {
  createDependencyCacheIdentity,
  resolveTrustedDependencyCache,
} from "@/lib/fix-engine/dependency-cache";
import { assessFixRisk } from "@/lib/fix-engine/risk";
import { DiagnosisSchema, FixPlanSchema, isSafeRepoPath } from "@/lib/fix-engine/contracts";
import { stableFingerprint } from "@/lib/fix-engine/identity";
import { runCanonicalFixPreflight } from "@/lib/fix-engine/canonical-preflight";
import {
  GitHubAppDraftPRProvider,
  assertDraftPrEligible,
  deterministicFixBranch,
  validateDraftPrFiles,
  type GitHubChangedFile,
} from "@/lib/fix-engine/github-write";
import { createScopedGitHubWriteToken } from "@/lib/fix-engine/github-write-token";
import {
  externalOperationKey,
  executeReconciledOperation,
} from "@/lib/fix-engine/operation-ledger";
import { SupabaseExternalOperationStore } from "@/lib/fix-engine/supabase-external-operation-store";
import type {
  DependencyCacheIdentity,
  DependencyCacheResolution,
} from "@/lib/fix-engine/dependency-cache";
import {
  createServerAuthoritativeVerificationExecutor,
  type RemoteVerificationInput,
  type VerificationExecutor,
} from "@/lib/fix-engine/verification-executor";
import {
  createPrivateBaseSnapshotArtifact,
  createSignedDependencyCacheReference,
  markPrivateVerificationSnapshotTerminal,
  registerPrivateVerificationSnapshot,
  type PrivateArtifactReference,
  type SignedDependencyCacheReference,
} from "@/lib/fix-engine/verification-artifacts";
import { VerificationRunnerFailure } from "@/lib/fix-engine/verification-retry";

type StoredRun = {
  id: string;
  workspace_id: string;
  product_id: string;
  repository_id: string;
  product_repository_mapping_id: string;
  provider_repository_identity: string;
  workspace_dependency_id: string;
  source_change_id: string;
  classification_id: string;
  intelligence_decision_id: string;
  route_intent_id: string;
  semantic_route: string;
  route_target: string;
  analysis_run_id: string;
  graph_build_id: string;
  commit_sha: string;
  positive_graph_evidence_ids: string[];
  evidence_fingerprint: string;
  preflight_required: boolean;
  draft_pr_policy_allowed: boolean;
  source_mode: "provider" | "internal_test";
  processing_mode: "customer" | "evidence_only";
  status: string;
  review_disposition: "none" | "review_required";
  review_reason: string | null;
  provenance_mode: "customer" | "evidence_only";
  idempotency_key: string;
};

type GraphEdge = {
  id: string;
  edge_type: string;
  edge_kind: "observed" | "inferred";
  evidence_type: string;
  code_reference_id: string | null;
  code_relation_id: string | null;
  evidence_path: string | null;
  evidence_start_line: number | null;
  evidence_start_column: number | null;
  evidence_end_line: number | null;
  evidence_end_column: number | null;
};

type DbResult<T> = { data: T | null; error: unknown };
type RepositoryRow = {
  id: string;
  workspace_id: string;
  connection_id: string;
  external_id: string | number;
  owner: string;
  name: string;
  default_branch: string;
};
type ConnectionRow = { id: string; workspace_id: string; installation_id: string | number };
type CodeReferenceRow = {
  id: string;
  analysis_run_id: string;
  workspace_id: string;
  repository_id: string;
  commit_sha: string;
  normalized_value: string;
  path: string;
  start_line: number;
  end_line: number;
};
type PlanRow = { id: string; plan: unknown; plan_fingerprint: string };
type PatchRow = {
  id: string;
  plan_id: string;
  base_sha: string;
  patch_fingerprint: string;
  artifact_path: string;
  changed_paths: string[];
  line_count: number;
  byte_count: number;
  status: string;
  provider: string;
  model: string;
};

async function checked<T>(query: PromiseLike<DbResult<T>>, category: string): Promise<T> {
  const result = await query;
  if (result.error || result.data === null) throw new Error(category);
  return result.data;
}

async function loadRun(runId: string): Promise<StoredRun> {
  const client = createSupabaseServerClient();
  return checked<StoredRun>(
    client
      .from("fix_runs")
      .select(
        "id,workspace_id,product_id,repository_id,product_repository_mapping_id,workspace_dependency_id,provider_repository_identity,source_change_id,source_mode,processing_mode,classification_id,intelligence_decision_id,route_intent_id,semantic_route,route_target,analysis_run_id,graph_build_id,commit_sha,positive_graph_evidence_ids,evidence_fingerprint,preflight_required,draft_pr_policy_allowed,review_disposition,review_reason,provenance_mode,idempotency_key,status",
      )
      .eq("id", runId)
      .maybeSingle() as PromiseLike<DbResult<StoredRun>>,
    "fix_run_unavailable",
  );
}

async function loadRepository(run: StoredRun) {
  const client = createSupabaseServerClient();
  const repository = await checked<RepositoryRow>(
    client
      .from("repositories")
      .select("id,workspace_id,connection_id,external_id,owner,name,default_branch")
      .eq("id", run.repository_id)
      .eq("workspace_id", run.workspace_id)
      .eq("status", "available")
      .maybeSingle() as PromiseLike<DbResult<RepositoryRow>>,
    "fix_repository_scope_unavailable",
  );
  const connection = await checked<ConnectionRow>(
    client
      .from("repository_connections")
      .select("id,workspace_id,installation_id,provider,status")
      .eq("id", repository.connection_id)
      .eq("workspace_id", run.workspace_id)
      .eq("provider", "github")
      .eq("status", "connected")
      .maybeSingle() as PromiseLike<DbResult<ConnectionRow>>,
    "fix_github_connection_unavailable",
  );
  const target: RepositoryTarget = {
    id: repository.id,
    workspaceId: repository.workspace_id,
    owner: repository.owner,
    name: repository.name,
    defaultBranch: repository.default_branch,
    externalId: Number(repository.external_id),
    installationId: Number(connection.installation_id),
    commitSha: run.commit_sha,
  };
  if (
    !Number.isSafeInteger(target.externalId) ||
    target.externalId <= 0 ||
    !Number.isSafeInteger(target.installationId) ||
    target.installationId <= 0
  ) {
    throw new Error("fix_github_identity_invalid");
  }
  return { repository, target };
}

function githubProvider() {
  const environment = getEnvironment();
  return new GitHubAppRepositoryProvider({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
}

function deterministicAttemptUuid(fixRunId: string, stageId: string, attemptNumber: number) {
  const hex = createHash("sha256")
    .update(`${fixRunId}:generate_patch:${stageId}:${attemptNumber}`, "utf8")
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function codingModel() {
  const environment = getEnvironment();
  const {
    FIX_CODING_MODEL_PROVIDER,
    FIX_CODING_MODEL_NAME,
    FIX_CODING_MODEL_ENDPOINT,
    FIX_CODING_MODEL_API_KEY,
  } = environment;
  if (
    !FIX_CODING_MODEL_PROVIDER ||
    !FIX_CODING_MODEL_NAME ||
    !FIX_CODING_MODEL_ENDPOINT ||
    !FIX_CODING_MODEL_API_KEY
  )
    throw new Error("fix_coding_model_not_configured");
  return {
    provider: FIX_CODING_MODEL_PROVIDER,
    modelName: FIX_CODING_MODEL_NAME,
    model: new StructuredChatCompletionFixModel({
      provider: FIX_CODING_MODEL_PROVIDER,
      model: FIX_CODING_MODEL_NAME,
      endpoint: FIX_CODING_MODEL_ENDPOINT,
      apiKey: FIX_CODING_MODEL_API_KEY,
      schemaVersion: "fix-engine-v1",
      promptContractVersion: FIX_CODING_PROMPT_CONTRACT_VERSION,
    }),
  };
}

async function invokeCodingModel(
  input: {
    stage: "diagnose" | "plan" | "generate_patch";
    stageId: string;
    claimToken: string;
    attemptNumber: number;
    inputFingerprint: string;
    invoke: (model: FixCodingModel) => Promise<ModelEnvelope<unknown>>;
  },
  modelOverride?: FixCodingModel,
) {
  const client = createSupabaseServerClient();
  const configured = modelOverride
    ? { provider: modelOverride.provider, modelName: modelOverride.modelName, model: modelOverride }
    : codingModel();
  const { data: started, error: beginError } = await client.rpc("begin_fix_model_attempt", {
    p_stage_id: input.stageId,
    p_claim_token: input.claimToken,
    p_attempt_number: input.attemptNumber,
    p_provider: configured.provider,
    p_model: configured.modelName,
    p_schema_version: "fix-engine-v1",
    p_prompt_contract_version: FIX_CODING_PROMPT_CONTRACT_VERSION,
    p_input_fingerprint: input.inputFingerprint,
  });
  if (beginError || typeof started?.attemptId !== "string")
    throw new Error("fix_model_attempt_start_failed");
  const attemptId = started.attemptId;
  let envelope: ModelEnvelope<unknown>;
  try {
    envelope = await input.invoke(configured.model);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const category = /^[a-z0-9_]{1,100}$/.test(message) ? message : "fix_model_failed";
    const { error: finishError } = await client.rpc("finish_fix_model_attempt", {
      p_stage_id: input.stageId,
      p_claim_token: input.claimToken,
      p_attempt_id: attemptId,
      p_status:
        category.includes("ambiguous") || category.includes("timeout") ? "ambiguous" : "failed",
      p_model_version: null,
      p_output_fingerprint: null,
      p_latency_ms: null,
      p_input_tokens: null,
      p_output_tokens: null,
      p_cost_microusd: null,
      p_failure_category: category,
    });
    if (finishError) throw new Error("fix_model_attempt_finish_failed");
    throw new Error(category);
  }
  const { error: finishError } = await client.rpc("finish_fix_model_attempt", {
    p_stage_id: input.stageId,
    p_claim_token: input.claimToken,
    p_attempt_id: attemptId,
    p_status: "succeeded",
    p_model_version: envelope.modelVersion ?? null,
    p_output_fingerprint: envelope.outputFingerprint,
    p_latency_ms: envelope.usage.latencyMs,
    p_input_tokens: envelope.usage.inputTokens ?? null,
    p_output_tokens: envelope.usage.outputTokens ?? null,
    p_cost_microusd: envelope.usage.costMicrousd ?? null,
    p_failure_category: null,
  });
  if (finishError) throw new Error("fix_model_attempt_finish_failed");
  return envelope;
}

type FixRepositoryProvider = Pick<
  GitHubAppRepositoryProvider,
  "getFile" | "materializeRepository" | "getHead"
>;

async function loadModelContext(run: StoredRun, repositoryProvider?: FixRepositoryProvider) {
  const client = createSupabaseServerClient();
  const rawEdges = (await checked<GraphEdge[]>(
    client
      .from("impact_graph_edges")
      .select(
        "id,edge_type,edge_kind,evidence_type,code_reference_id,code_relation_id,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column",
      )
      .eq("graph_build_id", run.graph_build_id)
      .eq("workspace_id", run.workspace_id)
      .eq("repository_id", run.repository_id)
      .eq("commit_sha", run.commit_sha)
      .in("id", run.positive_graph_evidence_ids) as PromiseLike<DbResult<GraphEdge[]>>,
    "fix_graph_evidence_unavailable",
  )) as GraphEdge[];
  if (rawEdges.length !== run.positive_graph_evidence_ids.length)
    throw new Error("fix_graph_evidence_identity_mismatch");
  const edges = rawEdges.filter(
    (edge) =>
      edge.edge_kind === "observed" &&
      edge.evidence_path &&
      edge.evidence_start_line &&
      edge.evidence_start_column &&
      edge.evidence_end_line &&
      edge.evidence_end_column,
  );
  if (!edges.length) throw new Error("fix_exact_positive_evidence_missing");
  const referenceIds = [
    ...new Set(edges.flatMap((edge) => (edge.code_reference_id ? [edge.code_reference_id] : []))),
  ];
  const references = referenceIds.length
    ? await checked<CodeReferenceRow[]>(
        client
          .from("code_external_references")
          .select(
            "id,analysis_run_id,workspace_id,repository_id,commit_sha,normalized_value,path,start_line,end_line",
          )
          .eq("analysis_run_id", run.analysis_run_id)
          .eq("workspace_id", run.workspace_id)
          .eq("repository_id", run.repository_id)
          .eq("commit_sha", run.commit_sha)
          .in("id", referenceIds) as PromiseLike<DbResult<CodeReferenceRow[]>>,
        "fix_code_reference_unavailable",
      )
    : [];
  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  const { target, repository } = await loadRepository(run);
  if (
    `${repository.owner}/${repository.name}`.toLowerCase() !==
    run.provider_repository_identity.toLowerCase()
  )
    throw new Error("fix_repository_identity_mismatch");
  const provider = repositoryProvider ?? githubProvider();
  const graphEvidence = edges.map((edge) => {
    const reference = edge.code_reference_id ? referenceById.get(edge.code_reference_id) : null;
    if (
      reference &&
      (reference.path !== edge.evidence_path || reference.start_line !== edge.evidence_start_line)
    )
      throw new Error("fix_graph_reference_provenance_mismatch");
    return {
      id: edge.id,
      type: edge.evidence_type,
      externalEntity: reference?.normalized_value ?? edge.edge_type,
      path: edge.evidence_path!,
      span: {
        startLine: edge.evidence_start_line!,
        startColumn: edge.evidence_start_column!,
        endLine: edge.evidence_end_line!,
        endColumn: edge.evidence_end_column!,
      },
    };
  });
  const paths = [...new Set(graphEvidence.map((edge) => edge.path))].slice(0, 25);
  const files = await Promise.all(
    paths.map(async (filePath) => {
      const file = await provider.getFile(target, filePath, run.commit_sha);
      if (!file || file.size > 256_000 || !file.text)
        throw new Error("fix_pinned_source_file_unavailable");
      return { path: file.path, content: file.text };
    }),
  );
  const context = buildBoundedModelContext({
    semanticRoute: run.semantic_route,
    commitSha: run.commit_sha,
    graphEvidence,
    files,
  });
  return { context, graphEvidence, files, provider, target };
}

async function filesUnder(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (
      [".git", "node_modules", "dist", "build", ".next", "coverage"].includes(
        entry.name.toLowerCase(),
      )
    )
      continue;
    const absolute = path.join(current, entry.name);
    const info = await stat(absolute);
    if (info.isDirectory()) files.push(...(await filesUnder(root, absolute)));
    else if (info.isFile()) files.push(path.relative(root, absolute).replaceAll("\\", "/"));
  }
  return files.slice(0, 5000);
}

async function materializeForRun(
  run: StoredRun,
  checkoutPath: string,
  commitSha: string,
  repositoryProvider?: FixRepositoryProvider,
) {
  if (commitSha !== run.commit_sha) throw new Error("fix_snapshot_commit_mismatch");
  const { target, repository } = await loadRepository(run);
  if (
    `${repository.owner}/${repository.name}`.toLowerCase() !==
    run.provider_repository_identity.toLowerCase()
  )
    throw new Error("fix_repository_identity_mismatch");
  const exact = repositoryProvider ?? githubProvider();
  const snapshot = await exact.materializeRepository(target, commitSha, checkoutPath);
  return { skippedLinks: snapshot.skippedLinks };
}

async function loadCurrentDraftPrScope(run: StoredRun) {
  const client = createSupabaseServerClient();
  const [productResult, dependencyResult, mappingResult, policyResult] = await Promise.all([
    client
      .from("workspace_products")
      .select("id,status")
      .eq("id", run.product_id)
      .eq("workspace_id", run.workspace_id)
      .maybeSingle(),
    client
      .from("workspace_dependencies")
      .select("id,protected_product_id,monitoring_enabled")
      .eq("id", run.workspace_dependency_id)
      .eq("workspace_id", run.workspace_id)
      .eq("protected_product_id", run.product_id)
      .maybeSingle(),
    client
      .from("workspace_product_repositories")
      .select("id,status,repository_id,protected_product_id")
      .eq("id", run.product_repository_mapping_id)
      .eq("workspace_id", run.workspace_id)
      .eq("protected_product_id", run.product_id)
      .eq("repository_id", run.repository_id)
      .maybeSingle(),
    client
      .from("product_remediation_policies")
      .select("enabled,draft_pr_preparation_allowed,allowed_repository_ids")
      .eq("workspace_id", run.workspace_id)
      .eq("product_id", run.product_id)
      .maybeSingle(),
  ]);
  if (productResult.error || dependencyResult.error || mappingResult.error || policyResult.error)
    throw new Error("fix_current_pr_scope_unavailable");
  const product = productResult.data;
  const dependency = dependencyResult.data;
  const mapping = mappingResult.data;
  const policy = policyResult.data;
  if (
    product?.status !== "protected" ||
    dependency?.monitoring_enabled !== true ||
    mapping?.status !== "active" ||
    !run.draft_pr_policy_allowed ||
    policy?.enabled !== true ||
    policy.draft_pr_preparation_allowed !== true ||
    !Array.isArray(policy.allowed_repository_ids) ||
    !policy.allowed_repository_ids.includes(run.repository_id)
  ) {
    throw new Error("fix_current_pr_policy_denied");
  }
  return { productPolicyAllowsDraftPr: true, repositoryAllowlisted: true };
}

async function readChangedFilesFromAppliedPatch(input: {
  run: StoredRun;
  patch: PatchRow;
  plan: unknown;
  diff: string;
}): Promise<GitHubChangedFile[]> {
  const plan = FixPlanSchema.parse(input.plan);
  const allowed = new Set(plan.allowedFiles.map((file) => file.path));
  if (
    input.patch.changed_paths.length < 1 ||
    input.patch.changed_paths.some((path) => !allowed.has(path))
  )
    throw new Error("fix_patch_plan_scope_mismatch");
  return withExactBaseGitHubSnapshot({
    expectedBaseSha: input.run.commit_sha,
    materialize: (destination, commitSha) => materializeForRun(input.run, destination, commitSha),
    unifiedDiff: input.diff,
    run: async (checkoutPath) => {
      const root = path.resolve(checkoutPath);
      const changed: GitHubChangedFile[] = [];
      for (const filePath of input.patch.changed_paths) {
        const absolute = path.resolve(root, filePath);
        const relative = path.relative(root, absolute);
        if (!isSafeRepoPath(filePath) || relative.startsWith("..") || path.isAbsolute(relative))
          throw new Error("fix_patch_path_forbidden");
        try {
          const info = await lstat(absolute);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
            throw new Error("fix_patch_file_unsafe");
          const bytes = await readFile(absolute);
          const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          changed.push({ path: filePath, content });
        } catch (error) {
          if (
            !error ||
            typeof error !== "object" ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            if (error instanceof Error && error.message === "fix_patch_file_unsafe") throw error;
            throw new Error("fix_patch_file_unreadable");
          }
          changed.push({ path: filePath, deleted: true });
        }
      }
      validateDraftPrFiles(changed);
      return changed;
    },
  });
}

export type FixEngineStageProcessorDependencies = {
  model?: FixCodingModel;
  repositoryProvider?: FixRepositoryProvider;
  verificationExecutor?: VerificationExecutor;
  resolveRemoteDependencyCache?: (
    identity: DependencyCacheIdentity,
  ) => Promise<SignedDependencyCacheReference>;
  resolveDependencyCache?: (
    identity: DependencyCacheIdentity | null,
  ) => Promise<DependencyCacheResolution>;
};

export function createFixEngineStageProcessor(
  dependencies: FixEngineStageProcessorDependencies = {},
): FixStageProcessor {
  return async ({ run: stageRun, stage, stageId, claimToken, attemptNumber }) => {
    const run = await loadRun(stageRun.id);
    const client = createSupabaseServerClient();
    if (
      run.workspace_id !== stageRun.workspace_id ||
      run.repository_id !== stageRun.repository_id ||
      run.commit_sha !== stageRun.commit_sha
    )
      throw new Error("fix_stage_persisted_identity_mismatch");

    if (stage === "diagnose") {
      const { context, graphEvidence } = await loadModelContext(
        run,
        dependencies.repositoryProvider,
      );
      const envelope = await invokeCodingModel(
        {
          stage: "diagnose",
          stageId,
          claimToken,
          attemptNumber,
          inputFingerprint: stableFingerprint({
            stage: "diagnose",
            context: context.contextFingerprint,
          }),
          invoke: (model) => model.diagnose(context),
        },
        dependencies.model,
      );
      const validated = validateProposedDiagnosis({
        proposal: envelope.value,
        evidence: graphEvidence.map((edge) => ({ ...edge, symbol: null })),
        workspaceId: run.workspace_id,
        expectedWorkspaceId: stageRun.workspace_id,
        repositoryId: run.repository_id,
        expectedRepositoryId: stageRun.repository_id,
        commitSha: run.commit_sha,
        expectedCommitSha: stageRun.commit_sha,
      });
      return {
        recordKind: "diagnosis",
        record: {
          diagnosis: validated.diagnosis,
          evidenceIds: validated.evidenceIds,
          changeFamily: validated.diagnosis.changeFamily,
          provider: envelope.provider,
          model: envelope.model,
          modelVersion: envelope.modelVersion ?? null,
          schemaVersion: envelope.schemaVersion,
          promptContractVersion: envelope.promptContractVersion,
          inputFingerprint: envelope.inputFingerprint,
          outputFingerprint: validated.outputFingerprint,
          latencyMs: envelope.usage.latencyMs,
          inputTokens: envelope.usage.inputTokens ?? null,
          outputTokens: envelope.usage.outputTokens ?? null,
          costMicrousd: envelope.usage.costMicrousd ?? null,
        },
      };
    }

    if (stage === "plan") {
      const { context } = await loadModelContext(run, dependencies.repositoryProvider);
      const diagnosis = await checked<{ diagnosis: unknown }>(
        client
          .from("fix_diagnoses")
          .select("diagnosis")
          .eq("fix_run_id", run.id)
          .single() as PromiseLike<DbResult<{ diagnosis: unknown }>>,
        "fix_diagnosis_unavailable",
      );
      const parsedDiagnosis = DiagnosisSchema.parse(diagnosis.diagnosis);
      const envelope = await invokeCodingModel(
        {
          stage: "plan",
          stageId,
          claimToken,
          attemptNumber,
          inputFingerprint: stableFingerprint({
            stage: "plan",
            context: context.contextFingerprint,
            diagnosis: parsedDiagnosis,
          }),
          invoke: (model) => model.plan(context, parsedDiagnosis),
        },
        dependencies.model,
      );
      const plan = validateProposedFixPlan({
        proposal: envelope.value,
        diagnosis: parsedDiagnosis,
        preflightRequired: run.preflight_required,
        reviewRequired: run.review_disposition === "review_required",
      });
      return {
        recordKind: "plan",
        record: {
          plan,
          planVersion: 1,
          planFingerprint: stableFingerprint(plan),
          provider: envelope.provider,
          model: envelope.model,
          schemaVersion: envelope.schemaVersion,
          promptContractVersion: envelope.promptContractVersion,
        },
      };
    }

    if (stage === "generate_patch") {
      const { context } = await loadModelContext(run, dependencies.repositoryProvider);
      const [diagnosis, planRow] = await Promise.all([
        checked<{ diagnosis: unknown }>(
          client
            .from("fix_diagnoses")
            .select("diagnosis")
            .eq("fix_run_id", run.id)
            .single() as PromiseLike<DbResult<{ diagnosis: unknown }>>,
          "fix_diagnosis_unavailable",
        ),
        checked<PlanRow>(
          client
            .from("fix_plans")
            .select("id,plan,plan_fingerprint")
            .eq("fix_run_id", run.id)
            .single() as PromiseLike<DbResult<PlanRow>>,
          "fix_plan_unavailable",
        ),
      ]);
      const plan = FixPlanSchema.parse(planRow.plan);
      const parsedDiagnosis = DiagnosisSchema.parse(diagnosis.diagnosis);
      const envelope = await invokeCodingModel(
        {
          stage: "generate_patch",
          stageId,
          claimToken,
          attemptNumber,
          inputFingerprint: stableFingerprint({
            stage: "generate_patch",
            context: context.contextFingerprint,
            diagnosis: parsedDiagnosis,
            plan,
          }),
          invoke: (model) => model.proposePatch(context, parsedDiagnosis, plan),
        },
        dependencies.model,
      );
      const attemptId = deterministicAttemptUuid(run.id, stageId, attemptNumber);
      const proposal = hydratePatchProposal({
        proposal: envelope.value,
        expectedBaseSha: run.commit_sha,
        expectedPlanFingerprint: planRow.plan_fingerprint,
        expectedEvidenceFingerprint: run.evidence_fingerprint,
        attemptIdentity: attemptId,
      });
      const validated = validatePatchProposal({
        proposal,
        plan,
        expectedBaseSha: run.commit_sha,
        expectedPlanFingerprint: planRow.plan_fingerprint,
        expectedEvidenceFingerprint: run.evidence_fingerprint,
      });
      const artifact = await new SupabasePrivatePatchArtifactStore().put({
        fixRunId: run.id,
        attemptId,
        diff: validated.diff,
      });
      return {
        recordKind: "patch",
        record: {
          planId: planRow.id,
          attemptNumber,
          baseSha: run.commit_sha,
          patchFingerprint: validated.fingerprint,
          artifactPath: artifact.path,
          changedPaths: validated.changedPaths,
          lineCount: validated.changedLines,
          byteCount: artifact.byteCount,
          provider: envelope.provider,
          model: envelope.model,
        },
      };
    }

    if (stage === "apply_patch" || stage === "verify_patch") {
      const patch = await checked<PatchRow>(
        client
          .from("fix_patches")
          .select(
            "id,plan_id,base_sha,patch_fingerprint,artifact_path,changed_paths,line_count,byte_count,status,provider,model",
          )
          .eq("fix_run_id", run.id)
          .order("attempt_number", { ascending: false })
          .limit(1)
          .single() as PromiseLike<DbResult<PatchRow>>,
        "fix_patch_unavailable",
      );
      const diff = Buffer.from(
        await new SupabasePrivatePatchArtifactStore().get({ path: patch.artifact_path }),
      ).toString("utf8");
      const snapshotInput = {
        expectedBaseSha: run.commit_sha,
        materialize: (destination: string, commitSha: string) =>
          materializeForRun(run, destination, commitSha, dependencies.repositoryProvider),
        unifiedDiff: diff,
      };
      if (stage === "apply_patch") {
        await withExactBaseGitHubSnapshot({ ...snapshotInput, run: async () => undefined });
        return { recordKind: "patch", record: { planId: patch.plan_id, patchId: patch.id } };
      }
      const applied = await client
        .from("fix_patches")
        .select("status")
        .eq("id", patch.id)
        .eq("fix_run_id", run.id)
        .single();
      if (applied.error || applied.data?.status !== "applied")
        throw new Error("fix_patch_not_applied");
      const verificationExecutor =
        dependencies.verificationExecutor ?? createServerAuthoritativeVerificationExecutor();
      const planRow = await checked<{ id: string; plan: unknown; plan_fingerprint: string }>(
        client
          .from("fix_plans")
          .select("id,plan,plan_fingerprint")
          .eq("id", patch.plan_id)
          .eq("fix_run_id", run.id)
          .single() as PromiseLike<
          DbResult<{ id: string; plan: unknown; plan_fingerprint: string }>
        >,
        "fix_plan_unavailable",
      );
      const plan = FixPlanSchema.parse(planRow.plan);
      let snapshotArtifact: PrivateArtifactReference | null = null;
      const materialized = await withExactBaseGitHubSnapshot({
        ...snapshotInput,
        captureBaseSnapshot:
          verificationExecutor.kind === "remote"
            ? async (checkoutPath) => {
                snapshotArtifact = await createPrivateBaseSnapshotArtifact({
                  fixRunId: run.id,
                  checkoutPath,
                });
              }
            : undefined,
        run: async (checkoutPath) => {
          const names = await filesUnder(checkoutPath);
          let packageJson: unknown = {};
          let packageJsonText: string | null = null;
          if (names.includes("package.json")) {
            try {
              packageJsonText = await readFile(path.join(checkoutPath, "package.json"), "utf8");
              packageJson = JSON.parse(packageJsonText);
            } catch {
              throw new Error("verification_manifest_invalid");
            }
          }
          const lockfiles: Record<string, string> = {};
          for (const name of [
            "package-lock.json",
            "npm-shrinkwrap.json",
            "pnpm-lock.yaml",
            "yarn.lock",
          ])
            if (names.includes(name))
              lockfiles[name] = await readFile(path.join(checkoutPath, name), "utf8");
          const cacheIdentity = packageJsonText
            ? createDependencyCacheIdentity({
                repositoryId: run.repository_id,
                repositoryIdentity: run.provider_repository_identity,
                commitSha: run.commit_sha,
                packageJson: packageJsonText,
                lockfiles,
              })
            : null;
          let localDependencyCache: Awaited<
            ReturnType<typeof resolveTrustedDependencyCache>
          > | null = null;
          if (verificationExecutor.kind === "local_docker") {
            const environment = getEnvironment();
            localDependencyCache = dependencies.resolveDependencyCache
              ? await dependencies.resolveDependencyCache(cacheIdentity)
              : await resolveTrustedDependencyCache({
                  root: environment.FIX_DEPENDENCY_CACHE_ROOT,
                  publicKey: environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY,
                  identity: cacheIdentity,
                });
            if (localDependencyCache.status === "rejected")
              throw new Error(`fix_dependency_cache_${localDependencyCache.reason}`);
          }
          const profile = resolveVerificationProfile({
            packageJson,
            files: names,
            targetedTestPaths: plan.expectedTests,
            packageLock: lockfiles["package-lock.json"] ?? lockfiles["npm-shrinkwrap.json"],
            dependencyCacheAvailable:
              verificationExecutor.kind === "remote"
                ? cacheIdentity?.packageManager === "npm"
                : localDependencyCache?.status === "available",
          });
          if (profile.state !== "supported")
            return { status: "unsupported" as const, profile, checks: [] };
          let remote: RemoteVerificationInput | undefined;
          if (verificationExecutor.kind === "remote") {
            if (!cacheIdentity || cacheIdentity.packageManager !== "npm")
              throw new Error("verification_cache_profile_unsupported");
            const environment = getEnvironment();
            if (
              !dependencies.resolveRemoteDependencyCache &&
              !environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY
            )
              throw new Error("verification_cache_signature_invalid");
            if (!snapshotArtifact) throw new Error("verification_snapshot_not_available");
            const cachePublicKey = environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY;
            const [cache, patchReference] = await Promise.all([
              dependencies.resolveRemoteDependencyCache
                ? dependencies.resolveRemoteDependencyCache(cacheIdentity)
                : createSignedDependencyCacheReference({
                    identity: cacheIdentity,
                    publicKey: cachePublicKey!,
                  }),
              new SupabasePrivatePatchArtifactStore().createSignedReference({
                path: patch.artifact_path,
                sha256: patch.patch_fingerprint,
                byteCount: patch.byte_count,
              }),
            ]);
            remote = {
              workspaceId: run.workspace_id,
              productId: run.product_id,
              fixRunId: run.id,
              planId: planRow.id,
              planFingerprint: planRow.plan_fingerprint,
              evidenceFingerprint: run.evidence_fingerprint,
              patchId: patch.id,
              patchFingerprint: patch.patch_fingerprint,
              allowedPaths: plan.allowedFiles.map((file) => file.path),
              repositoryId: run.repository_id,
              repositoryIdentity: run.provider_repository_identity,
              baseCommitSha: run.commit_sha,
              dependencyCacheIdentity: cacheIdentity,
              cache,
              snapshot: snapshotArtifact,
              patch: patchReference,
            };
          } else {
            if (localDependencyCache?.status !== "available")
              return {
                status: "unsupported" as const,
                profile: {
                  ...profile,
                  state: "verification_unsupported" as const,
                  reason: "trusted_dependency_cache_unavailable",
                },
                checks: [],
              };
          }
          if (remote && snapshotArtifact) {
            await registerPrivateVerificationSnapshot({
              fixRunId: run.id,
              workspaceId: run.workspace_id,
              sha256: snapshotArtifact.sha256,
            });
          }
          try {
            const executed = await verificationExecutor.execute({
              checkoutPath,
              profile,
              commands: profile.commands,
              localDependencyCache:
                localDependencyCache?.status === "available" ? localDependencyCache : null,
              remote,
            });
            if (remote && snapshotArtifact) {
              await markPrivateVerificationSnapshotTerminal({
                fixRunId: run.id,
                workspaceId: run.workspace_id,
                sha256: snapshotArtifact.sha256,
              });
            }
            return {
              status: executed.status,
              profile,
              checks: executed.checks,
              durationMs: executed.durationMs,
            };
          } catch (error) {
            if (
              remote &&
              snapshotArtifact &&
              error instanceof VerificationRunnerFailure &&
              !error.retryable
            ) {
              await markPrivateVerificationSnapshotTerminal({
                fixRunId: run.id,
                workspaceId: run.workspace_id,
                sha256: snapshotArtifact.sha256,
              });
            }
            throw error;
          }
        },
      });
      const status = materialized.status === "passed" ? "passed" : materialized.status;
      return {
        recordKind: "verification",
        record: {
          patchId: patch.id,
          patchFingerprint: patch.patch_fingerprint,
          profileId: materialized.profile.id,
          status,
          checks: materialized.checks,
          diagnosticSummary:
            status === "unsupported"
              ? (materialized.profile.reason ?? "verification_unsupported")
              : "",
          durationMs: "durationMs" in materialized ? materialized.durationMs : 0,
          attemptNumber,
        },
      };
    }

    if (stage === "preflight") {
      if (run.provenance_mode === "evidence_only")
        throw new Error("evidence_only_preflight_forbidden");
      const patch = await checked<PatchRow>(
        client
          .from("fix_patches")
          .select("id,patch_fingerprint,status")
          .eq("fix_run_id", run.id)
          .eq("status", "applied")
          .order("attempt_number", { ascending: false })
          .limit(1)
          .single() as PromiseLike<DbResult<PatchRow>>,
        "fix_preflight_patch_unavailable",
      );
      const { target, repository } = await loadRepository(run);
      if (
        `${repository.owner}/${repository.name}`.toLowerCase() !==
        run.provider_repository_identity.toLowerCase()
      )
        throw new Error("fix_repository_identity_mismatch");
      const currentSha = await githubProvider().getHead(target);
      if (currentSha.toLowerCase() !== run.commit_sha.toLowerCase()) throw new Error("stale_base");
      const result = await runCanonicalFixPreflight({
        workspaceId: run.workspace_id,
        workspaceDependencyId: run.workspace_dependency_id,
        classificationId: run.classification_id,
        repositoryId: run.repository_id,
        baseSha: run.commit_sha,
        provenanceMode: run.provenance_mode,
      });
      return {
        recordKind: "preflight",
        record: {
          patchId: patch.id,
          patchFingerprint: patch.patch_fingerprint,
          status: result.status,
          preflightRunId: result.preflightRunId,
          failureCategory: result.category,
        },
      };
    }

    if (stage === "risk_assess") {
      const RiskPatchRow = {
        changed_paths: [] as string[],
        line_count: 0,
        plan_id: "",
        id: "",
        patch_fingerprint: "",
      };
      type RiskPatchRow = typeof RiskPatchRow;
      const patch = await checked<RiskPatchRow>(
        client
          .from("fix_patches")
          .select("changed_paths,line_count,plan_id,id,patch_fingerprint")
          .eq("fix_run_id", run.id)
          .eq("status", "applied")
          .single() as PromiseLike<DbResult<RiskPatchRow>>,
        "fix_applied_patch_unavailable",
      );
      const [planRow, verification, preflight] = await Promise.all([
        checked<{ plan: unknown }>(
          client.from("fix_plans").select("plan").eq("id", patch.plan_id).single() as PromiseLike<
            DbResult<{ plan: unknown }>
          >,
          "fix_plan_unavailable",
        ),
        checked<{ status: string }>(
          client
            .from("fix_verification_runs")
            .select("status")
            .eq("fix_run_id", run.id)
            .eq("patch_id", patch.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .single() as PromiseLike<DbResult<{ status: string }>>,
          "fix_verification_unavailable",
        ),
        run.preflight_required
          ? checked<{ status: string }>(
              client
                .from("fix_preflight_results")
                .select("status")
                .eq("fix_run_id", run.id)
                .eq("patch_id", patch.id)
                .single() as PromiseLike<DbResult<{ status: string }>>,
              "fix_preflight_unavailable",
            )
          : Promise.resolve({ status: "not_applicable" }),
      ]);
      const plan = FixPlanSchema.parse(planRow.plan);
      const risk = assessFixRisk({
        changedPaths: patch.changed_paths,
        changedLines: patch.line_count,
        dependencyChanges: plan.dependencyChanges.length,
        verification:
          verification.status === "passed"
            ? "passed"
            : verification.status === "unsupported"
              ? "unsupported"
              : "failed",
        preflightRequired: run.preflight_required,
        preflight: run.preflight_required
          ? preflight.status === "passed"
            ? "passed"
            : "failed"
          : "not_applicable",
        reviewDisposition: run.review_disposition,
        provenanceMode: run.provenance_mode,
        staleBase: false,
        conflict: false,
      });
      return {
        recordKind: "risk",
        record: {
          riskVersion: risk.version,
          riskLevel: risk.level,
          factors: risk.factors,
          inputFingerprint: stableFingerprint({
            run: run.id,
            patch: patch.patch_fingerprint,
            verification: verification.status,
            risk,
          }),
        },
      };
    }

    if (stage === "create_draft_pr") {
      const environment = getEnvironment();
      if (environment.FIX_GITHUB_DRAFT_PR_WRITES !== "1")
        throw new Error("github_draft_pr_writes_disabled");
      if (
        run.source_mode !== "provider" ||
        run.processing_mode !== "customer" ||
        run.provenance_mode !== "customer" ||
        run.status !== "creating_pr"
      ) {
        throw new Error("fix_draft_pr_provenance_or_state_invalid");
      }
      const currentScope = await loadCurrentDraftPrScope(run);
      const patch = await checked<PatchRow>(
        client
          .from("fix_patches")
          .select(
            "id,plan_id,base_sha,patch_fingerprint,artifact_path,changed_paths,line_count,byte_count,status,provider,model",
          )
          .eq("fix_run_id", run.id)
          .eq("status", "applied")
          .order("attempt_number", { ascending: false })
          .limit(1)
          .single() as PromiseLike<DbResult<PatchRow>>,
        "fix_applied_patch_unavailable",
      );
      if (patch.base_sha !== run.commit_sha) throw new Error("stale_base");
      const [planRow, verification, persistedRisk, preflight] = await Promise.all([
        checked<{ plan: unknown }>(
          client
            .from("fix_plans")
            .select("plan")
            .eq("id", patch.plan_id)
            .eq("fix_run_id", run.id)
            .single() as PromiseLike<DbResult<{ plan: unknown }>>,
          "fix_plan_unavailable",
        ),
        checked<{ status: string; patch_fingerprint: string }>(
          client
            .from("fix_verification_runs")
            .select("status,patch_fingerprint")
            .eq("fix_run_id", run.id)
            .eq("patch_id", patch.id)
            .order("created_at", { ascending: false })
            .limit(1)
            .single() as PromiseLike<DbResult<{ status: string; patch_fingerprint: string }>>,
          "fix_verification_unavailable",
        ),
        checked<{ risk_level: string; factors: string[]; input_fingerprint: string }>(
          client
            .from("fix_risk_assessments")
            .select("risk_level,factors,input_fingerprint")
            .eq("fix_run_id", run.id)
            .single() as PromiseLike<
            DbResult<{ risk_level: string; factors: string[]; input_fingerprint: string }>
          >,
          "fix_risk_assessment_unavailable",
        ),
        run.preflight_required
          ? checked<{ status: string; patch_id: string; patch_fingerprint: string }>(
              client
                .from("fix_preflight_results")
                .select("status,patch_id,patch_fingerprint")
                .eq("fix_run_id", run.id)
                .eq("patch_id", patch.id)
                .single() as PromiseLike<
                DbResult<{ status: string; patch_id: string; patch_fingerprint: string }>
              >,
              "fix_preflight_unavailable",
            )
          : Promise.resolve({
              status: "not_applicable",
              patch_id: patch.id,
              patch_fingerprint: patch.patch_fingerprint,
            }),
      ]);
      if (
        verification.patch_fingerprint !== patch.patch_fingerprint ||
        preflight.patch_id !== patch.id ||
        preflight.patch_fingerprint !== patch.patch_fingerprint
      ) {
        throw new Error("fix_pr_verification_identity_mismatch");
      }
      const plan = FixPlanSchema.parse(planRow.plan);
      const recomputedRisk = assessFixRisk({
        changedPaths: patch.changed_paths,
        changedLines: patch.line_count,
        dependencyChanges: plan.dependencyChanges.length,
        verification:
          verification.status === "passed"
            ? "passed"
            : verification.status === "unsupported"
              ? "unsupported"
              : "failed",
        preflightRequired: run.preflight_required,
        preflight: run.preflight_required
          ? preflight.status === "passed"
            ? "passed"
            : "failed"
          : "not_applicable",
        reviewDisposition: run.review_disposition,
        provenanceMode: run.provenance_mode,
        staleBase: false,
        conflict: false,
      });
      const riskInputFingerprint = stableFingerprint({
        run: run.id,
        patch: patch.patch_fingerprint,
        verification: verification.status,
        risk: recomputedRisk,
      });
      if (
        persistedRisk.risk_level !== recomputedRisk.level ||
        persistedRisk.input_fingerprint !== riskInputFingerprint ||
        JSON.stringify(persistedRisk.factors) !== JSON.stringify(recomputedRisk.factors) ||
        !["LOW", "MEDIUM"].includes(recomputedRisk.level) ||
        !recomputedRisk.draftPrEligible
      ) {
        throw new Error("draft_pr_risk_blocked");
      }

      const { target, repository } = await loadRepository(run);
      if (
        `${repository.owner}/${repository.name}`.toLowerCase() !==
        run.provider_repository_identity.toLowerCase()
      ) {
        throw new Error("fix_repository_identity_mismatch");
      }
      const readProvider = githubProvider();
      const currentDefaultBranchSha = await readProvider.getHead(target);
      const eligibilityBase = {
        provenanceMode: run.provenance_mode,
        productPolicyAllowsDraftPr: currentScope.productPolicyAllowsDraftPr,
        repositoryAllowlisted: currentScope.repositoryAllowlisted,
        installationRepositoryIdentity: `${repository.owner}/${repository.name}`,
        repositoryIdentity: `${repository.owner}/${repository.name}`,
        permissions: { contents: "write" as const, pull_requests: "write" as const },
        risk: recomputedRisk,
        verificationPassed: verification.status === "passed",
        preflightRequired: run.preflight_required,
        preflightPassed: preflight.status === "passed",
        baseSha: run.commit_sha,
        currentDefaultBranchSha,
        unresolvedExternalOperation: false,
        reviewDisposition: run.review_disposition,
        reviewReason: run.review_reason,
      };
      assertDraftPrEligible(eligibilityBase);

      const diff = Buffer.from(
        await new SupabasePrivatePatchArtifactStore().get({ path: patch.artifact_path }),
      ).toString("utf8");
      const changedFiles = await readChangedFilesFromAppliedPatch({ run, patch, plan, diff });
      const repositoryIdentity = `${repository.owner}/${repository.name}`;
      if (!environment.GITHUB_APP_ID || !environment.GITHUB_APP_PRIVATE_KEY)
        throw new Error("github_write_app_configuration_missing");
      const scopedToken = await createScopedGitHubWriteToken({
        appId: environment.GITHUB_APP_ID,
        privateKey: environment.GITHUB_APP_PRIVATE_KEY,
        installationId: target.installationId,
        repositoryId: target.externalId,
        owner: repository.owner,
        repository: repository.name,
      });
      const provider = new GitHubAppDraftPRProvider({
        installationToken: async () => scopedToken.token,
        verifiedGrant: {
          repositoryIdentity: scopedToken.repositoryIdentity,
          installationRepositoryIdentity: scopedToken.repositoryIdentity,
          permissions: scopedToken.permissions,
        },
      });
      const eligibility = {
        ...eligibilityBase,
        installationRepositoryIdentity: scopedToken.repositoryIdentity,
        permissions: scopedToken.permissions,
      };
      assertDraftPrEligible(eligibility);
      const requestFingerprint = stableFingerprint({
        fixRunIdentity: run.idempotency_key,
        repositoryIdentity,
        baseSha: run.commit_sha,
        patchFingerprint: patch.patch_fingerprint,
        changedFiles: changedFiles.map((file) => ({
          path: file.path,
          deleted: file.deleted === true,
          contentFingerprint: file.content === undefined ? null : stableFingerprint(file.content),
        })),
      });
      const operationKey = externalOperationKey(
        run.idempotency_key,
        "github_draft_pr",
        requestFingerprint,
      );
      const operation = await executeReconciledOperation({
        store: new SupabaseExternalOperationStore({
          fixRunId: run.id,
          stageId,
          claimToken,
        }),
        key: operationKey,
        operationKind: "github_draft_pr",
        requestFingerprint,
        reconcile: () =>
          provider.reconcileDraft({
            owner: repository.owner,
            repository: repository.name,
            defaultBranch: repository.default_branch,
            baseSha: run.commit_sha,
            identityKey: run.idempotency_key,
            changedFiles,
            eligibility,
          }),
        execute: () =>
          provider.createDraft({
            owner: repository.owner,
            repository: repository.name,
            defaultBranch: repository.default_branch,
            baseSha: run.commit_sha,
            identityKey: run.idempotency_key,
            changedFiles,
            eligibility,
          }),
        externalId: (result) => result.headSha,
        externalUrl: (result) => result.url,
        safeToResumeAfterMissingReconciliation: true,
      });
      const result = operation.result;
      const expectedBranch = deterministicFixBranch(run.idempotency_key);
      let pullUrl: URL | null = null;
      try {
        pullUrl = new URL(result.url);
      } catch {
        pullUrl = null;
      }
      const pullPath = pullUrl?.pathname.split("/") ?? [];
      if (
        result.branch !== expectedBranch ||
        !/^[a-f0-9]{40,64}$/i.test(result.headSha) ||
        pullUrl?.origin !== "https://github.com" ||
        pullUrl.search !== "" ||
        pullUrl.hash !== "" ||
        pullPath.length !== 5 ||
        pullPath[1]?.toLowerCase() !== repository.owner.toLowerCase() ||
        pullPath[2]?.toLowerCase() !== repository.name.toLowerCase() ||
        pullPath[3] !== "pull" ||
        !/^[1-9][0-9]*$/.test(pullPath[4] ?? "")
      ) {
        throw new Error("github_draft_pr_result_identity_invalid");
      }
      return {
        recordKind: "pr_outcome",
        record: {
          externalOperationId: operation.operationId,
          status: result.reconciled ? "reconciled_existing" : "draft_created",
          branchName: result.branch,
          pullRequestUrl: result.url,
          baseSha: run.commit_sha,
          headSha: result.headSha,
        },
      };
    }
    throw new Error("fix_stage_unsupported");
  };
}

export const processFixEngineStage: FixStageProcessor = createFixEngineStageProcessor();
