import { describe, expect, it } from "vitest";
import {
  canonicalTopicIdentity,
  validatePublicIntelligencePacket,
  validatePublishableFields,
} from "@/lib/growth/contract";
import type { PublicIntelligencePacket } from "@/lib/growth/contract";
import { evaluatePublicIntelligencePacket } from "@/lib/growth/evaluator";

const now = new Date("2026-10-03T12:00:00.000Z");
const changeId = "6f9d86b0-738f-4b28-8554-46a5ce0a6237";
const classificationId = "22b45b4b-0385-45ae-b38d-4579e3326601";
const sourceId = "113787b5-f7af-4d62-aabd-a0bd4ab0e923";
const secondChangeId = "bd044dde-68b5-4a14-95de-f4b1f1367ed1";
const secondClassId = "30654591-df15-4654-801a-3803a8680045";
const secondSourceId = "d64f49c2-3b43-4338-8155-f54f9096800e";

function packet(overrides: Partial<PublicIntelligencePacket> = {}): PublicIntelligencePacket {
  return {
    schemaVersion: 1,
    provider: { slug: "openai", name: "OpenAI", websiteUrl: "https://openai.com/" },
    dependency: { slug: "openai", name: "OpenAI", category: "ai" },
    source: {
      id: sourceId,
      name: "OpenAI API changelog",
      type: "changelog",
      url: "https://platform.openai.com/docs/changelog",
      authoritativeSourceCount: 4,
    },
    publicSources: [
      {
        id: sourceId,
        name: "OpenAI API changelog",
        type: "changelog",
        url: "https://platform.openai.com/docs/changelog",
      },
    ],
    change: {
      id: changeId,
      classificationId,
      detectedAt: "2026-10-03T10:00:00.000Z",
      announcedAt: null,
      effectiveAt: "2026-11-20T00:00:00.000Z",
      material: true,
      category: "deprecation",
      severity: "high",
      confidence: 0.92,
      affectedPublicEntities: ["GPT-4o"],
      summary:
        "The provider announced retirement of a model endpoint and documents a migration path with updated request parameters, supported replacement models, and a deadline for applications that still call the existing endpoint.",
    },
    evidenceReferences: [
      {
        sourceId,
        sourceChangeId: changeId,
        classificationId,
        sourceUrl: "https://platform.openai.com/docs/changelog",
        type: "changed",
        excerpt:
          "GPT-4o retires on 2026-11-20; migrate requests to the supported replacement model.",
      },
    ],
    freshness: "upcoming",
    ageDays: 0,
    effectiveInDays: 48,
    originalUtilityFacts: [
      "effective_date_context",
      "structured_affected_entity_context",
      "change_history_context",
    ],
    ...overrides,
  } as PublicIntelligencePacket;
}

function corroborate(input: PublicIntelligencePacket = packet()) {
  const value = structuredClone(input);
  value.publicSources.push({
    id: secondSourceId,
    name: "OpenAI migration guide",
    type: "docs",
    url: "https://platform.openai.com/docs/guides/migrate",
  });
  value.evidenceReferences.push({
    sourceId: secondSourceId,
    sourceChangeId: secondChangeId,
    classificationId: secondClassId,
    sourceUrl: "https://platform.openai.com/docs/guides/migrate",
    type: "added",
    excerpt: "For GPT-4o, the documented endpoint retirement date is 2026-11-20.",
  });
  return value;
}

