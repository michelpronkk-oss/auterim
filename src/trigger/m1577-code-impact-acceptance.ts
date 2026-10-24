import { AbortTaskRunError, schemaTask, tasks, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  applyClassificationPolicy,
  buildEvidencePacket,
  OpenAIClassifierError,
  OpenAISemanticClassifier,
} from "@/lib/monitoring/classification";
import { persistInternalTestSourceChange } from "@/lib/monitoring/internal-test-source";
import { buildIntelligenceEvidence } from "@/lib/intelligence/evidence";
import { evaluateWithReadinessGate } from "@/lib/intelligence/decision";
import {
  CALIBRATED_ACTIVE_THRESHOLDS,
  INTELLIGENCE_ACTIVE_POLICY_VERSION,
  activeCalibrationIsReady,
} from "@/lib/intelligence/calibration";
import {
  JevDecisionError,
  JEV_MODEL,
  JEV_PROVIDER,
  requestJevDecision,
} from "@/lib/intelligence/jev";
import { normalizeChangedEntity } from "@/lib/code-intelligence/endpoint";
import type { semanticClassifyChangeTask } from "@/trigger/classify-source-change";
import type { evaluateSourceChangeIntelligenceTask } from "@/trigger/evaluate-source-change-intelligence";
import type { routeSourceChangeIntelligenceTask } from "@/trigger/route-source-change-intelligence";

const WORKSPACE_ID = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
const PRODUCT_ID = "de1f2a12-de3c-4644-8892-b6c2d458a300";
const DEPENDENCY_ID = "3cfb1bb7-1d76-4692-932b-24e94b66f346";
const WORKSPACE_DEPENDENCY_ID = "867eb92b-2ed2-4917-ac68-44a22773e369";
const REPOSITORY_ID = "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4";
const SOURCE_CHANGE_ID = "01e13215-1043-4190-8d8b-10d562f59697";
const PROJECT_REF = "lnljaacbptrubppoypaz";
const ACCEPTANCE_KEY = "m1577-openai-endpoint-evidence-v1";
const ENDPOINT = "https://api.openai.com/v1/responses";

const InputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_acceptance") }).strict(),
  z.object({ action: z.literal("readback") }).strict(),
]);

type ExistingEvidence = {
  sourceChangeId: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  sourceUrl: string;
  sourceMode: string;
  processingMode: string;
  dependencyName: string;
  beforeVersion: number;
  afterVersion: number;
  baseline: string;
  changed: string;
  diffText: string;
  addedLines: number;
  removedLines: number;
  diffTruncated: boolean;
  beforeBytes: number;
  afterBytes: number;
};

export const m1577CodeImpactAcceptanceTask = schemaTask({
  id: "m1577-code-impact-acceptance",
  schema: InputSchema,
  retry: { maxAttempts: 1 },
  maxDuration: 900,
  concurrency: { total: 1 },
  run: async ({ action }) => {
    const client = createSupabaseServerClient();
    try {
      assertAuthorizedRuntime();
      if (action === "start_acceptance") {
        await assertProtectedTarget(client);
        const evidence = await readExistingEvidence(client);
        const qualification = await qualify(client, evidence);
        if (!qualification.passed) return { ...qualification, sourceCreated: false };
        const internalChange = await createOrReuseInternalSource(client, evidence);
        const changeId = internalChange.sourceChangeId;

        await tasks.trigger<typeof semanticClassifyChangeTask>(
          "classify-source-change",
          { sourceChangeId: changeId },
          { idempotencyKey: `m1577-classify:${changeId}` },
        );
        const classification = await waitForClassification(client, changeId);
        if (classification.status !== "classified")
          return safeBlocked("classifier_not_completed", {
            sourceId: internalChange.sourceId,
            sourceChangeId: changeId,
          });

        await tasks.trigger<typeof evaluateSourceChangeIntelligenceTask>(
          "evaluate-source-change-intelligence",
          { sourceChangeId: changeId },
          { idempotencyKey: `m1577-intelligence:${changeId}` },
        );
        const decision = await waitForDecision(client, changeId);
        if (
          decision.status !== "completed" ||
          decision.proposed_policy_state !== "continue_candidate" ||
          decision.policy_mode !== "active_calibrated" ||
          decision.active_policy_version !== INTELLIGENCE_ACTIVE_POLICY_VERSION
        )
          return safeBlocked("persisted_intelligence_policy_not_eligible", {
            sourceId: internalChange.sourceId,
            sourceChangeId: changeId,
            classifier: safeClassification(classification),
          });

        const route = await waitForRouteIntent(client, changeId);
        if (
          route.intelligence_decision_id !== decision.id ||
          route.route !== decision.proposed_route ||
          route.policy_state !== decision.proposed_policy_state ||
          route.policy_version !== decision.active_policy_version ||
          route.review_disposition !== decision.review_disposition ||
          route.review_reason !== decision.review_reason
        ) {
          return safeBlocked("route_decision_provenance_mismatch", {
            sourceId: internalChange.sourceId,
            sourceChangeId: changeId,
            classifier: safeClassification(classification),
            intelligence: safeDecision(decision),
          });
        }
        return {
          status: "acceptance_dispatched",
          qualification: qualification.safeResult,
          source: {
            sourceId: internalChange.sourceId,
            sourceChangeId: changeId,
            sourceMode: "internal_test",
            processingMode: "evidence_only",
            reused: internalChange.reused,
          },
          classifier: safeClassification(classification),
          intelligence: safeDecision(decision),
          route: safeRoute(route),
          customerImpactDispatched: false,
          preflightDispatched: false,
          notificationDispatched: false,
          remediationDispatched: false,
          autoPrCreated: false,
          deploymentActionDispatched: false,
          billingTouched: false,
        };
      }
      return await readback(client);
    } catch (error) {
      if (error instanceof AbortTaskRunError) throw error;
      return {
        status: "blocked",
        category: safeCategory(error),
        sourceCreated: false,
        customerImpactDispatched: false,
        preflightDispatched: false,
        notificationDispatched: false,
        remediationDispatched: false,
        autoPrCreated: false,
        deploymentActionDispatched: false,
        billingTouched: false,
      };
    }
  },
});

