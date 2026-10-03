import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  canonicalTopicIdentity,
  evidenceFingerprint,
  GROWTH_EVALUATOR_VERSION,
  GROWTH_PACKET_SCHEMA_VERSION,
  GROWTH_POLICY_VERSION,
  PUBLIC_SAFETY_VERSION,
  validatePublicIntelligencePacket,
  validatePublishableFields,
  type GrowthDecision,
  type PublicIntelligencePacket,
} from "@/lib/growth/contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type PublicEvidenceRow = {
  id: string;
  change_id: string;
  material: boolean;
  category: string;
  affected_entities: string[];
  severity_hint: string;
  confidence: number;
  summary: string;
  evidence: { type: "added" | "removed" | "changed"; excerpt: string }[];
  classified_at: string;
};

export type GrowthEvaluation = {
  decision: GrowthDecision;
  status: "candidate" | "approved_by_engine" | "stale";
  recommendedSurface:
    "PUBLIC_PAGE" | "PROVIDER_HUB" | "DISTRIBUTION" | "NOINDEX" | "FREE_TOOL" | "NONE";
  publicationReady: boolean;
  indexable: boolean;
  indexPolicy: "INDEX" | "NOINDEX" | "NOT_APPLICABLE";
  reasons: string[];
  blockers: string[];
  confidence: number;
  factors: Record<string, string | number | boolean | null>;
  headline: string;
  publicSummary: string;
  generalImpact: string;
  affectedPublicEntities: string[];
  freshness: PublicIntelligencePacket["freshness"];
  effectiveAt: string | null;
  distributionTypes: string[];
  suggestedAngle: string;
  safeClaimBoundaries: string[];
  freeToolType:
    | "STACK_SCANNER"
    | "DEPENDENCY_EXPOSURE_CHECK"
    | "API_DEPRECATION_CHECKER"
    | "MODEL_RETIREMENT_CHECKER"
    | null;
  toolLinkPolicy: { indexable: false; rel: "nofollow" } | null;
  ctaTypes: ("CHECK_MY_STACK" | "SCAN_COMPANY" | "VERIFY_WITH_GITHUB")[];
};

export type GrowthEvaluationResult = {
  packet: PublicIntelligencePacket | null;
  evaluation: GrowthEvaluation;
  persisted: boolean;
  opportunityId: string | null;
  canonicalSlug: string | null;
  evaluationId: string | null;
};

function ageDays(from: string, now: Date) {
  return Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 86_400_000));
}

function publicFreshness(
  days: number,
  effectiveAt: string | null,
  now: Date,
): PublicIntelligencePacket["freshness"] {
  if (effectiveAt && new Date(effectiveAt).getTime() >= now.getTime()) return "upcoming";
  if (days <= 7) return "current";
  if (days <= 45) return "recent";
  if (days <= 365) return "stale";
  return "expired";
}

function extractEffectiveDate(texts: string[]) {
  const pattern =
    /\b(?:effective(?:\s+on)?|retires?\s+(?:on|by)|sunsets?\s+(?:on|by)|deprecated\s+(?:on|after)|available\s+until|by)\s+(\d{4}-\d{2}-\d{2})\b/i;
  for (const text of texts) {
    const match = pattern.exec(text);
    if (!match) continue;
    const date = new Date(`${match[1]}T00:00:00.000Z`);
    if (!Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === match[1])
      return date.toISOString();
  }
  return null;
}

function safeClassification(row: PublicEvidenceRow): PublicEvidenceRow {
  return row;
}

