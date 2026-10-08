import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationNames = [
  "20261002232050_auterim_monitoring_foundation.sql",
  "20261003010000_semantic_change_classification.sql",
  "20261004010000_customer_impact_intelligence.sql",
  "20261004020000_url_dependency_discovery.sql",
  "20261004030000_onboarding_activation_backend.sql",
];
const migrations = await Promise.all(
  migrationNames.map((name) =>
    readFile(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url)), "utf8"),
  ),
);
const reliabilityMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261110000000_baseline_dispatch_recovery_openai_pricing_source.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

const ownerId = "00000000-0000-4000-8000-000000000101";

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key,email text,email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
  `);
  for (const migration of migrations) await db.exec(migration);
  return db;
}

async function activateOpenAiWorkspace(db: PGlite) {
  await db.query("insert into auth.users(id) values ($1)", [ownerId]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
  const started = await db.query<{ value: { workspaceId: string } }>(
    `select public.start_workspace_onboarding(
      $1,'QA workspace','QA company','https://qa.example/','qa.example','baseline-qa-onboarding',null
    ) as value`,
    [ownerId],
  );
  const workspaceId = started.rows[0]!.value.workspaceId;
  await db.query("select public.add_onboarding_dependency_manually($1,'openai')", [workspaceId]);
  await db.query("select public.complete_onboarding_step($1,'dependencies_review')", [workspaceId]);
  await db.query("select public.complete_onboarding_step($1,'context_setup')", [workspaceId]);
  await db.query("select public.complete_onboarding_step($1,'notifications_setup')", [workspaceId]);
  await db.query("select public.activate_workspace_protection($1)", [workspaceId]);
  return workspaceId;
}

describe("baseline dispatch migration", () => {
  it("preserves OpenAI source identity/history and changes only its canonical URL", async () => {
    const db = await database();
    const prior = await db.query<{ id: string; created_at: string }>(`
      select source.id,source.created_at::text from public.source_catalog source
      join public.dependency_catalog dependency on dependency.id=source.dependency_id
      where dependency.slug='openai' and source.name='OpenAI API pricing'
        and source.source_type='pricing' and source.url='https://openai.com/api/pricing/'
    `);
    expect(prior.rows).toHaveLength(1);
    const sourceId = prior.rows[0]!.id;
    const run = await db.query<{ id: string }>(
      `insert into public.scan_runs(source_id,trigger_run_id,attempt_number,status,finished_at)
       values ($1,'historical-openai-pricing-scan',1,'success',now()) returning id`,
      [sourceId],
    );
    const snapshot = await db.query<{ id: string }>(
      `insert into public.source_snapshots(source_id,scan_run_id,version,content_hash,
        normalized_content,normalized_bytes,content_bytes)
       values ($1,$2,1,repeat('a',64),'historical pricing snapshot',27,27) returning id`,
      [sourceId, run.rows[0]!.id],
    );
    await db.exec(reliabilityMigration);

    const current = await db.query<{ id: string; url: string; created_at: string }>(`
      select source.id,source.url,source.created_at::text from public.source_catalog source
      join public.dependency_catalog dependency on dependency.id=source.dependency_id
      where dependency.slug='openai' and source.name='OpenAI API pricing' and source.source_type='pricing'
    `);
    expect(current.rows).toEqual([
      {
        id: sourceId,
        url: "https://developers.openai.com/api/docs/pricing",
        created_at: prior.rows[0]!.created_at,
      },
    ]);
    expect(
      (await db.query("select id from public.source_snapshots where source_id=$1", [sourceId]))
        .rows,
    ).toEqual([{ id: snapshot.rows[0]!.id }]);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.source_changes where source_id=$1",
          [sourceId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    await db.close();
  });

  it("reconciles globally, distinguishes empty from error, reclaims leases, bounds attempts, and restricts access", async () => {
    const db = await database();
    await db.exec(reliabilityMigration);
    await db.query(`
      insert into public.source_catalog(dependency_id,name,source_type,url)
      select id,'Baseline QA OpenAI docs','documentation','https://developers.openai.com/api/docs'
      from public.dependency_catalog where slug='openai'
    `);
    await db.query(`
      insert into public.source_catalog(dependency_id,name,source_type,url)
      select id,'Baseline QA OpenAI changelog','changelog','https://developers.openai.com/api/docs/changelog'
      from public.dependency_catalog where slug='openai'
    `);
    const workspaceId = await activateOpenAiWorkspace(db);
    const sourceIds = await db.query<{ id: string }>(`
      select source.id from public.source_catalog source
      join public.dependency_catalog dependency on dependency.id=source.dependency_id
      where dependency.slug='openai' and source.enabled order by source.id
    `);
    expect(sourceIds.rows.length).toBeGreaterThan(1);
    const existingSnapshots = await db.query<{ count: number }>(
      `select count(*)::int as count from public.source_snapshots where source_id=$1`,
      [sourceIds.rows[0]!.id],
    );
    expect(existingSnapshots.rows[0]!.count).toBe(0);

    await db.exec("set role service_role");
    const claims = await db.query<{
      queue_id: string;
      source_id: string;
      dispatch_attempt: number;
      lease_recovery_count: number;
      recovered: boolean;
    }>("select * from public.claim_due_baseline_sources(100)");
    expect(claims.rows.length).toBeGreaterThan(1);
    expect(claims.rows[0]).toMatchObject({
      dispatch_attempt: 1,
      lease_recovery_count: 0,
      recovered: false,
    });
    expect(Object.keys(claims.rows[0]!)).not.toContain("workspace_id");

    const empty = await db.query("select * from public.claim_due_baseline_sources(100)");
    expect(empty.rows).toHaveLength(0);
    const dueWhileClaimed = await db.query<{ source_id: string }>(
      "select * from public.list_due_source_ids(now(),100)",
    );
    expect(dueWhileClaimed.rows.map((row) => row.source_id)).not.toContain(
      claims.rows[0]!.source_id,
    );

    const completed = claims.rows[0]!;
    const run = await db.query<{ id: string }>(
      `insert into public.scan_runs(source_id,trigger_run_id,attempt_number)
       values ($1,'baseline-reconciliation-success',1) returning id`,
      [completed.source_id],
    );
    await db.query(
      `insert into public.source_snapshots(source_id,scan_run_id,version,content_hash,
        normalized_content,normalized_bytes,content_bytes)
       values ($1,$2,1,repeat('b',64),'first baseline',14,14)`,
      [completed.source_id, run.rows[0]!.id],
    );
    await db.query(`update public.scan_runs set status='success',finished_at=now() where id=$1`, [
      run.rows[0]!.id,
    ]);
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.baseline_scan_queue where source_id=$1",
          [completed.source_id],
        )
      ).rows[0]!.status,
    ).toBe("complete");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.source_snapshots where source_id=$1",
          [completed.source_id],
        )
      ).rows[0]!.count,
    ).toBe(1);
    const dueAfterBaseline = await db.query<{ source_id: string }>(
      "select * from public.list_due_source_ids(now(),100)",
    );
    expect(dueAfterBaseline.rows.map((row) => row.source_id)).toContain(completed.source_id);

    const retry = claims.rows[1]!;
    await db.query("select public.release_due_baseline_source_claim($1,$2)", [
      retry.queue_id,
      retry.dispatch_attempt,
    ]);
    const deferred = await db.query<{ status: string; retry_after: string | null }>(
      "select status,retry_after::text from public.baseline_scan_queue where source_id=$1",
      [retry.source_id],
    );
    expect(deferred.rows[0]!.status).toBe("queued");
    expect(deferred.rows[0]!.retry_after).not.toBeNull();
    await db.query(
      "update public.baseline_scan_queue set retry_after=now()-interval '1 second' where source_id=$1",
      [retry.source_id],
    );
    const retried = await db.query<{
      queue_id: string;
      dispatch_attempt: number;
      recovered: boolean;
    }>("select * from public.claim_due_baseline_sources(100) where source_id=$1", [
      retry.source_id,
    ]);
    expect(retried.rows).toHaveLength(1);
    expect(retried.rows[0]).toMatchObject({
      source_id: retry.source_id,
      dispatch_attempt: 2,
      lease_recovery_count: 0,
      recovered: false,
    });
    expect(retried.rows[0]!.queue_id).not.toBe(retry.queue_id);
    await db.query(
      "update public.baseline_scan_queue set dispatch_lease_until=now()-interval '1 second' where source_id=$1",
      [retry.source_id],
    );
    const recovered = await db.query<{
      queue_id: string;
      dispatch_attempt: number;
      lease_recovery_count: number;
      recovered: boolean;
    }>("select * from public.claim_due_baseline_sources(100) where source_id=$1", [
      retry.source_id,
    ]);
    expect(recovered.rows).toEqual([
      {
        queue_id: retried.rows[0]!.queue_id,
        source_id: retry.source_id,
        dispatch_attempt: 2,
        lease_recovery_count: 1,
        recovered: true,
      },
    ]);
    await db.query(
      `update public.baseline_scan_queue set dispatch_lease_until=now()-interval '1 second',
        lease_recovery_count=3 where source_id=$1`,
      [retry.source_id],
    );
    const exhausted = await db.query(
      "select * from public.claim_due_baseline_sources(100) where source_id=$1",
      [retry.source_id],
    );
    expect(exhausted.rows).toHaveLength(0);
    expect(
      (
        await db.query<{ status: string; error_category: string; retry_after: string | null }>(
          "select status,error_category,retry_after::text from public.baseline_scan_queue where source_id=$1",
          [retry.source_id],
        )
      ).rows[0],
    ).toMatchObject({ status: "failed", error_category: "lease_recovery_exhausted" });

    const boundedSourceId = claims.rows[2]!.source_id;
    await db.query(
      `update public.baseline_scan_queue set status='failed',dispatch_attempt=5,
        retry_after=now()-interval '1 second',dispatch_lease_until=null where source_id=$1`,
      [boundedSourceId],
    );
    expect(
      (
        await db.query("select * from public.claim_due_baseline_sources(100) where source_id=$1", [
          boundedSourceId,
        ])
      ).rows,
    ).toHaveLength(0);

    await db.exec("reset role; set role authenticated");
    await expect(db.query("select * from public.claim_due_baseline_sources(1)")).rejects.toThrow();
    await expect(db.query("select * from public.baseline_scan_queue")).rejects.toThrow();
    await db.exec("reset role");
    expect(workspaceId).toMatch(/^[0-9a-f-]{36}$/);
    await db.close();
  });
});
