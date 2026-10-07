import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  assessCustomerImpact,
  IMPACT_ENGINE_VERSION,
  type CustomerImpactClassifier,
  type CustomerImpactRepository,
} from "@/lib/impact/impact";
import {
  listCustomerImpactQueueItems,
  markCustomerImpactQueueComplete,
  markCustomerImpactQueueDispatched,
} from "@/lib/impact/impact-repository";
import {
  classifySourceChange,
  type ChangeClassificationRepository,
  type SemanticClassifier,
} from "@/lib/monitoring/classification";
import { scanSource } from "@/lib/monitoring/scan";
import type { MonitoringRepository } from "@/lib/monitoring/repository";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assertM15LocalAcceptanceEnabled } from "@/lib/m15/local-supabase-binding";

const InputSchema = z
  .object({
    sourceId: z.string().uuid(),
    workspaceDependencyId: z.string().uuid(),
    additionalWorkspaceDependencyIds: z.array(z.string().uuid()).max(19).default([]),
    runIdPrefix: z
      .string()
      .trim()
      .min(8)
      .max(180)
      .regex(/^[A-Za-z0-9._:-]+$/),
    baselineContent: z.string().min(1).max(32_000),
    changedContent: z.string().min(1).max(32_000),
    decision: z.enum(["material", "non_material"]),
    internalQaEvidence: z
      .object({
        oldExpression: z.string().trim().min(1).max(240),
        newExpression: z.string().trim().min(1).max(240),
        evidenceSourceUrl: z.string().url().startsWith("https://"),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.baselineContent === value.changedContent) {
      context.addIssue({
        code: "custom",
        path: ["changedContent"],
        message: "Content must change.",
      });
    }
    if (value.internalQaEvidence.oldExpression === value.internalQaEvidence.newExpression) {
      context.addIssue({
        code: "custom",
        path: ["internalQaEvidence", "newExpression"],
        message: "Synthetic replacement expressions must differ.",
      });
    }
  });

export type PersistedSyntheticChangeInput = z.input<typeof InputSchema>;

export interface InternalQaEvidenceRepository {
  persist(input: {
    sourceChangeId: string;
    oldExpression: string;
    newExpression: string;
    evidenceSourceUrl: string;
    evidenceFingerprint: string;
    synthetic: true;
    internalQa: true;
    publicEligible: false;
  }): Promise<void>;
}

export type SyntheticImpactQueueItem = {
  queue_id: string;
  workspace_dependency_id: string;
  source_change_classification_id: string;
  context_revision: number;
};

export type PersistedSyntheticChangeDependencies = {
  monitoringRepository?: MonitoringRepository;
  classificationRepository?: ChangeClassificationRepository;
  impactRepository?: CustomerImpactRepository;
  classifier: SemanticClassifier;
  impactClassifier: CustomerImpactClassifier;
  evidenceRepository?: InternalQaEvidenceRepository;
  listImpactQueue?: (sourceChangeId?: string) => Promise<SyntheticImpactQueueItem[]>;
  markImpactDispatched?: (queueId: string) => Promise<void>;
  markImpactComplete?: (queueId: string) => Promise<void>;
  fetcher?: Parameters<typeof scanSource>[1] extends { fetcher?: infer T } ? T : never;
};

/**
 * Runs an internal-only change through the production persistence services.
 * The caller supplies an isolated QA source/workspace dependency and deterministic
 * classifiers; this function never calls the live model or enqueues a Trigger task.
 */
export async function runPersistedSyntheticChange(
  rawInput: PersistedSyntheticChangeInput,
  dependencies: PersistedSyntheticChangeDependencies,
) {
  assertM15LocalAcceptanceEnabled({
    enabled: process.env.AUTERIM_M15_LOCAL_INTEGRATION,
    nodeEnv: process.env.NODE_ENV,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  const input = InputSchema.parse(rawInput);
  const expectedWorkspaceDependencyIds = new Set([
    input.workspaceDependencyId,
    ...input.additionalWorkspaceDependencyIds,
  ]);
  const responses = [input.baselineContent, input.changedContent];
  let responseIndex = 0;
  const fetcher =
    dependencies.fetcher ??
    (async () => {
      const body = responses[responseIndex++];
      if (body === undefined) throw new Error("Synthetic source returned more than two responses.");
      const bytes = Buffer.from(body, "utf8");
      return {
        status: 200,
        body: bytes,
        bytesRead: bytes.byteLength,
        bodyTruncated: false,
        contentType: "text/plain",
        safeHeaders: {},
        etag: null,
        lastModified: null,
        finalUrl: input.internalQaEvidence.evidenceSourceUrl,
      };
    });

  const baseline = await scanSource(
    { sourceId: input.sourceId, triggerRunId: `${input.runIdPrefix}:baseline`, attemptNumber: 1 },
    {
      ...(dependencies.monitoringRepository
        ? { repository: dependencies.monitoringRepository }
        : {}),
      fetcher,
      enqueueClassifier: async () => undefined,
    },
  );
  if (baseline.status !== "success") {
    throw new Error("Synthetic baseline scan did not create its initial snapshot.");
  }

  const scan = await scanSource(
    { sourceId: input.sourceId, triggerRunId: `${input.runIdPrefix}:change`, attemptNumber: 1 },
    {
      ...(dependencies.monitoringRepository
        ? { repository: dependencies.monitoringRepository }
        : {}),
      fetcher,
      enqueueClassifier: async () => undefined,
    },
  );
  if (scan.status !== "changed" || !scan.changeId) {
    throw new Error("Synthetic source change was not persisted by the monitoring service.");
  }

  const classification = await classifySourceChange(
    {
      changeId: scan.changeId,
      triggerRunId: `${input.runIdPrefix}:classification`,
      attemptNumber: 1,
    },
    {
      ...(dependencies.classificationRepository
        ? { repository: dependencies.classificationRepository }
        : {}),
      classifier: dependencies.classifier,
    },
  );

  if (classification.status !== "classified") {
    throw new Error("Synthetic source classification did not complete.");
  }

  if (
    input.decision === "material" &&
    (!classification.classification.material ||
      classification.classification.decisionStatus !== "classified")
  ) {
    throw new Error("The material QA fixture did not produce an eligible material classification.");
  }
  if (input.decision === "non_material" && classification.classification.material) {
    throw new Error("The non-material control fixture was classified as material.");
  }

  if (input.decision === "material") {
    await (dependencies.evidenceRepository ?? new SupabaseInternalQaEvidenceRepository()).persist({
      sourceChangeId: scan.changeId,
      ...input.internalQaEvidence,
      evidenceFingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            sourceChangeId: scan.changeId,
            ...input.internalQaEvidence,
          }),
        )
        .digest("hex"),
      synthetic: true,
      internalQa: true,
      publicEligible: false,
    });
  }

  const queueItems = await (dependencies.listImpactQueue ?? listCustomerImpactQueueItems)(
    scan.changeId,
  );
  const expectedItems = queueItems.filter((item) =>
    expectedWorkspaceDependencyIds.has(item.workspace_dependency_id),
  );
  const unexpectedWorkspaceItems = queueItems.filter(
    (item) => !expectedWorkspaceDependencyIds.has(item.workspace_dependency_id),
  );
  if (unexpectedWorkspaceItems.length > 0) {
    throw new Error("Synthetic QA change matched an unexpected workspace dependency.");
  }
  if (input.decision === "non_material" && queueItems.length > 0) {
    throw new Error("A non-material control unexpectedly entered the customer impact queue.");
  }
  if (input.decision === "material" && expectedItems.length === 0) {
    throw new Error(
      "Eligible material classification did not create its persisted impact queue row.",
    );
  }

  const impactAssessments = [];
  for (const item of expectedItems) {
    await (dependencies.markImpactDispatched ?? markCustomerImpactQueueDispatched)(item.queue_id);
    const assessment = await assessCustomerImpact({
      workspaceDependencyId: item.workspace_dependency_id,
      sourceChangeClassificationId: item.source_change_classification_id,
      triggerRunId: `${input.runIdPrefix}:impact:${item.queue_id}`,
      attemptNumber: 1,
      ...(dependencies.impactRepository ? { repository: dependencies.impactRepository } : {}),
      classifier: dependencies.impactClassifier,
    });
    if (assessment.status !== "assessed") {
      throw new Error("Persisted synthetic customer impact assessment did not complete.");
    }
    await (dependencies.markImpactComplete ?? markCustomerImpactQueueComplete)(item.queue_id);
    impactAssessments.push({
      queueId: item.queue_id,
      workspaceDependencyId: item.workspace_dependency_id,
      result: assessment,
    });
  }

  return {
    sourceChangeId: scan.changeId,
    baseline,
    scan,
    classification,
    queueItems,
    impactAssessments,
    syntheticEvidence:
      input.decision === "material" ? { internalQa: true, publicEligible: false } : null,
    impactEngineVersion: IMPACT_ENGINE_VERSION,
  };
}