function assertAuthorizedRuntime() {
  const environment = getEnvironment();
  let url: URL;
  try {
    url = new URL(environment.NEXT_PUBLIC_SUPABASE_URL!);
  } catch {
    throw new AbortTaskRunError("Authorized Supabase binding unavailable");
  }
  if (
    url.hostname !== `${PROJECT_REF}.supabase.co` ||
    environment.AUTERIM_CLASSIFIER_PROVIDER !== "openai" ||
    !environment.AUTERIM_CLASSIFIER_MODEL ||
    !environment.OPENAI_API_KEY ||
    !environment.OPENROUTER_API_KEY ||
    environment.AUTERIM_INTELLIGENCE_PROVIDER !== JEV_PROVIDER ||
    environment.AUTERIM_INTELLIGENCE_MODEL !== JEV_MODEL ||
    environment.AUTERIM_INTELLIGENCE_ROUTER_ENABLED !== "1" ||
    !activeCalibrationIsReady()
  ) {
    throw new AbortTaskRunError("Authorized acceptance configuration unavailable");
  }
}

async function readExistingEvidence(client: ReturnType<typeof createSupabaseServerClient>) {
  const { data: change, error } = await client
    .from("source_changes")
    .select(
      "id,source_id,source_mode,processing_mode,workspace_id,scope_product_id,previous_snapshot_id,new_snapshot_id,diff_text,added_lines,removed_lines,diff_truncated,previous_bytes,new_bytes",
    )
    .eq("id", SOURCE_CHANGE_ID)
    .maybeSingle();
  if (error || !change) throw new Error("pinned_source_change_unavailable");
  if (
    change.source_mode !== "provider" ||
    change.processing_mode !== "customer" ||
    change.workspace_id !== null ||
    change.scope_product_id !== null
  ) {
    throw new Error("pinned_source_change_provenance_invalid");
  }

  const { data: source, error: sourceError } = await client
    .from("source_catalog")
    .select(
      "id,dependency_id,name,source_type,url,source_mode,processing_mode,workspace_id,scope_product_id",
    )
    .eq("id", change.source_id)
    .eq("dependency_id", DEPENDENCY_ID)
    .maybeSingle();
  if (
    sourceError ||
    !source ||
    source.source_mode !== "provider" ||
    source.processing_mode !== "customer" ||
    source.workspace_id !== null ||
    source.scope_product_id !== null
  ) {
    throw new Error("pinned_openai_provider_source_unavailable");
  }

  const { data: snapshots, error: snapshotError } = await client
    .from("source_snapshots")
    .select("id,source_id,version,normalized_content,content_hash")
    .in("id", [change.previous_snapshot_id, change.new_snapshot_id])
    .eq("source_id", source.id);
  if (snapshotError || !snapshots || snapshots.length !== 2)
    throw new Error("pinned_source_snapshots_unavailable");
  const previous = snapshots.find((snapshot) => snapshot.id === change.previous_snapshot_id);
  const current = snapshots.find((snapshot) => snapshot.id === change.new_snapshot_id);
  if (!previous || !current || previous.id === current.id)
    throw new Error("pinned_source_snapshot_identity_invalid");

  const { data: dependency, error: dependencyError } = await client
    .from("dependency_catalog")
    .select("id,name")
    .eq("id", DEPENDENCY_ID)
    .maybeSingle();
  if (dependencyError || !dependency?.name) throw new Error("pinned_dependency_unavailable");

  return {
    sourceChangeId: change.id,
    sourceId: source.id,
    sourceName: source.name,
    sourceType: source.source_type,
    sourceUrl: source.url,
    sourceMode: source.source_mode,
    processingMode: source.processing_mode,
    dependencyName: dependency.name,
    beforeVersion: previous.version,
    afterVersion: current.version,
    baseline: previous.normalized_content,
    changed: current.normalized_content,
    diffText: change.diff_text,
    addedLines: change.added_lines,
    removedLines: change.removed_lines,
    diffTruncated: change.diff_truncated,
    beforeBytes: change.previous_bytes,
    afterBytes: change.new_bytes,
  } satisfies ExistingEvidence;
}

