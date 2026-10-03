import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationPaths = [
  "20261002232050_auterim_monitoring_foundation.sql",
  "20261003010000_semantic_change_classification.sql",
  "20261004010000_customer_impact_intelligence.sql",
  "20261004020000_url_dependency_discovery.sql",
  "20261004030000_onboarding_activation_backend.sql",
  "20261005000000_preflight_breakage_prevention.sql",
  "20261005010000_preflight_claim_privilege_hardening.sql",
  "20261006000000_auth_accounts_billing_entitlements.sql",
  "20261007000000_protection_value_notifications.sql",
];
const migrations = await Promise.all(
  migrationPaths.map((name) =>
    readFile(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url)), "utf8"),
  ),
);

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

const ownerId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
type OnboardingStatus = {
  currentStep: string;
  notificationPreferences: { importantChanges: string };
  confirmedDependencies: Array<{ criticality: string }>;
  coveragePreview: { authoritativeSourcesAvailable: number };
};
type ActivationResult = {
  activatedAt: string;
  protection: { dependencies: number; baselineStatus: string };
};

async function asUser(db: PGlite, id: string) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}

async function start(db: PGlite, key = "onboarding-request-0001") {
  const result = await db.query<{ value: Record<string, unknown> }>(
    `select public.start_workspace_onboarding(
      $1,'Example workspace','Example Inc','https://example.com/','example.com',$2,null
    ) as value`,
    [ownerId, key],
  );
  return result.rows[0]!.value;
}

async function addClassifiedChange(
  db: PGlite,
  sourceId: string,
  previousSnapshotId: string,
  version: number,
  hex: string,
  createdAt: string,
) {
  const content = `post-activation-${version}`;
  const scan = await db.query<{ id: string }>(
    `insert into public.scan_runs(source_id,trigger_run_id,attempt_number,status,finished_at)
     values ($1,$2,1,'success',now()) returning id`,
    [sourceId, `impact-cutoff-scan-${version}`],
  );
  const snapshot = await db.query<{ id: string }>(
    `insert into public.source_snapshots(source_id,scan_run_id,previous_snapshot_id,version,content_hash,normalized_content,normalized_bytes,content_bytes)
     values ($1,$2,$3,$4,repeat($5,64),$6,octet_length($6),octet_length($6)) returning id`,
    [sourceId, scan.rows[0]!.id, previousSnapshotId, version, hex, content],
  );
  const change = await db.query<{ id: string }>(
    `insert into public.source_changes(source_id,scan_run_id,previous_snapshot_id,new_snapshot_id,
       diff_text,added_lines,removed_lines,previous_bytes,new_bytes,created_at)
     select $1,$2,$3,$4,'+material update',1,0,octet_length(old.normalized_content),
       octet_length(new.normalized_content),$5 from public.source_snapshots old,public.source_snapshots new
     where old.id=$3 and new.id=$4 returning id`,
    [sourceId, scan.rows[0]!.id, previousSnapshotId, snapshot.rows[0]!.id, createdAt],
  );
  await db.query(
    `update public.source_change_classifications set status='classified',material=true,category='api_change',
       affected_entities='[]'::jsonb,severity_hint='high',confidence=0.95,summary='Material API update',
       evidence='[]'::jsonb,reasoning_summary='Grounded in source diff',decision_status='classified',
       classified_at=now(),created_at=now() where change_id=$1`,
    [change.rows[0]!.id],
  );
  return { changeId: change.rows[0]!.id, snapshotId: snapshot.rows[0]!.id };
}

