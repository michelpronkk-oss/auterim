import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CustomerImpactRepository,
  CustomerImpactClassifier,
  ImpactAssessmentStart,
} from "@/lib/impact/impact";
import type { ChangeClassificationRepository } from "@/lib/monitoring/classification";
import type { MonitoringRepository, ScanOutcome, Snapshot } from "@/lib/monitoring/repository";
import {
  runPersistedSyntheticChange,
  type InternalQaEvidenceRepository,
  type PersistedSyntheticChangeInput,
  type SyntheticImpactQueueItem,
} from "@/lib/m15/persisted-synthetic-change";
import type { SemanticClassifier } from "@/lib/monitoring/classification";

const sourceId = "11111111-1111-4111-8111-111111111111";
const workspaceDependencyId = "22222222-2222-4222-8222-222222222222";
const foreignWorkspaceDependencyId = "33333333-3333-4333-8333-333333333333";
const changeId = "44444444-4444-4444-8444-444444444444";
const queueId = "55555555-5555-4555-8555-555555555555";
const classificationId = "66666666-6666-4666-8666-666666666666";

function input(decision: "material" | "non_material"): PersistedSyntheticChangeInput {
  return {
    sourceId,
    workspaceDependencyId,
    runIdPrefix: `qa-${decision}-fixture-01`,
    baselineContent: "fixture-client version 1 supports create()",
    changedContent: "fixture-client version 2 removes create()",
    decision,
    internalQaEvidence: {
      oldExpression: "fixtureClient.create()",
      newExpression: "fixtureClient.initialize()",
      evidenceSourceUrl: "https://internal-qa.auterim.invalid/m15/fixture",
    },
  };
}

