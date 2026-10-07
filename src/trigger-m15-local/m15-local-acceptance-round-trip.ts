import { AbortTaskRunError, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const schema = z.object({ correlationId: z.string().uuid() });

/** Development-only proof that a real Trigger worker is bound to local Supabase. */
export const m15LocalAcceptanceRoundTripTask = schemaTask({
  id: "m15-local-acceptance-round-trip",
  schema,
  retry: { maxAttempts: 1 },
  queue: { concurrencyLimit: 1 },
  run: async ({ correlationId }, { ctx }) => {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1"
    ) {
      throw new AbortTaskRunError(
        "M15 local acceptance task is disabled outside local development.",
      );
    }
    const client = createSupabaseServerClient();
    const { data: provider, error } = await client
      .from("dependency_catalog")
      .select("slug")
      .eq("slug", "openai")
      .maybeSingle();
    if (error || provider?.slug !== "openai")
      throw new Error("local_round_trip_database_check_failed");

    const { error: persistError } = await client.from("m15_local_trigger_roundtrip").insert({
      correlation_id: correlationId,
      task_id: "m15-local-acceptance-round-trip",
      run_id: ctx.run.id,
    });
    if (persistError) throw new Error("local_round_trip_persistence_failed");
    return { status: "complete" as const, runId: ctx.run.id };
  },
});