async function qualify(
  client: ReturnType<typeof createSupabaseServerClient>,
  existingEvidence?: ExistingEvidence,
) {
  let evidence = existingEvidence;
  if (!evidence) {
    try {
      evidence = await readExistingEvidence(client);
    } catch (error) {
      return { passed: false, status: "qualification_blocked", category: safeCategory(error) };
    }
  }
  const change = toClassificationChange(evidence);
  const packet = buildEvidencePacket(change);
  const environment = getEnvironment();
  const classifier = new OpenAISemanticClassifier(
    environment.AUTERIM_CLASSIFIER_MODEL!,
    environment.OPENAI_API_KEY!,
  );

  let classification;
  try {
    const result = await classifier.classify(packet);
    const allEvidence = `${packet.previousEvidence}\n${packet.currentEvidence}`;
    const grounded = result.classification.evidence.every((item) =>
      item.type === "added"
        ? packet.currentEvidence.includes(item.excerpt)
        : item.type === "removed"
          ? packet.previousEvidence.includes(item.excerpt)
          : allEvidence.includes(item.excerpt),
    );
    if (!grounded)
      return {
        passed: false,
        status: "qualification_blocked",
        category: "classifier_evidence_ungrounded",
      };
    classification = applyClassificationPolicy(result.classification, packet.diffTruncated);
  } catch (error) {
    return {
      passed: false,
      status: "qualification_blocked",
      category:
        error instanceof OpenAIClassifierError
          ? `classifier_${error.category}`
          : "classifier_provider_error",
    };
  }

  const intelligenceEvidence = buildIntelligenceEvidence(change);
  let judgment;
  try {
    judgment = await requestJevDecision(intelligenceEvidence);
  } catch (error) {
    return {
      passed: false,
      status: "qualification_blocked",
      category: error instanceof JevDecisionError ? `jev_${error.category}` : "jev_provider_error",
    };
  }

  const policy = evaluateWithReadinessGate({
    classifier: {
      material: classification.material,
      category: classification.category,
      confidence: classification.confidence,
      decisionStatus: classification.decisionStatus,
    },
    judgment,
    evidenceQuality: intelligenceEvidence.quality,
    thresholds: CALIBRATED_ACTIVE_THRESHOLDS,
    activeReady: activeCalibrationIsReady(),
  });
  const exactEndpointCandidates = classification.affectedEntities
    .map(normalizeChangedEntity)
    .filter((entity) => entity.kind === "endpoint")
    .map((entity) => ({
      endpoint: entity.value,
      method: entity.method,
      original: entity.original,
    }));
  const evidenceSufficient =
    judgment.probabilities.evidenceSufficient >= CALIBRATED_ACTIVE_THRESHOLDS.evidenceSufficient;
  const passed =
    classification.material &&
    classification.decisionStatus === "classified" &&
    evidenceSufficient &&
    judgment.route !== "uncertain" &&
    policy.state === "continue_candidate" &&
    exactEndpointCandidates.some((candidate) => candidate.endpoint === ENDPOINT);
  const safeResult = {
    sourceChangeId: evidence.sourceChangeId,
    classifier: {
      provider: classifier.providerId,
      model: classifier.modelId,
      material: classification.material,
      category: classification.category,
      confidence: classification.confidence,
      status: classification.decisionStatus,
      exactEndpointCandidates,
    },
    jev: {
      provider: JEV_PROVIDER,
      model: JEV_MODEL,
      responseModel: judgment.responseModel,
      route: judgment.route,
      confidence: judgment.confidence,
      materialProbability: judgment.probabilities.material,
      criticalProbability: judgment.probabilities.criticalChange,
      evidenceSufficientProbability: judgment.probabilities.evidenceSufficient,
      docsNoiseProbability: judgment.probabilities.docsNoise,
      escalationProbability: judgment.probabilities.requiresEscalation,
      routeProbabilities: judgment.probabilities.route,
    },
    policy: {
      version: INTELLIGENCE_ACTIVE_POLICY_VERSION,
      route: policy.route,
      analysisDisposition: policy.state,
      reviewDisposition: policy.reviewDisposition,
      reviewReason: policy.reviewReason,
      reason: policy.reason,
    },
    evidenceSufficient,
  };
  return {
    passed,
    status: passed ? "qualified" : "qualification_blocked",
    category: passed ? undefined : "real_model_qualification_failed",
    persisted: false,
    dispatched: false,
    safeResult,
  };
}

