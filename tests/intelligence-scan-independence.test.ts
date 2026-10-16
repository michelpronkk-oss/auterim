import { describe, expect, it, vi } from "vitest";
import { scanSource } from "@/lib/monitoring/scan";
import type { MonitoringRepository } from "@/lib/monitoring/repository";

function repository(): MonitoringRepository {
  return {
    getSource: vi.fn(async () => ({
      id: "source-id",
      url: "https://source.example",
      enabled: true,
      source_mode: "provider" as const,
      processing_mode: "customer" as const,
      workspace_id: null,
      scope_product_id: null,
      etag: null,
      last_modified: null,
    })),
    beginScan: vi.fn(async () => ({
      scanRunId: "00000000-0000-4000-8000-000000000001",
      status: "pending" as const,
      snapshotId: null,
      changeId: null,
    })),
    getLatestSnapshot: vi.fn(async () => ({
      id: "snapshot-id",
      version: 1,
      contentHash: "a".repeat(64),
      normalizedContent: "old behavior",
      normalizedBytes: 12,
    })),
    recordResult: vi.fn(async () => ({
      status: "changed" as const,
      snapshotId: "00000000-0000-4000-8000-000000000002",
      changeId: "00000000-0000-4000-8000-000000000003",
      version: 2,
    })),
    recordFailure: vi.fn(async () => undefined),
  };
}

const fetcher = vi.fn(async () => ({
  status: 200,
  body: Buffer.from("new behavior"),
  contentType: "text/plain",
  etag: null,
  lastModified: null,
  finalUrl: "https://source.example",
  contentLength: 12,
  bytesRead: 12,
  bodyTruncated: false,
  wireBytesRead: 12,
}));

describe("independent scan fan-out", () => {
  it("enqueues Jev even when the existing classifier dispatch fails", async () => {
    const repo = repository();
    const enqueueIntelligence = vi.fn(async () => undefined);
    const result = await scanSource(
      { sourceId: "source-id", triggerRunId: "run", attemptNumber: 1 },
      {
        repository: repo,
        fetcher: fetcher as never,
        enqueueClassifier: async () => {
          throw new Error("classifier transport failure");
        },
        enqueueIntelligence,
      },
    );
    expect(result.status).toBe("changed");
    expect(enqueueIntelligence).toHaveBeenCalledOnce();
  });

  it("preserves classifier enqueue and deterministic scan success when Jev dispatch fails", async () => {
    const repo = repository();
    const enqueueClassifier = vi.fn(async () => undefined);
    const result = await scanSource(
      { sourceId: "source-id", triggerRunId: "run", attemptNumber: 1 },
      {
        repository: repo,
        fetcher: fetcher as never,
        enqueueClassifier,
        enqueueIntelligence: async () => {
          throw new Error("Jev transport failure");
        },
      },
    );
    expect(result.status).toBe("changed");
    expect(enqueueClassifier).toHaveBeenCalledOnce();
    expect(repo.recordFailure).not.toHaveBeenCalled();
  });

  it("rejects internal evidence sources through the normal provider scan entry point", async () => {
    const repo = repository();
    vi.mocked(repo.getSource).mockResolvedValue({
      id: "source-id",
      url: "https://internal-test.invalid/evidence",
      enabled: true,
      source_mode: "internal_test",
      processing_mode: "evidence_only",
      workspace_id: "00000000-0000-4000-8000-000000000010",
      scope_product_id: "00000000-0000-4000-8000-000000000011",
      etag: null,
      last_modified: null,
    });
    await expect(
      scanSource(
        { sourceId: "source-id", triggerRunId: "provider-worker", attemptNumber: 1 },
        { repository: repo, fetcher: fetcher as never },
      ),
    ).rejects.toThrow("Internal evidence source scope is not authorized.");
    expect(repo.beginScan).not.toHaveBeenCalled();
  });
});
