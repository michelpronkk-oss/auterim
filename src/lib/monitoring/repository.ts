import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const SourceSchema = z.object({
  id: z.string().uuid(),
  url: z.string().url(),
  enabled: z.boolean(),
  etag: z.string().nullable(),
  last_modified: z.string().nullable(),
});
const BeginSchema = z.object({
  scanRunId: z.string().uuid(),
  status: z.enum(["pending", "success", "unchanged", "changed", "not_modified", "failed"]),
  snapshotId: z.string().uuid().nullable(),
  changeId: z.string().uuid().nullable(),
});
const SnapshotSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  normalizedContent: z.string(),
  normalizedBytes: z.number().int(),
});
const ResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("stale"), previous: SnapshotSchema.nullable() }),
  z.object({
    status: z.enum(["success", "unchanged", "changed", "not_modified"]),
    snapshotId: z.string().uuid(),
    changeId: z.string().uuid().nullable().optional(),
    version: z.number().int().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    snapshotId: z.string().uuid().nullable(),
    changeId: z.string().uuid().nullable(),
    replayed: z.literal(true),
  }),
]);

export type MonitoringSource = z.infer<typeof SourceSchema>;
export type Snapshot = z.infer<typeof SnapshotSchema>;
export type ScanOutcome = z.infer<typeof ResultSchema>;

export interface MonitoringRepository {
  getSource(sourceId: string): Promise<MonitoringSource>;
  beginScan(
    sourceId: string,
    triggerRunId: string,
    attemptNumber: number,
  ): Promise<BeginSchemaType>;
  getLatestSnapshot(sourceId: string): Promise<Snapshot | null>;
  recordResult(input: Record<string, unknown>): Promise<ScanOutcome>;
  recordFailure(input: {
    scanRunId: string;
    sourceId: string;
    category: string;
    summary: string;
    httpStatus: number | null;
  }): Promise<void>;
}
type BeginSchemaType = z.infer<typeof BeginSchema>;

function throwOnError(error: { message: string } | null) {
  if (error) throw new Error(`Supabase monitoring operation failed: ${error.message}`);
}

export class SupabaseMonitoringRepository implements MonitoringRepository {
  private readonly client = createSupabaseServerClient();

  async getSource(sourceId: string) {
    const { data, error } = await this.client
      .from("source_catalog")
      .select("id,url,enabled,etag,last_modified")
      .eq("id", sourceId)
      .maybeSingle();
    throwOnError(error);
    if (!data) throw new Error("Monitoring source was not found.");
    return SourceSchema.parse(data);
  }

  async beginScan(sourceId: string, triggerRunId: string, attemptNumber: number) {
    const { data, error } = await this.client.rpc("begin_source_scan", {
      p_source_id: sourceId,
      p_trigger_run_id: triggerRunId,
      p_attempt_number: attemptNumber,
    });
    throwOnError(error);
    return BeginSchema.parse(data);
  }

  async getLatestSnapshot(sourceId: string) {
    const { data, error } = await this.client
      .from("source_snapshots")
      .select("id,version,content_hash,normalized_content,normalized_bytes")
      .eq("source_id", sourceId)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    throwOnError(error);
    return data
      ? SnapshotSchema.parse({
          id: data.id,
          version: data.version,
          contentHash: data.content_hash,
          normalizedContent: data.normalized_content,
          normalizedBytes: data.normalized_bytes,
        })
      : null;
  }

  async getDueSourceIds(now = new Date(), limit = 100) {
    const { data, error } = await this.client.rpc("list_due_source_ids", {
      p_now: now.toISOString(),
      p_limit: limit,
    });
    throwOnError(error);
    return z
      .array(z.object({ source_id: z.string().uuid() }))
      .parse(data ?? [])
      .map((row) => row.source_id);
  }

  async recordResult(input: Record<string, unknown>) {
    const { data, error } = await this.client.rpc("record_source_scan_result", input);
    throwOnError(error);
    return ResultSchema.parse(data);
  }

  async recordFailure(input: {
    scanRunId: string;
    sourceId: string;
    category: string;
    summary: string;
    httpStatus: number | null;
  }) {
    const { error } = await this.client.rpc("record_source_scan_failure", {
      p_scan_run_id: input.scanRunId,
      p_source_id: input.sourceId,
      p_error_category: input.category,
      p_error_summary: input.summary,
      p_http_status: input.httpStatus,
    });
    throwOnError(error);
  }
}