/** Builds an allowlisted packet from global catalog/source/classification tables only. */
export async function buildPublicIntelligencePacket(
  client: SupabaseClient,
  sourceChangeId: string,
  now = new Date(),
  classificationId?: string,
) {
  const { data: change, error: changeError } = await client
    .from("source_changes")
    .select("id,source_id,created_at")
    .eq("id", sourceChangeId)
    .maybeSingle();
  if (changeError) throw new Error("growth_public_change_query_failed");
  if (!change) return { packet: null, reason: "public_change_unavailable" as const };

  let classificationQuery = client
    .from("source_change_classifications")
    .select(
      "id,change_id,material,category,affected_entities,severity_hint,confidence,summary,evidence,classified_at,status",
    )
    .eq("change_id", sourceChangeId)
    .eq("status", "classified");
  if (classificationId) classificationQuery = classificationQuery.eq("id", classificationId);
  else
    classificationQuery = classificationQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1);
  const { data: classification, error: classificationError } =
    await classificationQuery.maybeSingle();
  if (classificationError) throw new Error("growth_public_classification_query_failed");
  if (!classification || classification.change_id !== change.id)
    return { packet: null, reason: "public_classification_unavailable" as const };
  const publicClass = safeClassification(classification as PublicEvidenceRow);

  const { data: source, error: sourceError } = await client
    .from("source_catalog")
    .select("id,dependency_id,name,source_type,url,enabled")
    .eq("id", change.source_id)
    .eq("enabled", true)
    .maybeSingle();
  if (sourceError) throw new Error("growth_public_source_query_failed");
  if (!source) return { packet: null, reason: "public_source_unavailable" as const };

  const { data: provider, error: providerError } = await client
    .from("dependency_catalog")
    .select("id,slug,name,category,website_url,enabled")
    .eq("id", source.dependency_id)
    .eq("enabled", true)
    .maybeSingle();
  if (providerError) throw new Error("growth_public_provider_query_failed");
  if (!provider) return { packet: null, reason: "public_provider_unavailable" as const };

  const { count: sourceCount, error: sourceCountError } = await client
    .from("source_catalog")
    .select("id", { count: "exact", head: true })
    .eq("dependency_id", provider.id)
    .eq("enabled", true);
  if (sourceCountError) throw new Error("growth_public_source_count_query_failed");
  if (!sourceCount) return { packet: null, reason: "public_source_count_unavailable" as const };

  const { data: providerSources, error: providerSourcesError } = await client
    .from("source_catalog")
    .select("id,name,source_type,url,enabled")
    .eq("dependency_id", provider.id)
    .eq("enabled", true)
    .limit(100);
  if (providerSourcesError) throw new Error("growth_public_sources_query_failed");
  if (!providerSources) return { packet: null, reason: "public_sources_unavailable" as const };
  const relatedSourceIds = providerSources.map((item) => item.id).filter((id) => id !== source.id);
  const corroboratingClasses: {
    id: string;
    change_id: string;
    affected_entities: string[];
    evidence: PublicEvidenceRow["evidence"];
    created_at: string;
    source_id: string;
  }[] = [];
  if (relatedSourceIds.length) {
    const { data: relatedChanges, error: relatedChangesError } = await client
      .from("source_changes")
      .select("id,source_id,created_at")
      .in("source_id", relatedSourceIds)
      .order("created_at", { ascending: false })
      .limit(100);
    if (relatedChangesError) throw new Error("growth_related_changes_query_failed");
    const changeIds = (relatedChanges ?? []).map((item) => item.id);
    if (changeIds.length) {
      const { data: relatedClassifications, error: relatedClassificationsError } = await client
        .from("source_change_classifications")
        .select("id,change_id,category,material,affected_entities,evidence,summary,status")
        .in("change_id", changeIds)
        .eq("status", "classified")
        .eq("material", true)
        .eq("category", publicClass.category)
        .limit(100);
      if (relatedClassificationsError)
        throw new Error("growth_related_classifications_query_failed");
      const changeById = new Map((relatedChanges ?? []).map((item) => [item.id, item]));
      const sourceById = new Map(providerSources.map((item) => [item.id, item]));
      const canonicalEntities = (publicClass.affected_entities ?? []).map((item) =>
        item.trim().normalize("NFKC").toLowerCase(),
      );
      const primaryDay =
        extractEffectiveDate([
          publicClass.summary,
          ...(publicClass.evidence ?? []).map((item) => item.excerpt),
        ])?.slice(0, 10) ?? null;
      for (const related of relatedClassifications ?? []) {
        const relatedChange = changeById.get(related.change_id);
        const relatedSource = relatedChange ? sourceById.get(relatedChange.source_id) : null;
        const relatedEntities = (related.affected_entities ?? []).map((item: string) =>
          item.trim().normalize("NFKC").toLowerCase(),
        );
        const relatedDay =
          extractEffectiveDate([
            related.summary ?? "",
            ...(related.evidence ?? []).map((item: { excerpt: string }) => item.excerpt),
          ])?.slice(0, 10) ?? null;
        const withinWindow =
          relatedChange &&
          Math.abs(
            new Date(relatedChange.created_at).getTime() - new Date(change.created_at).getTime(),
          ) <=
            30 * 86_400_000;
        if (
          !relatedChange ||
          !relatedSource ||
          !withinWindow ||
          !canonicalEntities.length ||
          !canonicalEntities.some((entity) => relatedEntities.includes(entity)) ||
          !primaryDay ||
          relatedDay !== primaryDay
        )
          continue;
        corroboratingClasses.push({
          id: related.id,
          change_id: related.change_id,
          affected_entities: related.affected_entities ?? [],
          evidence: related.evidence ?? [],
          created_at: relatedChange.created_at,
          source_id: relatedSource.id,
        });
      }
    }
  }

  const detectedAt = change.created_at;
  const days = ageDays(detectedAt, now);
  const evidenceReferences = (publicClass.evidence ?? []).slice(0, 5).map((evidence) => ({
    sourceId: source.id,
    sourceChangeId: change.id,
    classificationId: publicClass.id,
    sourceUrl: source.url,
    type: evidence.type,
    excerpt: evidence.excerpt,
  }));
  const effectiveAt = extractEffectiveDate([
    publicClass.summary,
    ...evidenceReferences.map((evidence) => evidence.excerpt),
  ]);
  const evidenceSourceIds = new Set(evidenceReferences.map((item) => item.sourceId));
  for (const corroborating of corroboratingClasses) {
    if (evidenceReferences.length >= 5 || evidenceSourceIds.has(corroborating.source_id)) continue;
    const corroboratingSource = providerSources.find((item) => item.id === corroborating.source_id);
    if (!corroboratingSource) continue;
    for (const item of corroborating.evidence) {
      if (evidenceReferences.length >= 5) break;
      evidenceReferences.push({
        sourceId: corroborating.source_id,
        sourceChangeId: corroborating.change_id,
        classificationId: corroborating.id,
        sourceUrl: corroboratingSource.url,
        type: item.type,
        excerpt: item.excerpt,
      });
    }
    evidenceSourceIds.add(corroborating.source_id);
  }
  const usedSourceIds = new Set(evidenceReferences.map((item) => item.sourceId));
  const publicSources = providerSources
    .filter((item) => usedSourceIds.has(item.id))
    .map((item) => ({ id: item.id, name: item.name, type: item.source_type, url: item.url }));
  const packet = {
    schemaVersion: GROWTH_PACKET_SCHEMA_VERSION,
    provider: { slug: provider.slug, name: provider.name, websiteUrl: provider.website_url },
    dependency: { slug: provider.slug, name: provider.name, category: provider.category },
    source: {
      id: source.id,
      name: source.name,
      type: source.source_type,
      url: source.url,
      authoritativeSourceCount: sourceCount,
    },
    publicSources,
    change: {
      id: change.id,
      classificationId: publicClass.id,
      detectedAt,
      announcedAt: null,
      effectiveAt,
      material: publicClass.material,
      category: publicClass.category,
      severity: publicClass.severity_hint,
      confidence: Number(publicClass.confidence),
      affectedPublicEntities: publicClass.affected_entities ?? [],
      summary: publicClass.summary,
    },
    evidenceReferences,
    freshness: publicFreshness(days, effectiveAt, now),
    ageDays: days,
    effectiveInDays: effectiveAt
      ? Math.floor((new Date(effectiveAt).getTime() - now.getTime()) / 86_400_000)
      : null,
    originalUtilityFacts: [
      ...(effectiveAt ? ["effective_date_context" as const] : []),
      ...((publicClass.affected_entities ?? []).length
        ? ["structured_affected_entity_context" as const]
        : []),
      ...(usedSourceIds.size >= 2 ? ["change_history_context" as const] : []),
    ],
  };
  const validation = validatePublicIntelligencePacket(packet);
  return validation.safe
    ? { packet: validation.packet, reason: null }
    : { packet: null, reason: validation.blockers.join(",") || "unsafe_public_packet" };
}