describe("onboarding activation backend", () => {
  it("resumes safely, preserves discovery provenance, enforces membership, and activates once", async () => {
    const db = await database();
    await db.query("insert into auth.users(id) values ($1),($2)", [ownerId, otherId]);
    await asUser(db, ownerId);

    const started = await start(db);
    const workspaceId = String(started.workspaceId);
    const companyId = String(started.companyId);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_subscriptions where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    const replay = await start(db);
    expect(replay.workspaceId).toBe(workspaceId);
    expect(replay.companyId).toBe(companyId);
    expect(replay.replayed).toBe(true);

    await db.exec("set role authenticated");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_onboarding where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    await expect(
      db.query("update public.workspace_onboarding set state='active' where workspace_id=$1", [
        workspaceId,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query("select public.claim_onboarding_discovery_dispatch($1,$2,$3)", [
        ownerId,
        workspaceId,
        companyId,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query(
        "select public.start_workspace_onboarding($1,'x','x','https://x.com/','x.com','member-start-key',null)",
        [ownerId],
      ),
    ).rejects.toThrow();
    await db.exec("reset role");

    const candidateResult = await db.query<{ id: string; dependency_id: string }>(`
      insert into public.discovered_dependencies(workspace_id,company_id,dependency_id,confidence,confidence_label,evidence_summary)
      select '${workspaceId}'::uuid,'${companyId}'::uuid,id,0.91,'high','[{"summary":"Vercel marker"}]'::jsonb
      from public.dependency_catalog where slug='vercel' returning id,dependency_id
    `);
    const candidateId = candidateResult.rows[0]!.id;
    const candidateDependencyId = candidateResult.rows[0]!.dependency_id;

    await asUser(db, otherId);
    await expect(
      db.query("select public.decide_onboarding_dependency_candidate($1,$2,'confirmed')", [
        workspaceId,
        candidateId,
      ]),
    ).rejects.toThrow();
    await expect(
      db.query("select public.activate_workspace_protection($1)", [workspaceId]),
    ).rejects.toThrow();
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_subscriptions where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(0);

    await asUser(db, ownerId);
    const confirmed = await db.query<{ value: Record<string, unknown> }>(
      "select public.decide_onboarding_dependency_candidate($1,$2,'confirmed') as value",
      [workspaceId, candidateId],
    );
    const confirmedAgain = await db.query<{ value: Record<string, unknown> }>(
      "select public.decide_onboarding_dependency_candidate($1,$2,'confirmed') as value",
      [workspaceId, candidateId],
    );
    expect(confirmed.rows[0]!.value.workspaceDependencyId).toBe(
      confirmedAgain.rows[0]!.value.workspaceDependencyId,
    );
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_dependencies where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(
      (
        await db.query<{ origin: string }>(
          "select origin from public.workspace_dependencies where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.origin,
    ).toBe("discovered");
    await db.query("select public.add_onboarding_dependency_manually($1,'vercel')", [workspaceId]);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_dependencies where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    await db.query(
      "select public.upsert_discovered_dependency_candidate($1,$2,$3,0.94,'high','[{\"summary\":\"refreshed public evidence\"}]'::jsonb)",
      [workspaceId, companyId, candidateDependencyId],
    );
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.discovered_dependencies where id=$1",
          [candidateId],
        )
      ).rows[0]!.status,
    ).toBe("confirmed");
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.discovered_dependencies where id=$1",
          [candidateId],
        )
      ).rows[0]!.status,
    ).toBe("confirmed");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_dependency_discovery_links where discovered_dependency_id=$1",
          [candidateId],
        )
      ).rows[0]!.count,
    ).toBe(1);

    const workspaceDependencyId = String(confirmed.rows[0]!.value.workspaceDependencyId);
    await db.query(
      "select public.set_onboarding_dependency_context($1,$2,'critical',true,'[\"AI processing\"]'::jsonb,'Production inference','{}'::jsonb)",
      [workspaceId, workspaceDependencyId],
    );
    await db.query("select public.set_onboarding_dependency_context($1,$2)", [
      workspaceId,
      workspaceDependencyId,
    ]);
    expect(
      (
        await db.query(
          "select criticality,production_critical,used_for from public.dependency_context where workspace_dependency_id=$1",
          [workspaceDependencyId],
        )
      ).rows[0],
    ).toMatchObject({
      criticality: "critical",
      production_critical: true,
      used_for: ["AI processing"],
    });

    await db.query("select public.complete_onboarding_step($1,'dependencies_review')", [
      workspaceId,
    ]);
    await db.query("select public.complete_onboarding_step($1,'context_setup')", [workspaceId]);
    await db.query(
      "select public.save_onboarding_notification_preferences($1,'instant','digest',true)",
      [workspaceId],
    );
    await db.query("select public.complete_onboarding_step($1,'notifications_setup')", [
      workspaceId,
    ]);
    const status = await db.query<{ value: OnboardingStatus }>(
      "select public.get_onboarding_status($1) as value",
      [workspaceId],
    );
    expect(status.rows[0]!.value.currentStep).toBe("notifications_setup");
    expect(status.rows[0]!.value.notificationPreferences.importantChanges).toBe("instant");
    expect(status.rows[0]!.value.confirmedDependencies[0].criticality).toBe("critical");

    const resumed = await db.query<{ value: Record<string, unknown> }>(
      `select public.start_workspace_onboarding(
        $1,'Example workspace','Changed Inc','https://example.com/','example.com','onboarding-request-0004',$2
      ) as value`,
      [ownerId, workspaceId],
    );
    expect(resumed.rows[0]!.value.state).toBe("notifications_setup");
    expect(
      (
        await db.query<{ name: string }>("select name from public.companies where id=$1", [
          companyId,
        ])
      ).rows[0]!.name,
    ).toBe("Example Inc");

    const expectedSourceCount = await db.query<{ count: number }>(`
      select count(distinct source.id)::int as count from public.workspace_dependencies wd
      join public.source_catalog source on source.dependency_id=wd.dependency_id and source.enabled
      where wd.workspace_id='${workspaceId}'::uuid
    `);
    expect(status.rows[0]!.value.coveragePreview.authoritativeSourcesAvailable).toBe(
      expectedSourceCount.rows[0]!.count,
    );
    const active = await db.query<{ value: ActivationResult }>(
      "select public.activate_workspace_protection($1) as value",
      [workspaceId],
    );
    const activeAgain = await db.query<{ value: ActivationResult }>(
      "select public.activate_workspace_protection($1) as value",
      [workspaceId],
    );
    expect(activeAgain.rows[0]!.value.activatedAt).toBe(active.rows[0]!.value.activatedAt);
    const trial = await db.query<{
      plan: string;
      status: string;
      trial_started_at: string;
      trial_ends_at: string;
    }>(
      "select plan,status,trial_started_at,trial_ends_at from public.workspace_subscriptions where workspace_id=$1",
      [workspaceId],
    );
    expect(trial.rows).toHaveLength(1);
    expect(trial.rows[0]!.plan).toBe("pro");
    expect(trial.rows[0]!.status).toBe("trialing");
    expect(
      Date.parse(trial.rows[0]!.trial_ends_at) - Date.parse(trial.rows[0]!.trial_started_at),
    ).toBe(5 * 24 * 60 * 60 * 1000);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_initial_assessments where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    await db.query("select public.attach_workspace_dodo_customer($1,'cus_auterim_test')", [
      workspaceId,
    ]);
    const providerEventAt = "2030-01-01T00:00:00Z";
    const providerPeriodStart = "2029-12-01T00:00:00Z";
    const providerPeriodEnd = "2030-02-01T00:00:00Z";
    const appliedWebhook = await db.query<{ value: string }>(
      "select public.process_dodo_subscription_event('evt_m8_001','subscription.active','cus_auterim_test','sub_auterim_test','prod_auterim_pro','pro','active',$1,$2,false,$3) as value",
      [providerPeriodStart, providerPeriodEnd, providerEventAt],
    );
    expect(appliedWebhook.rows[0]!.value).toBe("processed");
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select private.workspace_can_run_preflight($1) as allowed",
          [workspaceId],
        )
      ).rows[0]!.allowed,
    ).toBe(true);
    await db.query(
      "update public.workspace_subscriptions set status='past_due' where workspace_id=$1",
      [workspaceId],
    );
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "select private.workspace_can_run_preflight($1) as allowed",
          [workspaceId],
        )
      ).rows[0]!.allowed,
    ).toBe(false);
    await db.query(
      "update public.workspace_subscriptions set status='active' where workspace_id=$1",
      [workspaceId],
    );
    const duplicateWebhook = await db.query<{ value: string }>(
      "select public.process_dodo_subscription_event('evt_m8_001','subscription.active','cus_auterim_test','sub_auterim_test','prod_auterim_pro','pro','active',$1,$2,false,$3) as value",
      [providerPeriodStart, providerPeriodEnd, providerEventAt],
    );
    expect(duplicateWebhook.rows[0]!.value).toBe("duplicate");
    const staleWebhook = await db.query<{ value: string }>(
      "select public.process_dodo_subscription_event('evt_m8_000','subscription.cancelled','cus_auterim_test','sub_auterim_test','prod_auterim_core','core','cancelled',$1,$2,false,'2029-12-31T23:59:59Z') as value",
      [providerPeriodStart, providerPeriodEnd],
    );
    expect(staleWebhook.rows[0]!.value).toBe("stale");
    const unknownProduct = await db.query<{ value: string }>(
      "select public.process_dodo_subscription_event('evt_m8_002','subscription.active','cus_auterim_test','sub_other','prod_unknown',null,'active',$1,$2,false,'2030-01-02T00:00:00Z') as value",
      [providerPeriodStart, providerPeriodEnd],
    );
    expect(unknownProduct.rows[0]!.value).toBe("ignored");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_subscriptions where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(
      (
        await db.query<{ plan: string; status: string }>(
          "select plan,status from public.workspace_subscriptions where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0],
    ).toEqual({ plan: "pro", status: "active" });
    await asUser(db, otherId);
    await db.exec("set role authenticated");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_subscriptions where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    await expect(
      db.query("select public.attach_workspace_dodo_customer($1,'cus_forged')", [workspaceId]),
    ).rejects.toThrow();
    await expect(
      db.query("update public.workspace_subscriptions set plan='business' where workspace_id=$1", [
        workspaceId,
      ]),
    ).rejects.toThrow();
    await db.exec("reset role");
    const activeResume = await db.query<{ value: Record<string, unknown> }>(
      `select public.start_workspace_onboarding(
        $1,'Example workspace','Changed Inc','https://example.com/','example.com','onboarding-request-0005',$2
      ) as value`,
      [ownerId, workspaceId],
    );
    expect(activeResume.rows[0]!.value.state).toBe("active");
    expect(active.rows[0]!.value.protection.dependencies).toBe(1);
    expect(active.rows[0]!.value.protection.baselineStatus).toBe("partial");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.baseline_scan_queue q join public.source_catalog s on s.id=q.source_id where s.dependency_id=$1",
          [candidateDependencyId],
        )
      ).rows[0]!.count,
    ).toBe(expectedSourceCount.rows[0]!.count);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.baseline_scan_dispatch_claims",
        )
      ).rows[0]!.count,
    ).toBe(0);
    await db.close();
  });

  it("rejects empty activation, makes rejection retry-safe, and handles manual/unknown providers safely", async () => {
    const db = await database();
    await db.query("insert into auth.users(id) values ($1)", [ownerId]);
    await asUser(db, ownerId);
    const started = await start(db, "onboarding-request-0002");
    const workspaceId = String(started.workspaceId);
    const companyId = String(started.companyId);
    const candidate = await db.query<{ id: string }>(`
      insert into public.discovered_dependencies(workspace_id,company_id,dependency_id,confidence,confidence_label,evidence_summary)
      select '${workspaceId}'::uuid,'${companyId}'::uuid,id,0.72,'medium','[]'::jsonb
      from public.dependency_catalog where slug='stripe' returning id
    `);
    const candidateId = candidate.rows[0]!.id;
    await db.query("select public.decide_onboarding_dependency_candidate($1,$2,'rejected')", [
      workspaceId,
      candidateId,
    ]);
    await expect(
      db.query("select public.decide_onboarding_dependency_candidate($1,$2,'confirmed')", [
        workspaceId,
        candidateId,
      ]),
    ).rejects.toThrow();
    await db.query("select public.decide_onboarding_dependency_candidate($1,$2,'rejected')", [
      workspaceId,
      candidateId,
    ]);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_dependencies where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    await expect(
      db.query("select public.activate_workspace_protection($1)", [workspaceId]),
    ).rejects.toThrow();

    const discoveryRun = await db.query<{ id: string }>(`
      insert into public.dependency_discovery_runs(workspace_id,company_id,website_url,trigger_run_id,attempt_number)
      values ('${workspaceId}'::uuid,'${companyId}'::uuid,'https://example.com/','onboarding-slow-discovery',1)
      returning id
    `);
    await db.query(
      "update public.workspace_onboarding set state='discovery_running' where workspace_id=$1",
      [workspaceId],
    );

    await expect(
      db.query("select public.add_onboarding_dependency_manually($1,'not-in-catalog')", [
        workspaceId,
      ]),
    ).rejects.toThrow();
    await db.query("select public.add_onboarding_dependency_manually($1,'stripe')", [workspaceId]);
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.discovered_dependencies where id=$1",
          [candidateId],
        )
      ).rows[0]!.status,
    ).toBe("rejected");
    expect(
      (
        await db.query<{ state: string }>(
          "select state from public.workspace_onboarding where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.state,
    ).toBe("discovery_running");
    await db.query("select public.complete_onboarding_step($1,'dependencies_review')", [
      workspaceId,
    ]);
    await db.query(
      "update public.dependency_discovery_runs set status='completed',finished_at=now() where id=$1",
      [discoveryRun.rows[0]!.id],
    );
    expect(
      (
        await db.query<{ state: string }>(
          "select state from public.workspace_onboarding where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.state,
    ).toBe("context_setup");
    await db.query("select public.add_onboarding_dependency_manually($1,'openai')", [workspaceId]);
    await db.query("select public.add_onboarding_dependency_manually($1,'openai')", [workspaceId]);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_dependencies where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(2);
    expect(
      (
        await db.query<{ origin: string }>(
          "select wd.origin from public.workspace_dependencies wd join public.dependency_catalog dependency on dependency.id=wd.dependency_id where wd.workspace_id=$1 and dependency.slug='openai'",
          [workspaceId],
        )
      ).rows[0]!.origin,
    ).toBe("manual");

    const result = await db.query<{ value: Record<string, unknown> }>(
      "select public.get_onboarding_status($1) as value",
      [workspaceId],
    );
    expect(result.rows[0]!.value.currentStep).toBe("context_setup");
    await db.close();
  });

  it("reuses global snapshots and queues only never-scanned global sources", async () => {
    const db = await database();
    await db.query("insert into auth.users(id) values ($1)", [ownerId]);
    await asUser(db, ownerId);
    const started = await start(db, "onboarding-request-0003");
    const workspaceId = String(started.workspaceId);
    await db.query("select public.add_onboarding_dependency_manually($1,'openai')", [workspaceId]);
    await db.query(`
      insert into public.source_catalog(dependency_id,name,source_type,url)
      select id,'Test official API docs','documentation','https://platform.openai.com/docs'
      from public.dependency_catalog where slug='openai'
    `);
    const sourceRows = await db.query<{ id: string }>(`
      select source.id from public.source_catalog source
      join public.dependency_catalog dependency on dependency.id=source.dependency_id
      where dependency.slug='openai' and source.enabled order by source.id
    `);
    expect(sourceRows.rows.length).toBeGreaterThan(1);
    const existingSourceId = sourceRows.rows[0]!.id;
    const scan = await db.query<{ id: string }>(
      `insert into public.scan_runs(source_id,trigger_run_id,attempt_number,status,finished_at)
       values ($1,'existing-global-baseline',1,'success',now()) returning id`,
      [existingSourceId],
    );
    const existingSnapshot = await db.query<{ id: string }>(
      `insert into public.source_snapshots(source_id,scan_run_id,version,content_hash,normalized_content,normalized_bytes,content_bytes)
       values ($1,$2,1,repeat('a',64),'existing global snapshot',octet_length('existing global snapshot'),24) returning id`,
      [existingSourceId, scan.rows[0]!.id],
    );
    await db.query("select public.complete_onboarding_step($1,'dependencies_review')", [
      workspaceId,
    ]);
    await db.query("select public.complete_onboarding_step($1,'context_setup')", [workspaceId]);
    await db.query("select public.complete_onboarding_step($1,'notifications_setup')", [
      workspaceId,
    ]);
    const activation = await db.query<{ value: ActivationResult }>(
      "select public.activate_workspace_protection($1) as value",
      [workspaceId],
    );
    expect(activation.rows[0]!.value.protection.baselineStatus).toBe("in_progress");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.baseline_scan_queue where source_id=$1",
          [existingSourceId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    const queued = await db.query<{ count: number }>(`
      select count(*)::int as count from public.baseline_scan_queue queue
      join public.source_catalog source on source.id=queue.source_id
      join public.dependency_catalog dependency on dependency.id=source.dependency_id
      where dependency.slug='openai' and source.enabled and queue.status='queued'
    `);
    expect(queued.rows[0]!.count).toBe(sourceRows.rows.length - 1);

    const workspaceDependency = await db.query<{ id: string }>(
      "select id from public.workspace_dependencies where workspace_id=$1",
      [workspaceId],
    );
    const historical = await addClassifiedChange(
      db,
      existingSourceId,
      existingSnapshot.rows[0]!.id,
      2,
      "b",
      new Date(Date.now() - 86_400_000).toISOString(),
    );
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.customer_impact_dispatch_queue where workspace_dependency_id=$1 and source_change_classification_id in (select id from public.source_change_classifications where change_id=$2)",
          [workspaceDependency.rows[0]!.id, historical.changeId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    const current = await addClassifiedChange(
      db,
      existingSourceId,
      historical.snapshotId,
      3,
      "c",
      new Date().toISOString(),
    );
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.customer_impact_dispatch_queue where workspace_dependency_id=$1 and source_change_classification_id in (select id from public.source_change_classifications where change_id=$2)",
          [workspaceDependency.rows[0]!.id, current.changeId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    await db.close();
  });

  it("requires an owner/admin to claim the onboarding company in an existing workspace", async () => {
    const db = await database();
    await db.query("insert into auth.users(id) values ($1),($2)", [ownerId, otherId]);
    await asUser(db, ownerId);
    const workspace = await db.query<{ id: string }>(
      "select public.create_workspace('Existing workspace') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    await db.query(
      "insert into public.workspace_members(workspace_id,user_id,role) values ($1,$2,'member')",
      [workspaceId, otherId],
    );
    await asUser(db, otherId);
    await expect(
      db.query(
        `select public.start_workspace_onboarding(
          $1,'Existing workspace','Claimed Inc','https://claimed.example/','claimed.example','member-start-request',$2
        )`,
        [otherId, workspaceId],
      ),
    ).rejects.toThrow();
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.companies where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.workspace_onboarding where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(0);
    await db.close();
  });
});
