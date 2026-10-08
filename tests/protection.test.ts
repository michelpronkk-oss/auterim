import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { classifyEmailFailure } from "@/lib/notifications/email";
import {
  latestDependencyScan,
  latestObservationOutcome,
  latestPreflightRuns,
  latestTerminalPreflightRuns,
  latestVerifiedPreflightRuns,
  monitoringEvidenceState,
} from "@/lib/protection/read-model-helpers";

const versions = [
  "20261002232050_auterim_monitoring_foundation.sql",
  "20261003010000_semantic_change_classification.sql",
  "20261004010000_customer_impact_intelligence.sql",
  "20261004020000_url_dependency_discovery.sql",
  "20261004030000_onboarding_activation_backend.sql",
  "20261005000000_preflight_breakage_prevention.sql",
  "20261005010000_preflight_claim_privilege_hardening.sql",
  "20261006000000_auth_accounts_billing_entitlements.sql",
  "20261007000000_protection_value_notifications.sql",
  "20261007100000_protection_deadline_read_model.sql",
  "20261008000000_growth_engine_core.sql",
  "20261008010000_growth_engine_query_bounds.sql",
];
const migrations = await Promise.all(
  versions.map((version) =>
    readFile(fileURLToPath(new URL(`../supabase/migrations/${version}`, import.meta.url)), "utf8"),
  ),
);

const ownerId = "00000000-0000-4000-8000-000000000001";
const outsiderId = "00000000-0000-4000-8000-000000000002";

