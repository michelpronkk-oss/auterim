import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

const enabled = process.env.AUTERIM_M1575A_LOCAL === "1";

describe.skipIf(!enabled)("M15.75A local Supabase intelligence integration", () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
  const service =
    enabled && url && serviceKey
      ? createClient(url, serviceKey, {
          auth: { autoRefreshToken: false, persistSession: false },
        })
      : null;

  function getService() {
    if (!service) throw new Error("m1575a_local_supabase_guard_required");
    return service;
  }

  async function createQueuedChange(label: string) {
    const fixtureRunId = randomUUID();
    const dependencyResult = await getService()
      .from("dependency_catalog")
      .insert({
        slug: `m1575a-${label}-${randomUUID().slice(0, 8)}`,
        name: `M15.75A fixture ${label}`,
        category: "developer-tools",
        website_url: "https://fixture.example",
      })
      .select("id")
      .single();
    expect(dependencyResult.error).toBeNull();
    const dependencyId = dependencyResult.data!.id as string;
    const sourceResult = await getService()
      .from("source_catalog")
      .insert({
        dependency_id: dependencyId,
        name: `Fixture ${label}`,
        source_type: "deprecation",
        url: "https://fixture.example/deprecations",
        default_interval_seconds: 86400,
      })
      .select("id")
      .single();
    expect(sourceResult.error).toBeNull();
    const sourceId = sourceResult.data!.id as string;
    const content = [`Provider behavior ${label} old`, `Provider behavior ${label} retires`];
    const snapshotIds = [randomUUID(), randomUUID()];
    const runIds = [randomUUID(), randomUUID()];
    for (let index = 0; index < 2; index++) {
      const text = content[index]!;
      const run = await getService()
        .from("scan_runs")
        .insert({
          id: runIds[index],
          source_id: sourceId,
          trigger_run_id: `m1575a-fixture-${fixtureRunId}-${index}`,
          attempt_number: 1,
          status: "success",
          finished_at: new Date().toISOString(),
        });
      expect(run.error).toBeNull();
      const snapshot = await getService()
        .from("source_snapshots")
        .insert({
          id: snapshotIds[index],
          source_id: sourceId,
          scan_run_id: runIds[index],
          previous_snapshot_id: index === 0 ? null : snapshotIds[0],
          version: index + 1,
          content_hash: createHash("sha256").update(text).digest("hex"),
          normalized_content: text,
          normalized_bytes: Buffer.byteLength(text),
          content_bytes: Buffer.byteLength(text),
        });
      expect(snapshot.error).toBeNull();
    }
    const diff = `-Provider behavior ${label} old\n+Provider behavior ${label} retires`;
    const changeResult = await getService()
      .from("source_changes")
      .insert({
        source_id: sourceId,
        scan_run_id: runIds[1],
        previous_snapshot_id: snapshotIds[0],
        new_snapshot_id: snapshotIds[1],
        diff_text: diff,
        added_lines: 1,
        removed_lines: 1,
        diff_truncated: false,
        previous_bytes: Buffer.byteLength(content[0]!),
        new_bytes: Buffer.byteLength(content[1]!),
      })
      .select("id")
      .single();
    expect(changeResult.error).toBeNull();
    return changeResult.data!.id as string;
  }

  function completedArgs(sourceChangeId: string, runId: string, attemptNumber: number) {
    return {
      p_source_change_id: sourceChangeId,
      p_evidence_fingerprint: undefined as unknown as string,
      p_trigger_run_id: runId,
      p_attempt_number: attemptNumber,
      p_route: "deprecation",
      p_probabilities: {
        material: 0.99,
        criticalChange: 0.94,
        evidenceSufficient: 0.98,
        docsNoise: 0.01,
        requiresEscalation: 0.9,
        route: { deprecation: 0.99 },
      },
      p_confidence: 0.99,
      p_evidence_quality: {
        diffTruncated: false,
        sourceCriticality: "critical",
        semanticEvidenceCoverage: 1,
        incomplete: false,
      },
      p_proposed_policy_state: "escalate",
      p_latency_ms: 25,
      p_input_tokens: 240,
      p_output_tokens: 30,
      p_cost_usd: 0.00001,
    };
  }

  it("persists deterministic source changes into an isolated idempotent shadow queue", async () => {
    expect(url).toBe("http://127.0.0.1:57431");
    expect(serviceKey.length).toBeGreaterThan(20);
    const sourceChangeId = await createQueuedChange("replay");
    const queue = await getService()
      .from("change_intelligence_decisions")
      .select("id,status,evidence_fingerprint")
      .eq("source_change_id", sourceChangeId)
      .single();
    expect(queue.error).toBeNull();
    expect(queue.data?.status).toBe("queued");
    const begin = await getService().rpc("begin_source_change_intelligence", {
      p_source_change_id: sourceChangeId,
      p_trigger_run_id: "m1575a-run-one",
      p_attempt_number: 1,
    });
    expect(begin.error).toBeNull();
    expect(begin.data.status).toBe("processing");
    const duplicate = await getService().rpc("begin_source_change_intelligence", {
      p_source_change_id: sourceChangeId,
      p_trigger_run_id: "m1575a-run-two",
      p_attempt_number: 1,
    });
    expect(duplicate.error).toBeNull();
    expect(duplicate.data.status).toBe("busy");
    const args = completedArgs(sourceChangeId, "m1575a-run-one", 1);
    args.p_evidence_fingerprint = begin.data.evidenceFingerprint;
    const record = await getService().rpc("record_source_change_intelligence", args);
    expect(record.error).toBeNull();
    const replay = await getService().rpc("begin_source_change_intelligence", {
      p_source_change_id: sourceChangeId,
      p_trigger_run_id: "m1575a-run-three",
      p_attempt_number: 1,
    });
    expect(replay.error).toBeNull();
    expect(replay.data).toMatchObject({ status: "completed", replayed: true });
  });

  it("reclaims persisted provider failures without duplicating the decision identity", async () => {
    const sourceChangeId = await createQueuedChange("retry");
    const first = await getService().rpc("begin_source_change_intelligence", {
      p_source_change_id: sourceChangeId,
      p_trigger_run_id: "m1575a-retry-one",
      p_attempt_number: 1,
    });
    expect(first.error).toBeNull();
    const failed = await getService().rpc("record_source_change_intelligence_failure", {
      p_source_change_id: sourceChangeId,
      p_evidence_fingerprint: first.data.evidenceFingerprint,
      p_trigger_run_id: "m1575a-retry-one",
      p_attempt_number: 1,
      p_error_category: "provider_http_503",
    });
    expect(failed.error).toBeNull();
    const retry = await getService().rpc("begin_source_change_intelligence", {
      p_source_change_id: sourceChangeId,
      p_trigger_run_id: "m1575a-retry-two",
      p_attempt_number: 2,
    });
    expect(retry.error).toBeNull();
    expect(retry.data.status).toBe("processing");
    expect(retry.data.evidenceFingerprint).toBe(first.data.evidenceFingerprint);
    const args = completedArgs(sourceChangeId, "m1575a-retry-two", 2);
    args.p_evidence_fingerprint = retry.data.evidenceFingerprint;
    const recorded = await getService().rpc("record_source_change_intelligence", args);
    expect(recorded.error).toBeNull();
    const rows = await getService()
      .from("change_intelligence_decisions")
      .select("id")
      .eq("source_change_id", sourceChangeId);
    expect(rows.data).toHaveLength(1);
  });

  it("keeps decision storage inaccessible to browser roles", async () => {
    const client = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const result = await client.from("change_intelligence_decisions").select("id").limit(1);
    expect(result.error).not.toBeNull();
  });
});