function evaluatePacket(packet: PublicIntelligencePacket, now: Date): GrowthEvaluation {
  const days = ageDays(packet.change.detectedAt, now);
  const category = packet.change.category;
  const highIntentCategory = ["deprecation", "api_change", "pricing", "terms", "limits"].includes(
    category,
  );
  const hasEntity = packet.change.affectedPublicEntities.length > 0;
  const distinctEvidenceSources = new Set(
    packet.evidenceReferences.map((reference) => reference.sourceId),
  ).size;
  const strongEvidence = distinctEvidenceSources >= 2 && packet.change.confidence >= 0.8;
  const futureEvent =
    packet.change.effectiveAt !== null &&
    new Date(packet.change.effectiveAt).getTime() >= now.getTime();
  const hasOriginalUtility =
    packet.originalUtilityFacts.includes("effective_date_context") &&
    packet.originalUtilityFacts.includes("change_history_context");
  const evidenceText = packet.evidenceReferences.map((item) => item.excerpt).join("\n");
  const specificChangeDetail =
    /\b(?:v?\d+(?:\.\d+){1,3}|(?:gpt|claude|gemini|api)[-_]?[a-z0-9.]+)\b/i.test(evidenceText);
  const usefulSummary =
    packet.change.summary.trim().split(/\s+/).length >= 20 && specificChangeDetail;
  const old = days > 45 && !futureEvent;
  const factors = {
    materiality: packet.change.material ? "material" : "non_material",
    evidenceQuality:
      distinctEvidenceSources >= 2
        ? "corroborated"
        : packet.evidenceReferences.length
          ? "single_authoritative_source"
          : "none",
    distinctEvidenceSources,
    evidenceCount: packet.evidenceReferences.length,
    authoritativeSourceCount: packet.source.authoritativeSourceCount,
    freshness: futureEvent ? "upcoming" : packet.freshness,
    userIntent: highIntentCategory && hasEntity ? "specific" : "broad_or_unclear",
    uniqueness: hasEntity && highIntentCategory ? "distinct_entity_event" : "provider_hub_context",
    duplication: "canonical_topic_consolidation",
    publicSafety: "validated",
  } as const;
  let decision: GrowthDecision = "IGNORE";
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (!packet.change.material) blockers.push("not_material");
  if (packet.change.confidence < 0.6) blockers.push("weak_materiality_confidence");
  if (packet.evidenceReferences.length < 1) blockers.push("missing_authoritative_evidence");
  if (old) {
    decision = packet.evidenceReferences.length >= 2 ? "NOINDEX" : "IGNORE";
    reasons.push("historical_event");
    blockers.push("expired_or_stale_event");
  } else if (
    !packet.change.material ||
    packet.change.confidence < 0.6 ||
    packet.evidenceReferences.length < 1
  ) {
    decision = "IGNORE";
  } else if (
    highIntentCategory &&
    hasEntity &&
    strongEvidence &&
    hasOriginalUtility &&
    futureEvent &&
    usefulSummary
  ) {
    decision = "PUBLIC_PAGE";
    reasons.push(
      "material_change",
      "independent_source_corroboration",
      "distinct_user_intent",
      "adds_unique_auterim_context",
    );
    if (futureEvent) reasons.push("future_effective_date");
  } else if (packet.change.confidence >= 0.7 && packet.evidenceReferences.length >= 1) {
    decision = "HUB_UPDATE";
    reasons.push("material_change", "provider_hub_consolidation");
  } else if (
    packet.freshness === "current" ||
    packet.freshness === "upcoming" ||
    packet.freshness === "recent"
  ) {
    decision = "DISTRIBUTION_ONLY";
    reasons.push("timely_public_intelligence", "limited_standalone_search_utility");
  }
  const publicImpact = packet.change.effectiveAt
    ? `The provider lists ${packet.change.effectiveAt.slice(0, 10)} as the effective date. Applications relying on ${packet.change.affectedPublicEntities[0] ?? packet.provider.name} should review the published requirements before that date.`
    : `Applications that rely on ${packet.change.affectedPublicEntities[0] ?? packet.provider.name} may need to review this ${category.replaceAll("_", " ")} change.`;
  const headline = `${packet.provider.name}: ${packet.change.affectedPublicEntities[0] ?? category.replaceAll("_", " ")} update`;
  const publicSummary =
    futureEvent && packet.change.effectiveAt
      ? `${packet.change.summary.trim()} The effective date cited by the provider is ${packet.change.effectiveAt.slice(0, 10)}.`
      : packet.change.summary;
  const generalImpact = publicImpact;
  const publicFields = validatePublishableFields({
    headline,
    publicSummary,
    generalImpact,
    reasons,
    factors,
  });
  if (!publicFields.safe) {
    decision = "IGNORE";
    blockers.push(...publicFields.blockers, "public_safety_failed");
    reasons.length = 0;
  }
  const publicationReady =
    ["PUBLIC_PAGE", "HUB_UPDATE", "DISTRIBUTION_ONLY"].includes(decision) && blockers.length === 0;
  const indexable = decision === "PUBLIC_PAGE" && publicationReady;
  const freeToolType =
    category === "deprecation"
      ? packet.dependency.category === "ai"
        ? "MODEL_RETIREMENT_CHECKER"
        : "API_DEPRECATION_CHECKER"
      : category === "api_change"
        ? "API_DEPRECATION_CHECKER"
        : null;
  const toolIsBetterSurface = freeToolType !== null && decision === "HUB_UPDATE";
  const recommendedSurface =
    decision === "PUBLIC_PAGE"
      ? "PUBLIC_PAGE"
      : toolIsBetterSurface
        ? "FREE_TOOL"
        : decision === "HUB_UPDATE"
          ? "PROVIDER_HUB"
          : decision === "DISTRIBUTION_ONLY"
            ? "DISTRIBUTION"
            : decision === "NOINDEX"
              ? "NOINDEX"
              : "NONE";
  const distributionTypes = !publicationReady
    ? []
    : decision === "DISTRIBUTION_ONLY"
      ? ["X_POST", "LINKEDIN_POST", "FOUNDER_THREAD"]
      : publicationReady
        ? ["NEWSLETTER_ITEM"]
        : [];
  const eligibleFreeTool = toolIsBetterSurface ? freeToolType : null;
  return {
    decision,
    status: decision === "PUBLIC_PAGE" ? "approved_by_engine" : old ? "stale" : "candidate",
    recommendedSurface,
    publicationReady,
    indexable,
    indexPolicy: indexable ? "INDEX" : decision === "NOINDEX" ? "NOINDEX" : "NOT_APPLICABLE",
    reasons,
    blockers,
    confidence: Math.min(
      1,
      Math.max(
        0,
        Number(
          (
            packet.change.confidence * 0.65 +
            (packet.evidenceReferences.length >= 2 ? 0.25 : 0.1) +
            (hasEntity ? 0.1 : 0)
          ).toFixed(3),
        ),
      ),
    ),
    factors,
    headline,
    publicSummary,
    generalImpact,
    affectedPublicEntities: packet.change.affectedPublicEntities,
    freshness: packet.freshness,
    effectiveAt: packet.change.effectiveAt,
    distributionTypes,
    suggestedAngle: `${headline} — grounded in the provider's public source and evidence excerpts.`,
    safeClaimBoundaries: [
      "public_provider_evidence_only",
      "no_customer_specific_impact_claims",
      "no_claim_of_guaranteed_breakage",
    ],
    freeToolType: eligibleFreeTool,
    toolLinkPolicy: eligibleFreeTool
      ? { indexable: false as const, rel: "nofollow" as const }
      : null,
    ctaTypes:
      publicationReady && decision !== "DISTRIBUTION_ONLY"
        ? ["CHECK_MY_STACK", "SCAN_COMPANY", "VERIFY_WITH_GITHUB"]
        : [],
  };
}

