import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { scanSource } from "@/lib/monitoring/scan";
import type { FetchResult } from "@/lib/monitoring/fetcher";

const InputSchema = z
  .object({
    workspaceId: z.string().uuid(),
    productId: z.string().uuid(),
    dependencyId: z.string().uuid(),
    acceptanceKey: z.string().regex(/^[a-z0-9][a-z0-9_-]{7,95}$/),
    baseline: z.string().min(1).max(32_768),
    changed: z.string().min(1).max(32_768),
  })
  .strict();

function controlledResponse(body: string): FetchResult {
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
    finalUrl: "https://internal-test.invalid/evidence",
  };
}

/**
 * Internal acceptance input through the canonical scan/change persistence path.
 * The DB RPC binds the idempotency key to one already-protected workspace/Product;
 * scanSource persists snapshots and change provenance exactly as provider scans do.
 */
export async function persistInternalTestSourceChange(rawInput: z.input<typeof InputSchema>) {
  const input = InputSchema.parse(rawInput);
  const client = createSupabaseServerClient();
  const { data: sourceId, error } = await client.rpc("create_internal_test_source", {
    p_workspace_id: input.workspaceId,
    p_product_id: input.productId,
    p_dependency_id: input.dependencyId,
    p_internal_key: input.acceptanceKey,
  });
  if (error) throw new Error("internal_test_source_creation_failed");
  const parsedSourceId = z.string().uuid().parse(sourceId);
  const shared = {
    internalTestScope: { workspaceId: input.workspaceId, productId: input.productId },
    enqueueClassifier: async () => undefined,
    enqueueIntelligence: async () => undefined,
  };
  const baseline = await scanSource(
    {
      sourceId: parsedSourceId,
      triggerRunId: `internal-test:${input.acceptanceKey}:baseline`,
      attemptNumber: 1,
    },
    { ...shared, fetcher: async () => controlledResponse(input.baseline) },
  );
  if (baseline.status !== "success") throw new Error("internal_test_baseline_persistence_failed");
  const change = await scanSource(
    {
      sourceId: parsedSourceId,
      triggerRunId: `internal-test:${input.acceptanceKey}:change`,
      attemptNumber: 1,
    },
    { ...shared, fetcher: async () => controlledResponse(input.changed) },
  );
  if (change.status !== "changed" || !change.changeId)
    throw new Error("internal_test_change_persistence_failed");
  return {
    sourceId: parsedSourceId,
    sourceChangeId: change.changeId,
    replayed: "replayed" in change && change.replayed === true,
  };
}
