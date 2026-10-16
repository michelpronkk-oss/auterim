import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  ClassifierConfigurationError,
  classifySourceChange,
} from "@/lib/monitoring/classification";
import { dispatchCustomerImpactTask } from "@/trigger/dispatch-customer-impact";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { customerImpactDispatchAllowed } from "@/lib/monitoring/source-mode";

export const semanticClassifyChangeTask = schemaTask({
  id: "classify-source-change",
  schema: z.object({ sourceChangeId: z.string().uuid() }),
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 1_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
    randomize: true,
  },
  concurrency: { total: 4 },
  run: async ({ sourceChangeId }, { ctx }) => {
    try {
      const outcome = await classifySourceChange({
        changeId: sourceChangeId,
        triggerRunId: ctx.run.id,
        attemptNumber: ctx.attempt.number,
      });
      const supabase = createSupabaseServerClient();
      const { data: provenance, error: provenanceError } = await supabase
        .from("source_changes")
        .select("source_mode,processing_mode")
        .eq("id", sourceChangeId)
        .maybeSingle();
      if (provenanceError || !provenance) throw new Error("source_change_provenance_unavailable");
      const allowCustomerImpact = customerImpactDispatchAllowed(provenance);
      if (
        allowCustomerImpact &&
        outcome.status === "classified" &&
        outcome.classification.material &&
        outcome.classification.decisionStatus === "classified"
      ) {
        await dispatchCustomerImpactTask.trigger({ sourceChangeId });
      }
      return outcome;
    } catch (error) {
      if (error instanceof ClassifierConfigurationError) {
        throw new AbortTaskRunError(error.message);
      }
      throw error;
    }
  },
});
