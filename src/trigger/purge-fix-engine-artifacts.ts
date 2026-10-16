import { schedules } from "@trigger.dev/sdk";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabasePrivatePatchArtifactStore } from "@/lib/fix-engine/artifact-store";

export const purgeFixEngineArtifactsTask = schedules.task({
  id: "purge-fix-engine-artifacts",
  cron: { pattern: "17 3 * * *", timezone: "UTC" },
  maxDuration: 60,
  run: async () => {
    const client = createSupabaseServerClient();
    const { data, error } = await client.rpc("purge_expired_fix_patch_artifacts", { p_limit: 100 });
    const response = data as { paths?: unknown; count?: unknown } | null;
    if (
      error ||
      !response ||
      !Array.isArray(response.paths) ||
      response.paths.length > 100 ||
      response.count !== response.paths.length ||
      response.paths.some(
        (path) => typeof path !== "string" || !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.diff$/i.test(path),
      )
    )
      throw new Error("fix_artifact_retention_failed");
    if (response.paths.length === 0) return { deletedArtifacts: 0 };
    await new SupabasePrivatePatchArtifactStore().remove({ paths: response.paths as string[] });
    const { data: completed, error: completeError } = await client.rpc(
      "complete_fix_patch_artifact_purge",
      { p_paths: response.paths },
    );
    if (completeError || completed !== response.paths.length)
      throw new Error("fix_artifact_retention_failed");
    return { deletedArtifacts: completed };
  },
});