describe("Growth Engine public packet boundary", () => {
  it("accepts a valid packet with explicitly allowlisted public source URLs", () => {
    expect(validatePublicIntelligencePacket(packet()).safe).toBe(true);
  });

  it.each([
    "https://[::1]/private",
    "https://127.0.0.1/private",
    "https://10.1.2.3/private",
    "https://192.168.1.2/private",
    "https://172.20.1.2/private",
    "https://169.254.169.254/latest/meta-data",
    "https://provider.example/customer/acme",
    "https://provider.example/%63ustomer/acme",
    "https://provider.example/customer%2Facme",
    "https://provider.example/tenant/acme",
    "https://provider.example/workspace/123456",
    "https://user:password@provider.example/public",
    "https://provider.example/public?signature=abc",
  ])("rejects unsafe typed source URL %s", (url) => {
    const invalid = packet({
      source: { ...packet().source, url },
      publicSources: [{ ...packet().publicSources[0], url }],
      evidenceReferences: [{ ...packet().evidenceReferences[0], sourceUrl: url }],
    });
    expect(validatePublicIntelligencePacket(invalid).safe).toBe(false);
  });

  it.each([
    "Contact security@example.com before migrating.",
    "Use sk-proj-123456789012345678901234.",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345.",
    "Repository path src/private/customer.ts:14 contains the finding.",
    "Tenant ID: workspace_id=private-tenant-12345678.",
    "Internal link https://app.example.com/acme-corp/instance/123?sig=abcdef0123456789.",
  ])("rejects private text embedded in packet content: %s", (summary) => {
    expect(
      validatePublicIntelligencePacket(packet({ change: { ...packet().change, summary } })).safe,
    ).toBe(false);
  });

  it("requires primary evidence to match the evaluated source change and classification", () => {
    const invalid = packet({
      evidenceReferences: [{ ...packet().evidenceReferences[0], sourceChangeId: secondChangeId }],
    });
    expect(validatePublicIntelligencePacket(invalid).blockers).toContain(
      "primary_change_evidence_missing",
    );
  });

  it.each([
    { workspaceId: "00000000-0000-4000-8000-000000000010" },
    { repositoryPath: "src/customer/private.ts" },
    { tenantEmail: "private@example.com" },
  ])("rejects unsupported private packet fields", (extra) => {
    expect(validatePublicIntelligencePacket({ ...packet(), ...extra }).safe).toBe(false);
  });

  it("rejects unsafe generated fields even if the source packet was valid", () => {
    expect(
      validatePublishableFields({ summary: "Private tenant email jane@example.com" }).safe,
    ).toBe(false);
  });
});

describe("Growth Engine deterministic policy", () => {
  it("routes a strongly corroborated future retirement to a useful indexable page", async () => {
    const result = await evaluatePublicIntelligencePacket(corroborate(), now);
    expect(result.evaluation).toMatchObject({
      decision: "PUBLIC_PAGE",
      indexable: true,
      publicationReady: true,
    });
  });

  it("does not treat two excerpts from one source as independent corroboration", async () => {
    const sameSource = packet({
      evidenceReferences: [
        ...packet().evidenceReferences,
        {
          ...packet().evidenceReferences[0],
          excerpt: "The same source also identifies GPT-4o and its 2026-11-20 retirement.",
        },
      ],
    });
    expect((await evaluatePublicIntelligencePacket(sameSource, now)).evaluation.decision).toBe(
      "HUB_UPDATE",
    );
  });

  it("does not index a page without a future effective date", async () => {
    const noDate = corroborate(
      packet({
        change: { ...packet().change, effectiveAt: null },
        freshness: "current",
        effectiveInDays: null,
      }),
    );
    expect((await evaluatePublicIntelligencePacket(noDate, now)).evaluation.indexable).toBe(false);
  });

  it("ignores non-material documentation edits", async () => {
    const result = await evaluatePublicIntelligencePacket(
      packet({ change: { ...packet().change, material: false } }),
      now,
    );
    expect(result.evaluation.decision).toBe("IGNORE");
  });

  it("ignores materiality with weak confidence", async () => {
    const result = await evaluatePublicIntelligencePacket(
      packet({ change: { ...packet().change, confidence: 0.4 } }),
      now,
    );
    expect(result.evaluation.decision).toBe("IGNORE");
  });

  it.each([46, 90, 91, 366])("makes a %i day expired event non-publishable", async (days) => {
    const detectedAt = new Date(now.getTime() - days * 86_400_000).toISOString();
    const expired = corroborate(
      packet({
        change: { ...packet().change, detectedAt, effectiveAt: "2025-01-01T00:00:00.000Z" },
        ageDays: days,
        freshness: days > 365 ? "expired" : "stale",
      }),
    );
    const result = (await evaluatePublicIntelligencePacket(expired, now)).evaluation;
    expect(result.publicationReady).toBe(false);
    expect(result.indexable).toBe(false);
  });

  it("keeps an older announcement fresh when its effective date is still ahead", async () => {
    const announced = packet({
      change: {
        ...packet().change,
        detectedAt: "2026-06-01T00:00:00.000Z",
        effectiveAt: "2026-11-20T00:00:00.000Z",
      },
      ageDays: 124,
      freshness: "upcoming",
    });
    expect(
      (await evaluatePublicIntelligencePacket(corroborate(announced), now)).evaluation
        .publicationReady,
    ).toBe(true);
  });

  it("does not index generic long boilerplate without a specific change identifier", async () => {
    const boilerplate = packet({
      change: {
        ...packet().change,
        summary:
          "The provider has published an important update to its software service that customers should review before making plans. The document describes general requirements and implementation guidance for supported applications.",
      },
      publicSources: [
        ...packet().publicSources,
        {
          id: secondSourceId,
          name: "OpenAI migration guide",
          type: "docs",
          url: "https://platform.openai.com/docs/guides/migrate",
        },
      ],
      evidenceReferences: [
        {
          ...packet().evidenceReferences[0],
          excerpt:
            "A provider has published general documentation about a future migration deadline.",
        },
        {
          sourceId: secondSourceId,
          sourceChangeId: secondChangeId,
          classificationId: secondClassId,
          sourceUrl: "https://platform.openai.com/docs/guides/migrate",
          type: "added",
          excerpt:
            "A provider has published general documentation about a future migration deadline.",
        },
      ],
    });
    expect((await evaluatePublicIntelligencePacket(boilerplate, now)).evaluation.indexable).toBe(
      false,
    );
  });

  it("keeps distribution-only content non-indexable and without page CTAs", async () => {
    const result = await evaluatePublicIntelligencePacket(
      packet({
        change: {
          ...packet().change,
          category: "feature",
          affectedPublicEntities: [],
          confidence: 0.65,
        },
      }),
      now,
    );
    expect(result.evaluation).toMatchObject({
      decision: "DISTRIBUTION_ONLY",
      indexable: false,
      ctaTypes: [],
    });
  });

  it("separates a migration checker recommendation from an indexed page", async () => {
    const result = await evaluatePublicIntelligencePacket(
      packet({
        change: { ...packet().change, effectiveAt: null },
        freshness: "current",
        originalUtilityFacts: [],
      }),
      now,
    );
    expect(result.evaluation).toMatchObject({
      decision: "HUB_UPDATE",
      recommendedSurface: "FREE_TOOL",
      freeToolType: "MODEL_RETIREMENT_CHECKER",
      indexable: false,
      toolLinkPolicy: { indexable: false, rel: "nofollow" },
    });
  });
});

