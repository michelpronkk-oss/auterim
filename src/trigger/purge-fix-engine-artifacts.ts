import { schedules } from "@trigger.dev/sdk";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabasePrivatePatchArtifactStore } from "@/lib/fix-engine/artifact-store";
import { removePrivateVerificationArtifacts } from "@/lib/fix-engine/verification-artifacts";

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
    let deletedPatches = 0;
    if (response.paths.length > 0) {
      await new SupabasePrivatePatchArtifactStore().remove({ paths: response.paths as string[] });
      const { data: completed, error: completeError } = await client.rpc(
        "complete_fix_patch_artifact_purge",
        { p_paths: response.paths },
      );
      if (completeError || completed !== response.paths.length)
        throw new Error("fix_artifact_retention_failed");
      deletedPatches = completed;
    }

    const { data: snapshotData, error: snapshotError } = await client.rpc(
      "claim_expired_fix_verification_snapshots",
      { p_limit: 100 },
    );
    const snapshots = snapshotData as { artifacts?: unknown; count?: unknown } | null;
    if (
      snapshotError ||
      !snapshots ||
      !Array.isArray(snapshots.artifacts) ||
      snapshots.artifacts.length > 100 ||
      snapshots.count !== snapshots.artifacts.length ||
      snapshots.artifacts.some((artifact) => {
        if (!artifact || typeof artifact !== "object") return true;
        const row = artifact as { workspaceId?: unknown; fixRunId?: unknown; path?: unknown };
        return (
          typeof row.workspaceId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.workspaceId) ||
          typeof row.fixRunId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.fixRunId) ||
          typeof row.path !== "string" ||
          !new RegExp(`^snapshots/${row.fixRunId}/[a-f0-9]{64}\\.tar\\.gz$`, "i").test(row.path)
        );
      })
    )
      throw new Error("fix_snapshot_retention_claim_failed");
    const paths = snapshots.artifacts.map((artifact) => (artifact as { path: string }).path);
    if (paths.length > 0) {
      await removePrivateVerificationArtifacts(paths);
      const { data: completed, error: completeError } = await client.rpc(
        "complete_fix_verification_snapshot_purge",
        { p_paths: paths },
      );
      if (completeError || completed !== paths.length)
        throw new Error("fix_snapshot_retention_complete_failed");
    }
    return { deletedArtifacts: deletedPatches + paths.length, deletedSnapshots: paths.length };
  },
});
