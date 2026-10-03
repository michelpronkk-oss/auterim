import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

export const GROWTH_PACKET_SCHEMA_VERSION = 1;
export const GROWTH_EVALUATOR_VERSION = "growth-rules-v1";
export const GROWTH_POLICY_VERSION = "growth-policy-v1";
export const PUBLIC_SAFETY_VERSION = "public-safety-v1";

export const growthDecisionSchema = z.enum([
  "PUBLIC_PAGE",
  "HUB_UPDATE",
  "DISTRIBUTION_ONLY",
  "NOINDEX",
  "IGNORE",
]);
export type GrowthDecision = z.infer<typeof growthDecisionSchema>;

const publicUrlSchema = z.string().url();
const evidenceReferenceSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceChangeId: z.string().uuid(),
    classificationId: z.string().uuid(),
    sourceUrl: publicUrlSchema,
    type: z.enum(["added", "removed", "changed"]),
    excerpt: z.string().trim().min(1).max(280),
  })
  .strict();

export const publicIntelligencePacketSchema = z
  .object({
    schemaVersion: z.literal(GROWTH_PACKET_SCHEMA_VERSION),
    provider: z
      .object({
        slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
        name: z.string().trim().min(1).max(120),
        websiteUrl: publicUrlSchema,
      })
      .strict(),
    dependency: z
      .object({
        slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
        name: z.string().trim().min(1).max(120),
        category: z.string().trim().min(1).max(60),
      })
      .strict(),
    source: z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(160),
        type: z.string().trim().min(1).max(40),
        url: publicUrlSchema,
        authoritativeSourceCount: z.number().int().min(1).max(500),
      })
      .strict(),
    publicSources: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            name: z.string().trim().min(1).max(160),
            type: z.string().trim().min(1).max(40),
            url: publicUrlSchema,
          })
          .strict(),
      )
      .min(1)
      .max(8),
    change: z
      .object({
        id: z.string().uuid(),
        classificationId: z.string().uuid(),
        detectedAt: z.string().datetime(),
        announcedAt: z.string().datetime().nullable(),
        effectiveAt: z.string().datetime().nullable(),
        material: z.boolean(),
        category: z.string().trim().min(1).max(40),
        severity: z.string().trim().min(1).max(30),
        confidence: z.number().min(0).max(1),
        affectedPublicEntities: z.array(z.string().trim().min(1).max(120)).max(5),
        summary: z.string().trim().min(1).max(1200),
      })
      .strict(),
    evidenceReferences: z.array(evidenceReferenceSchema).min(1).max(5),
    freshness: z.enum(["current", "upcoming", "recent", "stale", "expired"]),
    ageDays: z.number().int().min(0).max(36500),
    effectiveInDays: z.number().int().min(-36500).max(36500).nullable(),
    originalUtilityFacts: z
      .array(
        z.enum([
          "independent_source_corroboration",
          "effective_date_context",
          "structured_affected_entity_context",
          "change_history_context",
        ]),
      )
      .max(4),
  })
  .strict();

export type PublicIntelligencePacket = z.infer<typeof publicIntelligencePacketSchema>;

const privateValuePatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:sk|rk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/i,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}/i,
  /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]{8,}/i,
  /\b(?:workspace|tenant|repository|repo|customer|billing|notification)[_-]?(?:id|email|path|record)\b/i,
  /\b(?:[A-Z]:\\|\\\\[^\\]+\\|\/(?:home|Users|workspace|workspaces|var|tmp)\/)[^\s]*/i,
  /(?:^|\s)(?:src|lib|app|packages|apps|test|tests)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|kt|env)(?::\d+(?:-\d+)?)?(?:\s|$)/i,
  /\b(?:function\s+\w+|import\s+.+\s+from\s+|const\s+\w+\s*=|class\s+\w+\s*\{)/i,
  /\b(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/i,
];

function isSafePublicUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let decodedPath = url.pathname;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const decoded = decodeURIComponent(decodedPath);
      if (decoded === decodedPath) break;
      decodedPath = decoded;
    }
    const pathSegments = decodedPath.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      isIP(hostname) === 0 &&
      hostname.includes(".") &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".internal") &&
      !hostname.endsWith(".localhost") &&
      !privateValuePatterns.some((pattern) => pattern.test(hostname)) &&
      !pathSegments.some(
        (segment) =>
          /^(?:customer|customers|tenant|tenants|workspace|workspaces|instance|instances|account|accounts|private)$/i.test(
            segment,
          ) ||
          /^[0-9]{5,}$/.test(segment) ||
          /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment),
      )
    );
  } catch {
    return false;
  }
}