function toClassificationChange(evidence: ExistingEvidence) {
  return {
    sourceName: evidence.sourceName,
    sourceType: evidence.sourceType,
    sourceUrl: evidence.sourceUrl,
    dependencyName: evidence.dependencyName,
    beforeVersion: evidence.beforeVersion,
    afterVersion: evidence.afterVersion,
    diffText: evidence.diffText,
    addedLines: evidence.addedLines,
    removedLines: evidence.removedLines,
    diffTruncated: evidence.diffTruncated,
    beforeBytes: evidence.beforeBytes,
    afterBytes: evidence.afterBytes,
  };
}

async function assertProtectedTarget(client: ReturnType<typeof createSupabaseServerClient>) {
  const { data: product, error: productError } = await client
    .from("workspace_products")
    .select("id,workspace_id,status")
    .eq("id", PRODUCT_ID)
    .eq("workspace_id", WORKSPACE_ID)
    .eq("status", "protected")
    .maybeSingle();
  if (productError || !product) throw new Error("test_product_not_protected");

  const { data: dependency, error: dependencyError } = await client
    .from("workspace_dependencies")
    .select("id,workspace_id,dependency_id,protected_product_id,monitoring_enabled")
    .eq("id", WORKSPACE_DEPENDENCY_ID)
    .eq("workspace_id", WORKSPACE_ID)
    .eq("dependency_id", DEPENDENCY_ID)
    .eq("protected_product_id", PRODUCT_ID)
    .eq("monitoring_enabled", true)
    .maybeSingle();
  if (dependencyError || !dependency) throw new Error("test_dependency_not_active");

  const { data: repo, error: repoError } = await client
    .from("repositories")
    .select("id,workspace_id,owner,name,status")
    .eq("id", REPOSITORY_ID)
    .eq("workspace_id", WORKSPACE_ID)
    .eq("owner", "michelpronkk-oss")
    .eq("name", "auterim")
    .eq("status", "available")
    .maybeSingle();
  if (repoError || !repo) throw new Error("test_repository_unavailable");

  const { data: mapping, error: mappingError } = await client
    .from("workspace_product_repositories")
    .select("workspace_id,protected_product_id,repository_id,status")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("protected_product_id", PRODUCT_ID)
    .eq("repository_id", REPOSITORY_ID)
    .eq("status", "active")
    .maybeSingle();
  if (mappingError || !mapping) throw new Error("test_product_repository_mapping_unavailable");
}

async function createOrReuseInternalSource(
  client: ReturnType<typeof createSupabaseServerClient>,
  evidence: ExistingEvidence,
) {
  const { data: sources, error } = await client
    .from("source_catalog")
    .select("id,workspace_id,scope_product_id,dependency_id,source_mode,processing_mode")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("scope_product_id", PRODUCT_ID)
    .eq("dependency_id", DEPENDENCY_ID)
    .eq("source_mode", "internal_test")
    .eq("processing_mode", "evidence_only");
  if (error || !sources) throw new Error("internal_source_readback_unavailable");
  if (sources.length > 1) throw new Error("internal_source_scope_ambiguous");

  if (sources.length === 1) {
    const source = sources[0]!;
    const { data: changes, error: changesError } = await client
      .from("source_changes")
      .select("id,previous_snapshot_id,new_snapshot_id")
      .eq("source_id", source.id);
    if (changesError || !changes) throw new Error("internal_source_changes_unavailable");
    if (changes.length !== 1) throw new Error("internal_source_change_not_unique");
    const change = changes[0]!;
    const { data: snapshots, error: snapshotsError } = await client
      .from("source_snapshots")
      .select("id,source_id,normalized_content")
      .in("id", [change.previous_snapshot_id, change.new_snapshot_id])
      .eq("source_id", source.id);
    if (
      snapshotsError ||
      !snapshots ||
      snapshots.length !== 2 ||
      snapshots.find((item) => item.id === change.previous_snapshot_id)?.normalized_content !==
        evidence.baseline ||
      snapshots.find((item) => item.id === change.new_snapshot_id)?.normalized_content !==
        evidence.changed
    ) {
      throw new Error("existing_internal_source_evidence_mismatch");
    }
    return { sourceId: source.id, sourceChangeId: change.id, reused: true };
  }

  const created = await persistInternalTestSourceChange({
    workspaceId: WORKSPACE_ID,
    productId: PRODUCT_ID,
    dependencyId: DEPENDENCY_ID,
    acceptanceKey: ACCEPTANCE_KEY,
    baseline: evidence.baseline,
    changed: evidence.changed,
  });
  return { sourceId: created.sourceId, sourceChangeId: created.sourceChangeId, reused: false };
}