function fixture() {
  const scanRuns = new Map<
    string,
    { scanRunId: string; status: string; snapshotId: string | null; changeId: string | null }
  >();
  let latestSnapshot: Snapshot | null = null;
  let scanCounter = 0;
  const monitoring: MonitoringRepository = {
    async getSource(id) {
      return {
        id,
        url: "https://internal-qa.auterim.invalid/m15/source",
        enabled: true,
        etag: null,
        last_modified: null,
      };
    },
    async beginScan(_id, triggerRunId) {
      const existing = scanRuns.get(triggerRunId);
      if (existing)
        return {
          ...existing,
          status: existing.status as
            "pending" | "success" | "unchanged" | "changed" | "not_modified" | "failed",
        };
      const created = {
        scanRunId: `scan-${++scanCounter}` as unknown as string,
        status: "pending",
        snapshotId: null,
        changeId: null,
      };
      scanRuns.set(triggerRunId, created);
      return { ...created, status: "pending" as const };
    },
    async getLatestSnapshot() {
      return latestSnapshot;
    },
    async recordResult(raw) {
      const scanRunId = String(raw.p_scan_run_id);
      const run = [...scanRuns.values()].find((candidate) => candidate.scanRunId === scanRunId)!;
      if (run.status !== "pending") {
        return {
          status: run.status as ScanOutcome["status"],
          snapshotId: run.snapshotId!,
          changeId: run.changeId,
          replayed: true,
        } as ScanOutcome;
      }
      const next: Snapshot = {
        id: `snapshot-${scanCounter}` as unknown as string,
        version: (latestSnapshot?.version ?? 0) + 1,
        contentHash: String(raw.p_content_hash),
        normalizedContent: String(raw.p_normalized_content),
        normalizedBytes: Number(raw.p_new_bytes),
      };
      const status = latestSnapshot ? "changed" : "success";
      latestSnapshot = next;
      Object.assign(run, {
        status,
        snapshotId: next.id,
        changeId: status === "changed" ? changeId : null,
      });
      return {
        status,
        snapshotId: next.id,
        ...(status === "changed" ? { changeId } : {}),
      } as ScanOutcome;
    },
    async recordFailure() {
      throw new Error("Unexpected fixture scan failure.");
    },
  };

  const classification: ChangeClassificationRepository = {
    async begin() {
      return {
        status: "processing",
        changeId,
        schemaVersion: 1,
        promptVersion: "materiality-v1",
        classifierVersion: "semantic-v1",
        provider: "openai",
        evidenceFingerprint: "a".repeat(32),
        change: {
          sourceName: "Internal QA fixture source",
          sourceType: "changelog",
          sourceUrl: "https://internal-qa.auterim.invalid/m15/source",
          dependencyName: "Internal QA fixture dependency",
          beforeVersion: 1,
          afterVersion: 2,
          diffText:
            "-fixture-client version 1 supports create()\n+fixture-client version 2 removes create()",
          addedLines: 1,
          removedLines: 1,
          diffTruncated: false,
          beforeBytes: 40,
          afterBytes: 42,
        },
      };
    },
    async record(value) {
      return {
        status: "classified",
        changeId: value.changeId,
        classification: value.result,
        replayed: false,
      };
    },
    async fail() {
      throw new Error("Unexpected fixture classification failure.");
    },
  };

  const impactPacket = {
    dependencyName: "Internal QA fixture dependency",
    globalChange: {
      sourceType: "changelog",
      material: true as const,
      category: "api_change",
      summary: "The fixture-client create API was removed.",
      affectedEntities: ["fixture-client"],
      severityHint: "high",
      confidence: 0.95,
      evidence: [{ type: "added", excerpt: "fixture-client version 2 removes create()" }],
    },
    context: {
      criticality: "important",
      productionCritical: false,
      usedFor: ["customer-facing product"],
      contextNote: "Uses fixture-client for customer-facing requests.",
      usageMetadata: {},
    },
  };
  const impact: CustomerImpactRepository = {
    async loadPacket() {
      return impactPacket;
    },
    async begin(): Promise<ImpactAssessmentStart> {
      return { status: "processing", id: classificationId, attemptCount: 1 };
    },
    async record(value) {
      return { status: "assessed", id: value.id, replayed: false, result: value.result };
    },
    async fail() {
      throw new Error("Unexpected fixture impact failure.");
    },
  };

  const queueItem: SyntheticImpactQueueItem = {
    queue_id: queueId,
    workspace_dependency_id: workspaceDependencyId,
    source_change_classification_id: classificationId,
    context_revision: 1,
  };
  const evidence: InternalQaEvidenceRepository = {
    async persist(value) {
      expect(value).toMatchObject({ synthetic: true, internalQa: true, publicEligible: false });
      expect(value.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
    },
  };
  const classifier: SemanticClassifier = {
    providerId: "openai",
    modelId: "fixture/classifier",
    async classify() {
      const material = decisionForClassifier === "material";
      return {
        inputTokens: 0,
        outputTokens: 0,
        classification: {
          material,
          category: material ? "api_change" : "documentation",
          affectedEntities: material ? ["fixture-client"] : [],
          severityHint: material ? "high" : "informational",
          confidence: 0.95,
          summary: material
            ? "The fixture client API changed."
            : "The fixture documentation changed.",
          evidence: material
            ? [{ type: "added" as const, excerpt: "fixture-client version 2 removes create()" }]
            : [],
          reasoningSummary: "Deterministic internal QA fixture decision.",
        },
      };
    },
  };
  let decisionForClassifier: "material" | "non_material" = "material";
  const impactClassifier: CustomerImpactClassifier = {
    providerId: "openai",
    modelId: "fixture/impact",
    async classify(packet) {
      return {
        inputTokens: 0,
        outputTokens: 0,
        result: {
          relevant: true,
          relevance: "low",
          severity: "low",
          affectedAreas: ["customer-facing product"],
          impactSummary: "The affected fixture client is used by this workspace.",
          whyItMatters: "The source reports that the client API changed.",
          actionRequired: false,
          recommendedAction: null,
          confidence: 0.95,
          missingContext: [],
          evidenceRefs: [
            { source: "global_evidence", excerpt: packet.globalChange.evidence[0]!.excerpt },
            { source: "dependency_context", excerpt: packet.context.contextNote },
          ],
        },
      };
    },
  };

  return {
    monitoring,
    classification,
    impact,
    queueItem,
    evidence,
    classifier,
    impactClassifier,
    setDecision(decision: "material" | "non_material") {
      decisionForClassifier = decision;
    },
  };
}

describe("persisted synthetic change harness", () => {
  beforeEach(() => vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("refuses production and non-local execution before scanning", async () => {
    const f = fixture();
    const beginScan = vi.spyOn(f.monitoring, "beginScan");
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      runPersistedSyntheticChange(input("material"), {
        monitoringRepository: f.monitoring,
        classificationRepository: f.classification,
        impactRepository: f.impact,
        classifier: f.classifier,
        impactClassifier: f.impactClassifier,
        evidenceRepository: f.evidence,
        listImpactQueue: async () => [f.queueItem],
      }),
    ).rejects.toThrow("m15_local_acceptance_production_forbidden");
    expect(beginScan).not.toHaveBeenCalled();

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "0");
    await expect(
      runPersistedSyntheticChange(input("material"), {
        monitoringRepository: f.monitoring,
        classificationRepository: f.classification,
        impactRepository: f.impact,
        classifier: f.classifier,
        impactClassifier: f.impactClassifier,
        evidenceRepository: f.evidence,
        listImpactQueue: async () => [f.queueItem],
      }),
    ).rejects.toThrow("m15_local_acceptance_flag_required");
    expect(beginScan).not.toHaveBeenCalled();
  });

  it("runs a material fixture through scan, classification, queue, and impact persistence", async () => {
    const f = fixture();
    const markDispatched = vi.fn(async () => undefined);
    const markComplete = vi.fn(async () => undefined);
    const result = await runPersistedSyntheticChange(input("material"), {
      monitoringRepository: f.monitoring,
      classificationRepository: f.classification,
      impactRepository: f.impact,
      classifier: f.classifier,
      impactClassifier: f.impactClassifier,
      evidenceRepository: f.evidence,
      listImpactQueue: async () => [f.queueItem],
      markImpactDispatched: markDispatched,
      markImpactComplete: markComplete,
    });

    expect(result.scan.status).toBe("changed");
    expect(result.classification.classification.material).toBe(true);
    expect(result.queueItems).toEqual([f.queueItem]);
    expect(result.impactAssessments).toHaveLength(1);
    expect(markDispatched).toHaveBeenCalledWith(queueId);
    expect(markComplete).toHaveBeenCalledWith(queueId);
    expect(result.syntheticEvidence).toEqual({ internalQa: true, publicEligible: false });
  });

  it("keeps a non-material control out of the customer impact queue", async () => {
    const f = fixture();
    f.setDecision("non_material");
    const persistEvidence = vi.fn(async () => undefined);
    const result = await runPersistedSyntheticChange(input("non_material"), {
      monitoringRepository: f.monitoring,
      classificationRepository: f.classification,
      impactRepository: f.impact,
      classifier: f.classifier,
      impactClassifier: f.impactClassifier,
      evidenceRepository: { persist: persistEvidence },
      listImpactQueue: async () => [],
    });

    expect(result.classification.classification.material).toBe(false);
    expect(result.queueItems).toEqual([]);
    expect(result.impactAssessments).toEqual([]);
    expect(persistEvidence).not.toHaveBeenCalled();
  });

  it("refuses to assess or dispatch an unrelated workspace queue row", async () => {
    const f = fixture();
    const foreignItem = { ...f.queueItem, workspace_dependency_id: foreignWorkspaceDependencyId };
    const assess = vi.spyOn(f.impact, "record");
    const dispatched = vi.fn(async () => undefined);
    await expect(
      runPersistedSyntheticChange(input("material"), {
        monitoringRepository: f.monitoring,
        classificationRepository: f.classification,
        impactRepository: f.impact,
        classifier: f.classifier,
        impactClassifier: f.impactClassifier,
        evidenceRepository: f.evidence,
        listImpactQueue: async () => [foreignItem],
        markImpactDispatched: dispatched,
      }),
    ).rejects.toThrow("Synthetic QA change matched an unexpected workspace dependency.");
    expect(dispatched).not.toHaveBeenCalled();
    expect(assess).not.toHaveBeenCalled();
  });
});