async function setup() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
    $$;
    grant usage on schema auth to anon,authenticated;
    grant execute on function auth.uid() to anon,authenticated;
  `);
  for (const migration of migrations) await db.exec(migration);
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values ($1,'owner@example.test',now()),($2,'outsider@example.test',now())",
    [ownerId, outsiderId],
  );
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
  const started = await db.query<{ value: { workspaceId: string } }>(
    `select public.start_workspace_onboarding($1,'Example workspace','Example Inc','https://example.com/','example.com','protection-test',null) as value`,
    [ownerId],
  );
  return { db, workspaceId: started.rows[0]!.value.workspaceId };
}

describe("protection read models and notifications", () => {
  it("keeps the newest terminal Preflight result through retries and replaces it on a newer terminal result", () => {
    const latest = latestTerminalPreflightRuns([
      {
        id: "00000000-0000-4000-8000-000000000001",
        impact_assessment_id: "impact-1",
        status: "completed",
        verified_impact: "verified",
        created_at: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        impact_assessment_id: "impact-1",
        status: "running",
        verified_impact: null,
        created_at: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        impact_assessment_id: "impact-2",
        status: "partial",
        verified_impact: "verified",
        created_at: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        impact_assessment_id: "impact-1",
        status: "completed",
        verified_impact: "not_found",
        created_at: "2026-10-03T00:00:00.000Z",
      },
    ]);
    expect(latest.get("impact-1")?.verified_impact).toBe("not_found");
    expect(latest.get("impact-2")?.verified_impact).toBe("verified");
  });

  it("does not let an older terminal Preflight stand in for a newer queued run", () => {
    const runs = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        impact_assessment_id: "impact-1",
        status: "completed",
        verified_impact: "verified",
        created_at: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        impact_assessment_id: "impact-1",
        status: "queued",
        verified_impact: null,
        created_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    const latest = latestPreflightRuns(runs);
    const verified = latestVerifiedPreflightRuns(runs);
    expect(latest.get("impact-1")).toMatchObject({ status: "queued", verified_impact: null });
    expect(verified.get("impact-1")).toMatchObject({
      status: "completed",
      verified_impact: "verified",
    });
  });

  it("retains old verified evidence when a newer terminal attempt is not verified", () => {
    const runs = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        impact_assessment_id: "impact-1",
        status: "completed",
        verified_impact: "verified",
        created_at: "2026-10-01T00:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        impact_assessment_id: "impact-1",
        status: "completed",
        verified_impact: "not_found",
        created_at: "2026-10-02T00:00:00.000Z",
      },
    ];
    expect(latestPreflightRuns(runs).get("impact-1")?.verified_impact).toBe("not_found");
    expect(latestVerifiedPreflightRuns(runs).get("impact-1")?.id).toBe(
      "00000000-0000-4000-8000-000000000001",
    );
  });

  it("keeps monitoring coverage separate from observed global baselines and scan health", () => {
    expect(
      monitoringEvidenceState({
        monitoringEnabled: true,
        enabledSourceCount: 4,
        sourcesWithBaseline: 0,
        latestScanStatus: null,
      }),
    ).toBe("baseline_incomplete");
    expect(
      monitoringEvidenceState({
        monitoringEnabled: true,
        enabledSourceCount: 0,
        sourcesWithBaseline: 0,
        latestScanStatus: null,
      }),
    ).toBe("coverage_missing");
    expect(
      monitoringEvidenceState({
        monitoringEnabled: true,
        enabledSourceCount: 2,
        sourcesWithBaseline: 2,
        latestScanStatus: "failed",
      }),
    ).toBe("scan_failed");
  });

  it("does not call mixed successful and never-scanned sources a complete success", () => {
    expect(latestObservationOutcome(2, [{ scan_status: "success" }, { scan_status: null }])).toBe(
      "partial_observation",
    );
    expect(latestObservationOutcome(2, [{ scan_status: null }, { scan_status: null }])).toBe(
      "not_observed",
    );
    expect(latestObservationOutcome(2, [{ scan_status: "success" }])).toBe("partial_observation");
  });

  it("selects dependency scan freshness deterministically across sources", () => {
    const latest = latestDependencyScan(
      [
        { source_id: "source-a", finished_at: "2026-10-01T12:00:00.000Z", status: "failed" },
        { source_id: "source-b", finished_at: "2026-10-01T12:00:00.000Z", status: "success" },
        { source_id: "source-c", finished_at: "2026-10-01T11:00:00.000Z", status: "changed" },
      ],
      new Set(["source-a", "source-b", "source-c"]),
    );
    expect(latest?.source_id).toBe("source-b");
  });

  it("returns evidence-backed zero metrics, rejects outsiders, and validates bounded UTC windows", async () => {
    const { db, workspaceId } = await setup();
    await db.exec("set role authenticated");
    const result = await db.query<{ value: Record<string, unknown> }>(
      "select public.get_protection_summary($1,now()-interval '7 days',now()) as value",
      [workspaceId],
    );
    expect(result.rows[0]!.value).toMatchObject({
      checksCompleted: 0,
      changesDetected: 0,
      materialChanges: 0,
      customerRelevantChanges: 0,
      verifiedRisks: 0,
      unresolvedRisks: 0,
    });
    await expect(
      db.query(
        `insert into public.notifications(workspace_id,notification_type,priority,title,summary,dedupe_key)
       values ($1,'customer_relevant_change','normal','Forged','Client content','forged')`,
        [workspaceId],
      ),
    ).rejects.toThrow();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsiderId]);
    await expect(
      db.query("select public.get_protection_summary($1,now()-interval '7 days',now())", [
        workspaceId,
      ]),
    ).rejects.toThrow();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
    await expect(
      db.query("select public.get_protection_summary($1,now()-interval '400 days',now())", [
        workspaceId,
      ]),
    ).rejects.toThrow();
    await db.close();
  });

  it("deduplicates inbox and email intents, scopes read state, and claims a bounded delivery once", async () => {
    const { db, workspaceId } = await setup();
    await db.query(
      "update public.workspace_notification_preferences set email_enabled=true,important_changes='instant' where workspace_id=$1",
      [workspaceId],
    );
    await db.exec("set role service_role");
    const args = [workspaceId, "relevant-change:fixed-event"];
    const inserted = await db.query<{ id: string }>(
      `insert into public.notifications(workspace_id,notification_type,priority,title,summary,dedupe_key)
       values ($1,'customer_relevant_change','high','Provider update','A material change affects your dependency.', $2)
       on conflict(workspace_id,dedupe_key) do nothing returning id`,
      args,
    );
    const firstId = inserted.rows[0]!.id;
    await db.query(
      `insert into public.notifications(workspace_id,notification_type,priority,title,summary,dedupe_key)
       values ($1,'customer_relevant_change','high','Provider update','A material change affects your dependency.', $2)
       on conflict(workspace_id,dedupe_key) do nothing`,
      args,
    );
    const totals = await db.query<{ inbox: number; deliveries: number }>(
      `select (select count(*)::int from public.notifications where workspace_id=$1) inbox,
        (select count(*)::int from public.notification_deliveries where workspace_id=$1) deliveries`,
      [workspaceId],
    );
    expect(totals.rows[0]).toEqual({ inbox: 1, deliveries: 1 });
    const claimed = await db.query<{ delivery_id: string; recipient_email: string }>(
      "select * from public.claim_notification_deliveries(500)",
    );
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0]!.recipient_email).toBe("owner@example.test");
    expect(await db.query("select * from public.claim_notification_deliveries(50)")).toMatchObject({
      rows: [],
    });
    const retry = await db.query<{ status: string }>(
      "select public.fail_notification_delivery($1,$2,'provider_rate_limited',true) as status",
      [
        claimed.rows[0]!.delivery_id,
        (
          await db.query<{ lease_until: string }>(
            "select lease_until from public.notification_deliveries where id=$1",
            [claimed.rows[0]!.delivery_id],
          )
        ).rows[0]!.lease_until,
      ],
    );
    expect(retry.rows[0]!.status).toBe("pending");
    await db.query("update public.notification_deliveries set next_attempt_at=now() where id=$1", [
      claimed.rows[0]!.delivery_id,
    ]);
    const secondClaim = await db.query<{ delivery_id: string; lease_until: string }>(
      "select * from public.claim_notification_deliveries(1)",
    );
    expect(secondClaim.rows).toHaveLength(1);
    const failed = await db.query<{ status: string }>(
      "select public.fail_notification_delivery($1,$2,'provider_rejected',false) as status",
      [secondClaim.rows[0]!.delivery_id, secondClaim.rows[0]!.lease_until],
    );
    expect(failed.rows[0]!.status).toBe("failed");
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsiderId]);
    await expect(
      db.query("select public.mark_notification_read($1,$2)", [workspaceId, firstId]),
    ).rejects.toThrow();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
    await db.query("select public.mark_notification_read($1,$2)", [workspaceId, firstId]);
    const read = await db.query<{ read_at: string | null }>(
      "select read_at from public.notifications where id=$1",
      [firstId],
    );
    expect(read.rows[0]!.read_at).not.toBeNull();
    await db.close();
  });

  it("classifies bounded provider retries without retaining provider details", () => {
    expect(classifyEmailFailure(Object.assign(new Error("redacted"), { statusCode: 429 }))).toEqual(
      {
        category: "provider_rate_limited",
        transient: true,
      },
    );
    expect(classifyEmailFailure(Object.assign(new Error("redacted"), { statusCode: 503 }))).toEqual(
      {
        category: "provider_unavailable",
        transient: true,
      },
    );
    expect(classifyEmailFailure(Object.assign(new Error("redacted"), { statusCode: 422 }))).toEqual(
      {
        category: "provider_rejected",
        transient: false,
      },
    );
  });

  it("authorizes and bounds the deadline read model", async () => {
    const { db, workspaceId } = await setup();
    await db.exec("set role authenticated");
    const empty = await db.query("select * from public.get_upcoming_protection_deadlines($1,25)", [
      workspaceId,
    ]);
    expect(empty.rows).toEqual([]);
    await expect(
      db.query("select * from public.get_upcoming_protection_deadlines($1,26)", [workspaceId]),
    ).rejects.toThrow();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsiderId]);
    await expect(
      db.query("select * from public.get_upcoming_protection_deadlines($1,25)", [workspaceId]),
    ).rejects.toThrow();
    await db.close();
  });
});
