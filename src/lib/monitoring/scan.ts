import "server-only";
import { deterministicDiff, hashContent, normalizeContent } from "@/lib/monitoring/content";
import { fetchHttpSource, SafeFetchError } from "@/lib/monitoring/fetcher";
import { enqueueSemanticClassification } from "@/lib/monitoring/classification-queue";
import type { MonitoringRepository, Snapshot } from "@/lib/monitoring/repository";
import { SupabaseMonitoringRepository } from "@/lib/monitoring/repository";

type ScanDependencies = {
  repository?: MonitoringRepository;
  fetcher?: typeof fetchHttpSource;
  enqueueClassifier?: (changeId: string) => Promise<unknown>;
};

export async function scanSource(
  input: { sourceId: string; triggerRunId: string; attemptNumber: number },
  dependencies: ScanDependencies = {},
) {
  const repository = dependencies.repository ?? new SupabaseMonitoringRepository();
  const fetcher = dependencies.fetcher ?? fetchHttpSource;
  const source = await repository.getSource(input.sourceId);
  if (!source.enabled) throw new Error("Monitoring source is disabled.");

  const run = await repository.beginScan(input.sourceId, input.triggerRunId, input.attemptNumber);
  if (run.status !== "pending") {
    return {
      status: run.status,
      snapshotId: run.snapshotId,
      changeId: run.changeId,
      replayed: true,
    };
  }

  let httpStatus: number | null = null;
  try {
    const response = await fetcher(source.url, {
      etag: source.etag,
      lastModified: source.last_modified,
    });
    httpStatus = response.status;
    if (response.status === 304) {
      return await persist(repository, {
        p_scan_run_id: run.scanRunId,
        p_source_id: source.id,
        p_http_status: 304,
        p_content_bytes: 0,
        p_not_modified: true,
        p_content_hash: null,
        p_normalized_content: null,
        p_etag: response.etag,
        p_last_modified: response.lastModified,
        p_expected_previous_snapshot_id: null,
        p_diff_text: "",
        p_added_lines: 0,
        p_removed_lines: 0,
        p_diff_truncated: false,
        p_previous_bytes: 0,
        p_new_bytes: 0,
      });
    }

    const normalized = normalizeContent(
      response.body.toString("utf8"),
      response.contentType !== "text/plain",
    );
    const contentHash = hashContent(normalized);
    let previous = await repository.getLatestSnapshot(source.id);
    for (let tries = 0; tries < 5; tries++) {
      const diff = previous
        ? deterministicDiff(previous.normalizedContent, normalized)
        : { text: "", addedLines: 0, removedLines: 0, truncated: false };
      const outcome = await repository.recordResult({
        p_scan_run_id: run.scanRunId,
        p_source_id: source.id,
        p_http_status: response.status,
        p_content_bytes: response.body.byteLength,
        p_not_modified: false,
        p_content_hash: contentHash,
        p_normalized_content: normalized,
        p_etag: response.etag,
        p_last_modified: response.lastModified,
        p_expected_previous_snapshot_id: previous?.id ?? null,
        p_diff_text: diff.text,
        p_added_lines: diff.addedLines,
        p_removed_lines: diff.removedLines,
        p_diff_truncated: diff.truncated,
        p_previous_bytes: previous?.normalizedBytes ?? 0,
        p_new_bytes: Buffer.byteLength(normalized, "utf8"),
      });
      if (outcome.status !== "stale") {
        if (outcome.status === "changed" && outcome.changeId) {
          try {
            await (dependencies.enqueueClassifier ?? enqueueSemanticClassification)(
              outcome.changeId,
            );
          } catch {
            console.warn("Could not enqueue semantic classification; it remains discoverable.", {
              changeId: outcome.changeId,
              errorCategory: "enqueue_error",
            });
          }
        }
        return outcome;
      }
      previous = outcome.previous as Snapshot | null;
    }
    throw new Error("Source changed too often to serialize the scan result.");
  } catch (error) {
    const safeError =
      error instanceof SafeFetchError
        ? error
        : new SafeFetchError("processing_error", "Source processing failed.", httpStatus);
    await repository
      .recordFailure({
        scanRunId: run.scanRunId,
        sourceId: source.id,
        category: safeError.category,
        summary: safeError.message,
        httpStatus: safeError.httpStatus ?? httpStatus,
      })
      .catch(() => undefined);
    throw error;
  }
}

async function persist(repository: MonitoringRepository, result: Record<string, unknown>) {
  const outcome = await repository.recordResult(result);
  if (outcome.status === "stale")
    throw new Error("A not-modified response cannot be reconciled without a baseline.");
  return outcome;
}