class SupabaseInternalQaEvidenceRepository implements InternalQaEvidenceRepository {
  async persist(input: {
    sourceChangeId: string;
    oldExpression: string;
    newExpression: string;
    evidenceSourceUrl: string;
    evidenceFingerprint: string;
    synthetic: true;
    internalQa: true;
    publicEligible: false;
  }) {
    const client = createSupabaseServerClient();
    const { data: classification, error: lookupError } = await client
      .from("source_change_classifications")
      .select("id")
      .eq("change_id", input.sourceChangeId)
      .eq("status", "classified")
      .eq("material", true)
      .eq("decision_status", "classified")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lookupError || !classification?.id) {
      throw new Error("Could not bind internal QA evidence to its persisted classification.");
    }
    const { error } = await client.from("source_remediation_replacements").upsert(
      {
        source_change_id: input.sourceChangeId,
        source_change_classification_id: classification.id,
        old_expression: input.oldExpression,
        new_expression: input.newExpression,
        evidence_source_url: input.evidenceSourceUrl,
        evidence_fingerprint: input.evidenceFingerprint,
        synthetic: input.synthetic,
        internal_qa: input.internalQa,
        public_eligible: input.publicEligible,
      },
      { onConflict: "source_change_id,evidence_fingerprint", ignoreDuplicates: true },
    );
    if (error) throw new Error("Could not persist bounded internal QA evidence.");
  }
}
