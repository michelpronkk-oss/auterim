import "server-only";
import { z } from "zod";
import type { RepositoryProvider } from "@/lib/preflight/preflight";
import {
  runPreflight,
  SupabasePreflightRepository,
  type PreflightRepository,
} from "@/lib/preflight/preflight-service";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { assertM15LocalAcceptanceEnabled } from "@/lib/m15/local-supabase-binding";
import type { runPersistedSyntheticChange } from "@/lib/m15/persisted-synthetic-change";

const QueueSchema = z.array(
  z.object({
    queue_id: z.string().uuid(),
    workspace_id: z.string().uuid(),
    impact_assessment_id: z.string().uuid(),
  }),
);
const DispatchAttemptSchema = z.number().int().positive();
const PersistedAssessmentSchema = z.object({
  status: z.literal("assessed"),
  id: z.string().uuid(),
});

type PersistedSyntheticChangeResult = Awaited<ReturnType<typeof runPersistedSyntheticChange>>;

export type PersistedPreflightAcceptanceDependencies = {
  repository?: PreflightRepository;
  client?: ReturnType<typeof createSupabaseServerClient>;
};

export type PinnedFixtureOutcome = "verified" | "not_found" | "inconclusive";

export function createPinnedFixtureRepositoryProvider(input: {
  outcome: PinnedFixtureOutcome;
  commitSha: string;
  affectedEntity: string;
  filePath?: string;
  fileContents?: string;
}): RepositoryProvider {
  const commitSha = z
    .string()
    .regex(/^[a-f0-9]{40,64}$/)
    .parse(input.commitSha);
  const affectedEntity = z.string().trim().min(3).max(120).parse(input.affectedEntity);
  const filePath = z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .parse(input.filePath ?? "src/client.ts");
  const assertPinnedRef = (ref: string) => {
    if (ref !== commitSha) throw new Error("fixture_repository_ref_mismatch");
  };

  return {
    async getHead() {
      return commitSha;
    },
    async searchCode(_repository, _query, ref) {
      assertPinnedRef(ref);
      if (input.outcome === "not_found") return [];
      return [
        {
          path: filePath,
          line: 1,
          text: "pinned internal fixture hit",
          ...(input.outcome === "inconclusive" ? { truncated: true } : {}),
        },
      ];
    },
    async getFile(_repository, path, ref) {
      assertPinnedRef(ref);
      if (input.outcome !== "verified" || path !== filePath) return null;
      const text =
        input.fileContents ?? `export const configuredEntity = ${JSON.stringify(affectedEntity)};`;
      return { path, text, size: Buffer.byteLength(text, "utf8") };
    },
  };
}

/**
 * Runs a service-produced customer impact assessment through the durable Preflight queue and
 * the normal persisted Preflight service. The supplied provider is expected to be a pinned,
 * deterministic fixture and is passed directly to runPreflight, avoiding live GitHub calls.
 */
export async function runPersistedPreflightAcceptance(input: {
  syntheticChange: PersistedSyntheticChangeResult;
  customerImpactQueueId: string;
  provider: RepositoryProvider;
  repository?: PreflightRepository;
  client?: ReturnType<typeof createSupabaseServerClient>;
}) {
  assertM15LocalAcceptanceEnabled({
    enabled: process.env.AUTERIM_M15_LOCAL_INTEGRATION,
    nodeEnv: process.env.NODE_ENV,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  const synthetic = input.syntheticChange;
  if (
    synthetic.classification.status !== "classified" ||
    !synthetic.classification.classification.material ||
    synthetic.classification.classification.decisionStatus !== "classified"
  ) {
    throw new Error("Preflight acceptance requires an eligible material synthetic change.");
  }

  const assessmentResult = synthetic.impactAssessments.find(
    (item) => item.queueId === input.customerImpactQueueId,
  )?.result;
  const assessment = PersistedAssessmentSchema.safeParse(assessmentResult);
  if (!assessment.success) {
    throw new Error("Preflight acceptance requires a persisted assessment from the synthetic run.");
  }

  const client = input.client ?? createSupabaseServerClient();
  const { data: queueData, error: queueError } = await client.rpc("list_preflight_dispatch_queue", {
    p_limit: 100,
  });
  if (queueError) throw new Error("preflight_acceptance_queue_list_failed");
  const queue = QueueSchema.parse(queueData ?? []);
  const matchingItems = queue.filter((item) => item.impact_assessment_id === assessment.data.id);
  const queueItem = matchingItems.length === 1 ? matchingItems[0] : undefined;
  if (!queueItem) {
    throw new Error(
      "Persisted Preflight queue item for the service-produced assessment was not found.",
    );
  }

  const { data: attemptData, error: dispatchError } = await client.rpc("mark_preflight_dispatch", {
    p_queue_id: queueItem.queue_id,
    p_status: "dispatched",
  });
  if (dispatchError || !DispatchAttemptSchema.safeParse(attemptData).success) {
    throw new Error("preflight_acceptance_dispatch_failed");
  }

  const repository = input.repository ?? new SupabasePreflightRepository();
  try {
    const outcome = await runPreflight({
      impactAssessmentId: assessment.data.id,
      repository,
      provider: input.provider,
    });
    if (outcome.status === "ineligible") {
      const { error } = await client.rpc("mark_preflight_dispatch", {
        p_queue_id: queueItem.queue_id,
        p_status: "superseded",
      });
      if (error) throw new Error("preflight_acceptance_queue_finalize_failed");
      return {
        queueId: queueItem.queue_id,
        customerImpactQueueId: input.customerImpactQueueId,
        workspaceId: queueItem.workspace_id,
        impactAssessmentId: assessment.data.id,
        attempt: attemptData,
        preflight: outcome,
        persisted: null,
        queueStatus: "superseded" as const,
      };
    }

    const expectedResult = outcome.result;
    if (!expectedResult) {
      throw new Error("Completed Preflight replay did not return its persisted result.");
    }
    const persisted =
      outcome.status === "replayed" ? expectedResult : await repository.loadResult(outcome.runId);
    if (!persisted || persisted.verifiedImpact !== expectedResult.verifiedImpact) {
      throw new Error("Preflight result was not confirmed through the persisted repository.");
    }

    const { error: completeError } = await client.rpc("mark_preflight_dispatch", {
      p_queue_id: queueItem.queue_id,
      p_status: "complete",
    });
    if (completeError) throw new Error("preflight_acceptance_queue_finalize_failed");
    return {
      queueId: queueItem.queue_id,
      customerImpactQueueId: input.customerImpactQueueId,
      workspaceId: queueItem.workspace_id,
      impactAssessmentId: assessment.data.id,
      attempt: attemptData,
      preflight: outcome,
      persisted,
      queueStatus: "complete" as const,
    };
  } catch (error) {
    await client.rpc("mark_preflight_dispatch", {
      p_queue_id: queueItem.queue_id,
      p_status: "failed",
      p_error_category: "fixture_preflight_failed",
    });
    throw error;
  }
}
