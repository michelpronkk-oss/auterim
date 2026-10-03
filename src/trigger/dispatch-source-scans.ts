import { schedules } from "@trigger.dev/sdk";
import { enqueueSemanticClassification } from "@/lib/monitoring/classification-queue";
import { SupabaseChangeClassificationRepository } from "@/lib/monitoring/classification-repository";
import { SupabaseMonitoringRepository } from "@/lib/monitoring/repository";
import { scanSourceTask } from "@/trigger/scan-source";

export const dispatchSourceScans = schedules.task({
  id: "dispatch-source-scans",
  cron: { pattern: "15 1 * * *", timezone: "UTC" },
  run: async () => {
    const dueSourceIds = await new SupabaseMonitoringRepository().getDueSourceIds(new Date(), 100);
    for (const sourceId of dueSourceIds) {
      await scanSourceTask.trigger({ sourceId });
    }
    const queuedChanges = await new SupabaseChangeClassificationRepository().getQueuedChangeIds(
      100,
    );
    let classificationsDispatched = 0;
    for (const changeId of queuedChanges) {
      try {
        await enqueueSemanticClassification(changeId);
        classificationsDispatched++;
      } catch {
        console.warn("Could not enqueue queued semantic classification.", {
          changeId,
          errorCategory: "enqueue_error",
        });
      }
    }
    console.info("Dispatched due Auterim work", {
      scans: dueSourceIds.length,
      classifications: classificationsDispatched,
    });
    return {
      dispatchedScans: dueSourceIds.length,
      dispatchedClassifications: classificationsDispatched,
    };
  },
});