function collectUnsafeText(value: unknown, path = "packet", blockers: string[] = []) {
  if (typeof value === "string") {
    if (privateValuePatterns.some((pattern) => pattern.test(value)))
      blockers.push(`unsafe_text:${path}`);
    if (/https?:\/\/[^\s<>"')]+/i.test(value) && !/(?:websiteUrl|\.url|sourceUrl)$/.test(path))
      blockers.push(`embedded_url:${path}`);
    return blockers;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectUnsafeText(item, `${path}[${index}]`, blockers));
    return blockers;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (
        /^(workspace|tenant|customer|repository|repo|billing|notification)[_-]?(id|email|path|record)$/i.test(
          key,
        )
      )
        blockers.push(`private_field:${path}.${key}`);
      collectUnsafeText(item, `${path}.${key}`, blockers);
    }
  }
  return blockers;
}

export function validatePublicIntelligencePacket(input: unknown) {
  const parsed = publicIntelligencePacketSchema.safeParse(input);
  const blockers = collectUnsafeText(input);
  if (!parsed.success) blockers.push("invalid_packet_schema");
  if (parsed.success) {
    const packet = parsed.data;
    if (
      !isSafePublicUrl(packet.provider.websiteUrl) ||
      !isSafePublicUrl(packet.source.url) ||
      packet.publicSources.some((source) => !isSafePublicUrl(source.url))
    )
      blockers.push("non_public_source_url");
    if (
      !packet.publicSources.some(
        (source) => source.id === packet.source.id && source.url === packet.source.url,
      )
    )
      blockers.push("primary_source_not_allowlisted");
    if (
      !packet.evidenceReferences.some(
        (evidence) =>
          evidence.sourceChangeId === packet.change.id &&
          evidence.classificationId === packet.change.classificationId,
      )
    )
      blockers.push("primary_change_evidence_missing");
    if (
      packet.evidenceReferences.some(
        (evidence) =>
          !packet.publicSources.some(
            (source) => source.id === evidence.sourceId && source.url === evidence.sourceUrl,
          ) || !isSafePublicUrl(evidence.sourceUrl),
      )
    )
      blockers.push("unverified_evidence_reference");
  }
  return {
    safe: blockers.length === 0 && parsed.success,
    blockers: [...new Set(blockers)],
    packet: parsed.success && blockers.length === 0 ? parsed.data : null,
  };
}

export function validatePublishableFields(value: unknown) {
  const blockers = collectUnsafeText(value, "publicOutput");
  return { safe: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function slugPart(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "event"
  );
}

export function canonicalTopicIdentity(packet: PublicIntelligencePacket) {
  const topicKey = slugPart(packet.change.category);
  const entityText = packet.change.affectedPublicEntities[0];
  const effectiveDay = packet.change.effectiveAt?.slice(0, 10).replaceAll("-", "");
  const entityCanonical = entityText
    ? entityText
        .trim()
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[\s_-]+/g, " ")
    : `source-change:${packet.change.id}`;
  const entityBase = entityText ? slugPart(entityText) : "unscoped-event";
  const entityHash = createHash("sha256").update(entityCanonical).digest("hex").slice(0, 8);
  const eventKey = effectiveDay ?? `change-${packet.change.id.replaceAll("-", "").slice(0, 12)}`;
  const entityKey = `${entityBase}-${entityHash}-${eventKey}`;
  const identity = `${packet.provider.slug}|${topicKey}|${entityKey}`;
  const canonicalSlug = [
    slugPart(packet.provider.slug),
    topicKey,
    `${entityBase.slice(0, 48)}-${entityHash}`,
    eventKey,
  ]
    .join("-")
    .slice(0, 180)
    .replace(/-+$/g, "");
  return { topicKey, entityKey, identity, canonicalSlug };
}

export function evidenceFingerprint(packet: PublicIntelligencePacket) {
  const evidence = [...packet.evidenceReferences]
    .map((item) => `${item.sourceId}|${item.type}|${item.excerpt.trim().toLowerCase()}`)
    .sort()
    .join("\n");
  return createHash("sha256")
    .update(`${packet.change.id}|${packet.change.classificationId}|${evidence}`)
    .digest("hex");
}