async function waitForClassification(
  client: ReturnType<typeof createSupabaseServerClient>,
  changeId: string,
) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const { data, error } = await client
      .from("source_change_classifications")
      .select(
        "id,change_id,classifier_version,provider,model,status,material,category,affected_entities,confidence,decision_status,error_category",
      )
      .eq("change_id", changeId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("classification_readback_unavailable");
    if (data?.status === "classified" || data?.status === "failed") return data;
    await wait.for({ seconds: 5 });
  }
  throw new Error("classification_wait_bound_exceeded");
}

async function waitForDecision(
  client: ReturnType<typeof createSupabaseServerClient>,
  changeId: string,
) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const { data, error } = await client
      .from("change_intelligence_decisions")
      .select(
        "id,source_change_id,policy_version,active_policy_version,policy_mode,response_model,policy_reason,review_disposition,review_reason,provider,model,status,proposed_route,proposed_policy_state,error_category",
      )
      .eq("source_change_id", changeId)
      .eq("engine_version", "jev-shadow-v1")
      .eq("policy_version", "intelligence-policy-v1")
      .eq("provider", JEV_PROVIDER)
      .eq("model", JEV_MODEL)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("intelligence_readback_unavailable");
    if (data?.status === "completed" || data?.status === "failed") return data;
    await wait.for({ seconds: 5 });
  }
  throw new Error("intelligence_wait_bound_exceeded");
}

async function waitForRouteIntent(
  client: ReturnType<typeof createSupabaseServerClient>,
  changeId: string,
) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const { data, error } = await client
      .from("intelligence_route_intents")
      .select(
        "id,workspace_id,source_change_id,intelligence_decision_id,policy_version,route,route_target,policy_state,review_disposition,review_reason,router_version,provider,requested_model,response_model,route_status",
      )
      .eq("workspace_id", WORKSPACE_ID)
      .eq("source_change_id", changeId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error("route_readback_unavailable");
    if (data) return data;
    await wait.for({ seconds: 5 });
  }
  throw new Error("route_wait_bound_exceeded");
}

function safeClassification(value: Record<string, unknown>) {
  const entities = Array.isArray(value.affected_entities) ? value.affected_entities : [];
  const endpointCandidates = entities
    .filter((entity): entity is string => typeof entity === "string")
    .map(normalizeChangedEntity)
    .filter((entity) => entity.kind === "endpoint")
    .map((entity) => ({
      endpoint: entity.value,
      method: entity.method,
      original: entity.original,
    }));
  return {
    id: value.id,
    classifierVersion: value.classifier_version,
    provider: value.provider,
    model: value.model,
    status: value.status,
    material: value.material,
    category: value.category,
    confidence: value.confidence,
    decisionStatus: value.decision_status,
    endpointCandidates,
    errorCategory: value.status === "failed" ? value.error_category : undefined,
  };
}

function safeDecision(value: Record<string, unknown>) {
  return {
    id: value.id,
    provider: value.provider,
    model: value.model,
    responseModel: value.response_model,
    policyVersion: value.policy_version,
    activePolicyVersion: value.active_policy_version,
    policyMode: value.policy_mode,
    status: value.status,
    route: value.proposed_route,
    policyState: value.proposed_policy_state,
    policyReason: value.policy_reason,
    reviewDisposition: value.review_disposition,
    reviewReason: value.review_reason,
    errorCategory: value.status === "failed" ? value.error_category : undefined,
  };
}

function safeRoute(value: Record<string, unknown>) {
  return {
    id: value.id,
    workspaceId: value.workspace_id,
    sourceChangeId: value.source_change_id,
    decisionId: value.intelligence_decision_id,
    policyVersion: value.policy_version,
    route: value.route,
    routeTarget: value.route_target,
    policyState: value.policy_state,
    reviewDisposition: value.review_disposition,
    reviewReason: value.review_reason,
    routerVersion: value.router_version,
    provider: value.provider,
    requestedModel: value.requested_model,
    responseModel: value.response_model,
    status: value.route_status,
  };
}

function safeBlocked(category: string, details: Record<string, unknown>) {
  return {
    status: "blocked",
    category,
    ...details,
    customerImpactDispatched: false,
    preflightDispatched: false,
    notificationDispatched: false,
    remediationDispatched: false,
    autoPrCreated: false,
    deploymentActionDispatched: false,
    billingTouched: false,
  };
}

function safeCategory(error: unknown) {
  if (error instanceof OpenAIClassifierError) return `classifier_${error.category}`;
  if (error instanceof JevDecisionError) return `jev_${error.category}`;
  const message = error instanceof Error ? error.message : "unknown";
  return /^[a-z0-9_]{1,80}$/.test(message) ? message : "acceptance_runtime_error";
}