describe("Growth topic and slug stability", () => {
  it("consolidates the same provider/entity/category/effective date", () => {
    expect(canonicalTopicIdentity(packet())).toEqual(
      canonicalTopicIdentity(
        packet({
          change: {
            ...packet().change,
            summary: "A revised wording of this event while retaining the same date and entity.",
          },
        }),
      ),
    );
  });

  it("keeps different dated provider events separate", () => {
    expect(canonicalTopicIdentity(packet()).entityKey).not.toBe(
      canonicalTopicIdentity(
        packet({ change: { ...packet().change, effectiveAt: "2026-12-01T00:00:00.000Z" } }),
      ).entityKey,
    );
  });

  it("keeps events without effective dates distinct by stable source-change identity", () => {
    const first = packet({ change: { ...packet().change, effectiveAt: null } });
    const replay = packet({
      change: { ...packet().change, effectiveAt: null, summary: "A corrected summary." },
    });
    const another = packet({
      change: { ...packet().change, id: secondChangeId, effectiveAt: null },
    });
    expect(canonicalTopicIdentity(first).entityKey).toBe(canonicalTopicIdentity(replay).entityKey);
    expect(canonicalTopicIdentity(first).entityKey).not.toBe(
      canonicalTopicIdentity(another).entityKey,
    );
  });

  it("does not collide C and C++ entity labels after slug normalization", () => {
    expect(
      canonicalTopicIdentity(
        packet({ change: { ...packet().change, affectedPublicEntities: ["C"] } }),
      ).entityKey,
    ).not.toBe(
      canonicalTopicIdentity(
        packet({ change: { ...packet().change, affectedPublicEntities: ["C++"] } }),
      ).entityKey,
    );
  });

  it("keeps event identity inside the maximum-length canonical slug", () => {
    const long = packet({
      provider: {
        slug: "p".repeat(80),
        name: "Long Provider",
        websiteUrl: "https://long-provider.example/",
      },
      change: { ...packet().change, category: "a".repeat(40) },
    });
    const identity = canonicalTopicIdentity(long);
    expect(identity.canonicalSlug.length).toBeLessThanOrEqual(180);
    expect(identity.canonicalSlug.endsWith("20261120")).toBe(true);
  });

  it("retains a deterministic safe slug across replay", () => {
    expect(canonicalTopicIdentity(packet()).canonicalSlug).toBe(
      canonicalTopicIdentity(packet()).canonicalSlug,
    );
  });

  it("produces URL-safe lowercase slugs", () => {
    expect(canonicalTopicIdentity(packet()).canonicalSlug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});