export async function evaluatePublicIntelligencePacket(input: unknown, now = new Date()) {
  const validation = validatePublicIntelligencePacket(input);
  if (!validation.safe || !validation.packet) {
    return {
      packet: null,
      evaluation: {
        decision: "IGNORE" as const,
        status: "candidate" as const,
        recommendedSurface: "NONE" as const,
        publicationReady: false,
        indexable: false,
        indexPolicy: "NOINDEX" as const,
        reasons: [],
        blockers: validation.blockers.length ? validation.blockers : ["invalid_packet_schema"],
        confidence: 0,
        factors: { publicSafety: "rejected" },
        headline: "Public packet rejected",
        publicSummary: "",
        generalImpact: "",
        affectedPublicEntities: [],
        freshness: "stale" as const,
        effectiveAt: null,
        distributionTypes: [],
        suggestedAngle: "",
        safeClaimBoundaries: ["no_public_distribution"],
        freeToolType: null,
        toolLinkPolicy: null,
        ctaTypes: [],
      },
    };
  }
  return { packet: validation.packet, evaluation: evaluatePacket(validation.packet, now) };
}

export async function evaluateGrowthCandidate(
  sourceChangeId: string,
  options: { client?: SupabaseClient; now?: Date; classificationId?: string } = {},
): Promise<GrowthEvaluationResult> {
  const client = options.client ?? createSupabaseServerClient();
  const packetResult = await buildPublicIntelligencePacket(
    client,
    sourceChangeId,
    options.now,
    options.classificationId,
  );
  if (!packetResult.packet) {
    return {
      packet: null,
      evaluation: {
        decision: "IGNORE",
        status: "candidate",
        recommendedSurface: "NONE",
        publicationReady: false,
        indexable: false,
        reasons: [],
        blockers: [packetResult.reason ?? "public_packet_unavailable"],
        indexPolicy: "NOINDEX",
        confidence: 0,
        factors: { publicSafety: "rejected" },
        headline: "Public packet rejected",
        publicSummary: "",
        generalImpact: "",
        affectedPublicEntities: [],
        freshness: "stale",
        effectiveAt: null,
        distributionTypes: [],
        suggestedAngle: "",
        safeClaimBoundaries: ["no_public_distribution"],
        freeToolType: null,
        ctaTypes: [],
        toolLinkPolicy: null,
      },
      persisted: false,
      opportunityId: null,
      canonicalSlug: null,
      evaluationId: null,
    };
  }
  const { packet } = packetResult;
  const { evaluation } = await evaluatePublicIntelligencePacket(packet, options.now);
  const identity = canonicalTopicIdentity(packet);
  const fingerprint = evidenceFingerprint(packet);
  const payload = {
    providerSlug: packet.provider.slug,
    topicKey: identity.topicKey,
    entityKey: identity.entityKey,
    topicLabel:
      `${packet.provider.name} ${packet.change.category.replaceAll("_", " ")}: ${packet.change.affectedPublicEntities[0] ?? "provider update"}`.slice(
        0,
        160,
      ),
    canonicalSlug: identity.canonicalSlug,
    sourceChangeId: packet.change.id,
    classificationId: packet.change.classificationId,
    evaluatorVersion: GROWTH_EVALUATOR_VERSION,
    packetSchemaVersion: GROWTH_PACKET_SCHEMA_VERSION,
    policyVersion: GROWTH_POLICY_VERSION,
    evidenceFingerprint: fingerprint,
    decision: evaluation.decision,
    status: evaluation.status,
    recommendedSurface: evaluation.recommendedSurface,
    publicationReady: evaluation.publicationReady,
    indexable: evaluation.indexable,
    headline: evaluation.headline,
    publicSummary: evaluation.publicSummary,
    generalImpact: evaluation.generalImpact,
    affectedPublicEntities: packet.change.affectedPublicEntities,
    reasons: evaluation.reasons,
    blockers: evaluation.blockers,
    factors: evaluation.factors,
    confidence: evaluation.confidence,
    freshness: evaluation.freshness,
    announcedAt: packet.change.announcedAt,
    effectiveAt: evaluation.effectiveAt,
    publicSafetyVersion: PUBLIC_SAFETY_VERSION,
    distributionTypes: evaluation.distributionTypes,
    suggestedAngle: evaluation.suggestedAngle,
    safeClaimBoundaries: evaluation.safeClaimBoundaries,
    freeToolType: evaluation.freeToolType,
    ctaTypes: evaluation.ctaTypes,
    evidence: packet.evidenceReferences,
  };
  const storedSafe = validatePublishableFields(payload);
  if (!storedSafe.safe) {
    evaluation.decision = "IGNORE";
    evaluation.status = "candidate";
    evaluation.publicationReady = false;
    evaluation.indexable = false;
    evaluation.recommendedSurface = "NONE";
    evaluation.reasons = [];
    evaluation.blockers.push(...storedSafe.blockers, "public_safety_failed");
    payload.decision = "IGNORE";
    payload.status = "candidate";
    payload.recommendedSurface = "NONE";
    payload.publicationReady = false;
    payload.indexable = false;
    payload.reasons = [];
    payload.blockers = evaluation.blockers;
    payload.distributionTypes = [];
  }
  const { data, error } = await client.rpc("record_growth_evaluation", { p_payload: payload });
  if (error || !data) throw new Error("growth_evaluation_persistence_failed");
  const result = data as {
    opportunityId: string;
    canonicalSlug: string;
    evaluationId: string;
    evaluationInserted: boolean;
  };
  return {
    packet,
    evaluation,
    persisted: true,
    opportunityId: result.opportunityId,
    canonicalSlug: result.canonicalSlug,
    evaluationId: result.evaluationId,
  };
}