async function readback(client: ReturnType<typeof createSupabaseServerClient>) {
  // This action is deliberately pinned to the single Test workspace source identity.
  const sourcesResult = await client
    .from("source_catalog")
    .select("id,source_mode,processing_mode,workspace_id,scope_product_id,dependency_id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("scope_product_id", PRODUCT_ID)
    .eq("dependency_id", DEPENDENCY_ID)
    .eq("source_mode", "internal_test")
    .eq("processing_mode", "evidence_only");
  if (sourcesResult.error || !sourcesResult.data || sourcesResult.data.length !== 1)
    throw new Error("internal_source_identity_not_unique");
  const source = sourcesResult.data[0]!;
  const changesResult = await client.from("source_changes").select("id").eq("source_id", source.id);
  if (changesResult.error || !changesResult.data || changesResult.data.length !== 1)
    throw new Error("internal_source_change_not_unique");
  const sourceChangeId = changesResult.data[0]!.id;

  const classificationResult = await client
    .from("source_change_classifications")
    .select(
      "id,change_id,classifier_version,provider,model,status,material,category,affected_entities,confidence,decision_status,error_category",
    )
    .eq("change_id", sourceChangeId)
    .eq("status", "classified")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (classificationResult.error || !classificationResult.data)
    throw new Error("classification_not_persisted");
  const classification = classificationResult.data;

  const decisionResult = await client
    .from("change_intelligence_decisions")
    .select(
      "id,source_change_id,policy_version,active_policy_version,policy_mode,response_model,policy_reason,review_disposition,review_reason,provider,model,status,proposed_route,proposed_policy_state,error_category",
    )
    .eq("source_change_id", sourceChangeId)
    .eq("engine_version", "jev-shadow-v1")
    .eq("policy_version", "intelligence-policy-v1")
    .eq("provider", JEV_PROVIDER)
    .eq("model", JEV_MODEL)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (decisionResult.error || !decisionResult.data)
    throw new Error("intelligence_decision_not_persisted");
  const decision = decisionResult.data;

  const routeResult = await client
    .from("intelligence_route_intents")
    .select(
      "id,workspace_id,source_change_id,intelligence_decision_id,policy_version,route,route_target,policy_state,review_disposition,review_reason,router_version,provider,requested_model,response_model,route_status",
    )
    .eq("workspace_id", WORKSPACE_ID)
    .eq("source_change_id", sourceChangeId)
    .eq("intelligence_decision_id", decision.id)
    .maybeSingle();
  if (routeResult.error || !routeResult.data) throw new Error("route_intent_not_persisted");
  const route = routeResult.data;
  if (
    decision.active_policy_version !== INTELLIGENCE_ACTIVE_POLICY_VERSION ||
    decision.policy_mode !== "active_calibrated" ||
    decision.proposed_policy_state !== "continue_candidate" ||
    route.intelligence_decision_id !== decision.id ||
    route.route !== decision.proposed_route ||
    route.policy_state !== decision.proposed_policy_state ||
    route.policy_version !== decision.active_policy_version ||
    route.review_disposition !== decision.review_disposition ||
    route.review_reason !== decision.review_reason
  ) {
    throw new Error("persisted_policy_route_provenance_mismatch");
  }

  const targetsResult = await client.rpc("list_code_intelligence_route_targets", {
    p_route_intent_id: route.id,
  });
  if (targetsResult.error || !Array.isArray(targetsResult.data))
    throw new Error("route_target_readback_unavailable");
  const targetRows = targetsResult.data as Array<Record<string, unknown>>;
  const targetCount = targetRows.length;
  const crossWorkspaceTargets = targetRows.filter(
    (target) =>
      target.workspace_id !== WORKSPACE_ID ||
      target.product_id !== PRODUCT_ID ||
      target.repository_id !== REPOSITORY_ID,
  ).length;
  if (targetCount !== 1 || crossWorkspaceTargets !== 0)
    throw new Error("scoped_repository_target_mismatch");

  let handoff: Record<string, unknown> | null = null;
  let graph: Record<string, unknown> | null = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    const handoffResult = await client
      .from("code_analysis_route_handoffs")
      .select(
        "workspace_id,product_id,repository_id,route_intent_id,analysis_run_id,commit_sha,status,review_disposition,review_reason",
      )
      .eq("workspace_id", WORKSPACE_ID)
      .eq("product_id", PRODUCT_ID)
      .eq("repository_id", REPOSITORY_ID)
      .eq("route_intent_id", route.id)
      .eq("status", "completed")
      .maybeSingle();
    if (handoffResult.error) throw new Error("code_analysis_handoff_readback_unavailable");
    if (handoffResult.data) {
      handoff = handoffResult.data;
      const graphResult = await client
        .from("impact_graph_builds")
        .select(
          "id,workspace_id,product_id,repository_id,route_intent_id,intelligence_decision_id,analysis_run_id,commit_sha,analyzer_version,analysis_profile,graph_builder_version,policy_version,coverage_state,assessment_state,production_exposure_state,status,review_disposition,review_reason",
        )
        .eq("workspace_id", WORKSPACE_ID)
        .eq("product_id", PRODUCT_ID)
        .eq("repository_id", REPOSITORY_ID)
        .eq("route_intent_id", route.id)
        .eq("analysis_run_id", handoff.analysis_run_id)
        .maybeSingle();
      if (graphResult.error) throw new Error("impact_graph_readback_unavailable");
      if (graphResult.data?.status === "completed") {
        if (
          handoffResult.data.review_disposition !== route.review_disposition ||
          handoffResult.data.review_reason !== route.review_reason ||
          graphResult.data.review_disposition !== route.review_disposition ||
          graphResult.data.review_reason !== route.review_reason
        ) {
          throw new Error("review_provenance_not_preserved");
        }
        graph = graphResult.data;
        break;
      }
    }
    await wait.for({ seconds: 5 });
  }
  if (!handoff || !graph) throw new Error("graph_completion_wait_bound_exceeded");
  const analysisRunId = handoff.analysis_run_id;
  const handoffCommitSha = handoff.commit_sha;
  const graphBuildId = graph.id;
  if (
    typeof analysisRunId !== "string" ||
    typeof handoffCommitSha !== "string" ||
    typeof graphBuildId !== "string"
  ) {
    throw new Error("graph_identity_readback_invalid");
  }

  const analysisResult = await client
    .from("code_analysis_runs")
    .select(
      "id,workspace_id,repository_id,commit_sha,analyzer_version,analysis_profile,status,coverage_state,files_discovered,files_analyzed,files_skipped,parse_failures",
    )
    .eq("id", analysisRunId)
    .eq("workspace_id", WORKSPACE_ID)
    .eq("repository_id", REPOSITORY_ID)
    .eq("commit_sha", handoffCommitSha)
    .eq("status", "completed")
    .maybeSingle();
  if (analysisResult.error || !analysisResult.data)
    throw new Error("completed_analysis_not_persisted");
  const analysis = analysisResult.data;

  const referenceResult = await client
    .from("code_external_references")
    .select(
      "id,reference_type,normalized_value,path,start_line,start_column,end_line,end_column,confidence_class",
    )
    .eq("analysis_run_id", analysis.id)
    .eq("reference_type", "endpoint")
    .eq("normalized_value", ENDPOINT)
    .order("path", { ascending: true })
    .order("start_line", { ascending: true })
    .limit(5);
  if (referenceResult.error || !referenceResult.data?.length)
    throw new Error("exact_endpoint_reference_not_persisted");

  const [nodeCount, edgeResult, observedReferences, inferredProducts] = await Promise.all([
    countRows(client, "impact_graph_nodes", graphBuildId),
    client
      .from("impact_graph_edges")
      .select(
        "id,edge_type,edge_kind,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column",
      )
      .eq("graph_build_id", graphBuildId),
    client
      .from("impact_graph_edges")
      .select(
        "id,edge_type,evidence_path,evidence_start_line,evidence_start_column,evidence_end_line,evidence_end_column",
      )
      .eq("graph_build_id", graphBuildId)
      .eq("edge_kind", "observed")
      .eq("evidence_type", "external_reference"),
    client
      .from("impact_graph_edges")
      .select("id", { count: "exact", head: true })
      .eq("graph_build_id", graphBuildId)
      .eq("edge_type", "PRODUCT_POTENTIALLY_AFFECTED_BY_CHANGE")
      .eq("edge_kind", "inferred"),
  ]);
  if (
    edgeResult.error ||
    !edgeResult.data ||
    observedReferences.error ||
    !observedReferences.data ||
    inferredProducts.error
  )
    throw new Error("impact_graph_fact_readback_unavailable");
  const beforeCounts = {
    nodes: nodeCount,
    edges: edgeResult.data.length,
  };
  if (
    beforeCounts.nodes < 1 ||
    beforeCounts.edges < 1 ||
    observedReferences.data.length < 1 ||
    (inferredProducts.count ?? 0) < 1
  ) {
    throw new Error("required_graph_evidence_missing");
  }

  const routeReplay = await tasks.triggerAndWait<typeof routeSourceChangeIntelligenceTask>(
    "route-source-change-intelligence",
    { sourceChangeId },
    { idempotencyKey: `m1577-production-route-replay:${route.id}:${analysis.id}` },
  );
  if (!routeReplay.ok) throw new Error("canonical_route_replay_failed");
  const routeReplayOutput = routeReplay.output as Record<string, unknown>;
  if (
    routeReplayOutput.status !== "code_analysis_dispatched" ||
    routeReplayOutput.targetCount !== 1 ||
    routeReplayOutput.dispatched !== 1
  ) {
    throw new Error("canonical_route_replay_did_not_dispatch_target");
  }
  await wait.for({ seconds: 10 });

  const [afterNodeCount, afterEdges, afterGraphBuilds, customerImpact, assessments, proposals] =
    await Promise.all([
      countRows(client, "impact_graph_nodes", graphBuildId),
      client
        .from("impact_graph_edges")
        .select("id,edge_type,edge_kind")
        .eq("graph_build_id", graphBuildId),
      client
        .from("impact_graph_builds")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", WORKSPACE_ID)
        .eq("product_id", PRODUCT_ID)
        .eq("repository_id", REPOSITORY_ID)
        .eq("route_intent_id", route.id)
        .eq("analysis_run_id", analysis.id),
      client
        .from("customer_impact_dispatch_queue")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", WORKSPACE_ID)
        .eq("workspace_dependency_id", WORKSPACE_DEPENDENCY_ID)
        .eq("source_change_classification_id", classification.id),
      client
        .from("impact_assessments")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", WORKSPACE_ID)
        .eq("workspace_dependency_id", WORKSPACE_DEPENDENCY_ID)
        .eq("source_change_classification_id", classification.id),
      client
        .from("remediation_proposals")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", WORKSPACE_ID)
        .eq("source_change_id", sourceChangeId),
    ]);
  if (
    afterEdges.error ||
    !afterEdges.data ||
    afterGraphBuilds.error ||
    customerImpact.error ||
    assessments.error ||
    proposals.error
  )
    throw new Error("side_effect_readback_unavailable");
  const afterCounts = { nodes: afterNodeCount, edges: afterEdges.data.length };
  const edgeCounts = afterEdges.data.reduce<Record<string, number>>((counts, edge) => {
    const key = `${edge.edge_kind}:${edge.edge_type}`;
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  if (
    (afterGraphBuilds.count ?? 0) !== 1 ||
    afterCounts.nodes !== beforeCounts.nodes ||
    afterCounts.edges !== beforeCounts.edges
  ) {
    throw new Error("graph_replay_not_idempotent");
  }
  if (
    (customerImpact.count ?? 0) !== 0 ||
    (assessments.count ?? 0) !== 0 ||
    (proposals.count ?? 0) !== 0
  ) {
    throw new Error("evidence_only_customer_side_effect_detected");
  }
  const primaryObserved = observedReferences.data[0];

  return {
    status: "readback_complete",
    source: {
      id: source.id,
      sourceChangeId,
      mode: source.source_mode,
      processingMode: source.processing_mode,
      workspaceId: source.workspace_id,
      productId: source.scope_product_id,
      dependencyId: source.dependency_id,
    },
    classifier: safeClassification(classification),
    intelligence: safeDecision(decision),
    route: safeRoute(route),
    productTargetCount: targetCount,
    crossWorkspaceTargetCount: crossWorkspaceTargets,
    repositoryMappingId: "a244fd9a-cc2b-49d2-aaa8-36147437837e",
    analysis: {
      id: analysis.id,
      commitSha: analysis.commit_sha,
      analyzerVersion: analysis.analyzer_version,
      profile: analysis.analysis_profile,
      coverageState: analysis.coverage_state,
      filesDiscovered: analysis.files_discovered,
      filesAnalyzed: analysis.files_analyzed,
      filesSkipped: analysis.files_skipped,
      parseFailures: analysis.parse_failures,
    },
    exactEndpoint: referenceResult.data[0],
    graph: {
      id: graphBuildId,
      builderVersion: graph.graph_builder_version,
      status: graph.status,
      coverageState: graph.coverage_state,
      assessmentState: graph.assessment_state,
      productionExposureState: graph.production_exposure_state,
      reviewDisposition: graph.review_disposition,
      reviewReason: graph.review_reason,
      handoffReviewDisposition: handoff.review_disposition,
      handoffReviewReason: handoff.review_reason,
      nodeCount: beforeCounts.nodes,
      edgeCount: beforeCounts.edges,
      edgeCounts,
      primaryObservedCodeEdge: primaryObserved,
      inferredProductImpactCount: inferredProducts.count ?? 0,
    },
    replay: {
      routeReplayTriggered: true,
      graphReplayTriggeredThroughCanonicalHandoff: true,
      graphBuildCount: afterGraphBuilds.count ?? 0,
      duplicateNodes: afterCounts.nodes - beforeCounts.nodes,
      duplicateEdges: afterCounts.edges - beforeCounts.edges,
      idempotent:
        afterCounts.nodes === beforeCounts.nodes && afterCounts.edges === beforeCounts.edges,
    },
    sideEffects: {
      customerImpactQueueRows: customerImpact.count ?? 0,
      impactAssessmentRows: assessments.count ?? 0,
      preflightDispatched: false,
      notificationDispatched: false,
      remediationProposalRows: proposals.count ?? 0,
      autoPrCreated: false,
      deploymentActionDispatched: false,
      billingTouched: false,
    },
  };
}

async function countRows(
  client: ReturnType<typeof createSupabaseServerClient>,
  table: "impact_graph_nodes",
  graphBuildId: string,
) {
  const { count, error } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("graph_build_id", graphBuildId);
  if (error) throw new Error("graph_count_readback_unavailable");
  return count ?? 0;
}
