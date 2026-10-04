import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { SafeFetchError } from "@/lib/monitoring/fetcher";
import { scanSource } from "@/lib/monitoring/scan";
import type { MonitoringRepository, ScanOutcome } from "@/lib/monitoring/repository";

const migrationPath = fileURLToPath(
  new URL(
    "../supabase/migrations/20261002232050_auterim_monitoring_foundation.sql",
    import.meta.url,
  ),
);
const migration = await readFile(migrationPath, "utf8");
const classificationMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261003010000_semantic_change_classification.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const impactMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261004010000_customer_impact_intelligence.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const discoveryMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261004020000_url_dependency_discovery.sql", import.meta.url),
  ),
  "utf8",
);
const discoverySignalsMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261011000000_expanded_public_discovery_signals.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const onboardingMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261004030000_onboarding_activation_backend.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const preflightMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261005000000_preflight_breakage_prevention.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const preflightPrivilegeMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261005010000_preflight_claim_privilege_hardening.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const billingMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261006000000_auth_accounts_billing_entitlements.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const protectionMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261007000000_protection_value_notifications.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const growthMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261008000000_growth_engine_core.sql", import.meta.url),
  ),
  "utf8",
);
const growthBoundsMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261008010000_growth_engine_query_bounds.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const connectorMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261009000000_connector_platform_v1.sql", import.meta.url),
  ),
  "utf8",
);
const growthFeedbackMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261010000000_growth_feedback_v2.sql", import.meta.url),
  ),
  "utf8",
);
const growthSearchConsoleScopeMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261010010000_growth_search_console_exact_scope.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const partialDiscoveryMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261011010000_preserve_partial_discovery.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const discoveryOutcomeConsistencyMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261011020000_discovery_outcome_consistency.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const runtimeDiscoveryMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261012000000_runtime_dependency_discovery.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const onboardingWorkspaceIdempotencyMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261013000000_prevent_implicit_multiple_onboarding_workspaces.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

async function makeDatabase() {
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
  await db.exec(migration);
  await db.exec(classificationMigration);
  await db.exec(impactMigration);
  await db.exec(discoveryMigration);
  await db.exec(discoverySignalsMigration);
  await db.exec(onboardingMigration);
  await db.exec(preflightMigration);
  await db.exec(preflightPrivilegeMigration);
  await db.exec(billingMigration);
  await db.exec(protectionMigration);
  await db.exec(growthMigration);
  await db.exec(growthBoundsMigration);
  await db.exec(connectorMigration);
  await db.exec(growthFeedbackMigration);
  await db.exec(growthSearchConsoleScopeMigration);
  await db.exec(partialDiscoveryMigration);
  await db.exec(discoveryOutcomeConsistencyMigration);
  await db.exec(runtimeDiscoveryMigration);
  await db.exec(onboardingWorkspaceIdempotencyMigration);
  return db;
}

class PGliteMonitoringRepository implements MonitoringRepository {
  constructor(private readonly db: PGlite) {}
  async getSource(sourceId: string) {
    const result = await this.db.query<{
      id: string;
      url: string;
      enabled: boolean;
      etag: string | null;
      last_modified: string | null;
    }>("select id,url,enabled,etag,last_modified from public.source_catalog where id=$1", [
      sourceId,
    ]);
    return result.rows[0]!;
  }
  async beginScan(sourceId: string, triggerRunId: string, attemptNumber: number) {
    const result = await this.db.query<{
      value: {
        scanRunId: string;
        status: "pending" | "success" | "unchanged" | "changed" | "not_modified" | "failed";
        snapshotId: string | null;
        changeId: string | null;
      };
    }>("select public.begin_source_scan($1,$2,$3) as value", [
      sourceId,
      triggerRunId,
      attemptNumber,
    ]);
    return result.rows[0]!.value;
  }
  async getLatestSnapshot(sourceId: string) {
    const result = await this.db.query<{
      id: string;
      version: number;
      contentHash: string;
      normalizedContent: string;
      normalizedBytes: number;
    }>(
      `
      select id,version,content_hash as "contentHash",normalized_content as "normalizedContent",normalized_bytes as "normalizedBytes"
      from public.source_snapshots where source_id=$1 order by version desc limit 1
    `,
      [sourceId],
    );
    return result.rows[0] ?? null;
  }
  async recordResult(input: Record<string, unknown>): Promise<ScanOutcome> {
    const result = await this.db.query<{ value: ScanOutcome }>(
      `select public.record_source_scan_result(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
      ) as value`,
      [
        input.p_scan_run_id,
        input.p_source_id,
        input.p_http_status,
        input.p_content_bytes,
        input.p_not_modified,
        input.p_content_hash,
        input.p_normalized_content,
        input.p_etag,
        input.p_last_modified,
        input.p_expected_previous_snapshot_id,
        input.p_diff_text,
        input.p_added_lines,
        input.p_removed_lines,
        input.p_diff_truncated,
        input.p_previous_bytes,
        input.p_new_bytes,
      ],
    );
    return result.rows[0]!.value;
  }
  async recordFailure(input: {
    scanRunId: string;
    sourceId: string;
    category: string;
    summary: string;
    httpStatus: number | null;
  }) {
    await this.db.query("select public.record_source_scan_failure($1,$2,$3,$4,$5)", [
      input.scanRunId,
      input.sourceId,
      input.category,
      input.summary,
      input.httpStatus,
    ]);
  }
}

describe("Auterim migration and monitoring transaction", () => {
  let db: PGlite;
  let repository: PGliteMonitoringRepository;
  let sourceId: string;

  beforeAll(async () => {
    db = await makeDatabase();
    repository = new PGliteMonitoringRepository(db);
    const result = await db.query<{ id: string }>(
      `select source.id from public.source_catalog source join public.dependency_catalog dependency on dependency.id=source.dependency_id where dependency.slug='openai'`,
    );
    sourceId = result.rows[0]!.id;
  });

  it("applies the migration and enforces tenant isolation and global write boundaries", async () => {
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await db.query("insert into auth.users (id) values ($1),($2)", [userA, userB]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await db.exec("set role authenticated");
    const identity = await db.query<{ uid: string | null }>("select auth.uid()::text as uid");
    expect(identity.rows[0]!.uid).toBe(userA);
    const workspace = await db.query<{ id: string }>(
      "select public.create_workspace('Tenant A') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    const company = await db.query<{ id: string }>(
      "insert into public.companies (workspace_id,name,slug) values ($1,'Example','example') returning id",
      [workspaceId],
    );
    await db.query(
      "insert into public.company_context (workspace_id,company_id,context) values ($1,$2,'private context')",
      [workspaceId, company.rows[0]!.id],
    );
    await db.exec("reset role");

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userB]);
    await db.exec("set role authenticated");
    const privateRows = await db.query(
      "select * from public.company_context where workspace_id=$1",
      [workspaceId],
    );
    expect(privateRows.rows).toHaveLength(0);
    const unauthorizedUpdate = await db.query(
      "update public.companies set name='Taken' where workspace_id=$1",
      [workspaceId],
    );
    expect(unauthorizedUpdate.rowCount).toBe(0);
    await expect(
      db.query(
        "insert into public.companies (workspace_id,name,slug) values ($1,'Forged','forged')",
        [workspaceId],
      ),
    ).rejects.toBeTruthy();
    await expect(
      db.query(
        "insert into public.workspace_members (workspace_id,user_id,role) values ($1,$2,'owner')",
        [workspaceId, userB],
      ),
    ).rejects.toBeTruthy();
    await expect(db.query("select * from public.source_snapshots")).rejects.toBeTruthy();
    await expect(
      db.query("select * from public.list_due_source_ids(now(),100)"),
    ).rejects.toBeTruthy();
    await db.exec("reset role");

    await db.exec("set role anon");
    await expect(db.query("select * from public.workspaces")).rejects.toBeTruthy();
    await db.exec("reset role");
  });

  it("keeps connector credentials service-only and rejects cross-workspace connector mutations", async () => {
    const connectorDb = await makeDatabase();
    const owner = "11111111-1111-4111-8111-111111111111";
    const unrelated = "22222222-2222-4222-8222-222222222222";
    await connectorDb.query("insert into auth.users(id) values($1),($2)", [owner, unrelated]);
    await connectorDb.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await connectorDb.exec("set role authenticated");
    const workspace = await connectorDb.query<{ id: string }>(
      "select public.create_workspace('Connector tenant') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    await connectorDb.exec("reset role");
    await connectorDb.exec("set role service_role");
    const inserted = await connectorDb.query<{ id: string }>(
      `insert into public.connector_installations(workspace_id,provider,external_account_id,account_name)
       values($1,'slack','T123','Auterim fixture') returning id`,
      [workspaceId],
    );
    const installationId = inserted.rows[0]!.id;
    await connectorDb.query(
      `insert into public.connector_credentials(installation_id,workspace_id,ciphertext,nonce,authentication_tag,key_version)
       values($1,$2,'ciphertext','nonce','tag',1)`,
      [installationId, workspaceId],
    );
    const lateHealth = await connectorDb.query<{ value: boolean }>(
      "select public.update_connector_health($1,$2,'degraded','provider_unavailable') as value",
      [workspaceId, installationId],
    );
    expect(lateHealth.rows[0]!.value).toBe(true);
    await connectorDb.exec("reset role");
    await connectorDb.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await connectorDb.exec("set role authenticated");
    expect(
      (
        await connectorDb.query(
          "select id from public.connector_installations where workspace_id=$1",
          [workspaceId],
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      connectorDb.query("select * from public.connector_credentials"),
    ).rejects.toBeTruthy();
    await expect(
      connectorDb.query(
        "insert into public.connector_resources(workspace_id,installation_id,external_resource_id,resource_type,display_name) values($1,$2,'C123','channel','alerts')",
        [workspaceId, installationId],
      ),
    ).rejects.toBeTruthy();
    await connectorDb.exec("reset role");
    await connectorDb.exec("set role service_role");
    await expect(
      connectorDb.query("select public.claim_slack_notification_deliveries(10)"),
    ).resolves.toBeTruthy();
    await expect(
      connectorDb.query("select public.select_connector_resources($1,$2,$3,array[]::uuid[])", [
        workspaceId,
        installationId,
        unrelated,
      ]),
    ).rejects.toBeTruthy();
    await expect(
      connectorDb.query("select public.disconnect_connector($1,$2,$3)", [
        workspaceId,
        installationId,
        unrelated,
      ]),
    ).rejects.toBeTruthy();
    await connectorDb.query("select public.disconnect_connector($1,$2,$3)", [
      workspaceId,
      installationId,
      owner,
    ]);
    const lateAfterDisconnect = await connectorDb.query<{ value: boolean }>(
      "select public.update_connector_health($1,$2,'reauth_required','reauth_required') as value",
      [workspaceId, installationId],
    );
    expect(lateAfterDisconnect.rows[0]!.value).toBe(false);
    expect(
      (
        await connectorDb.query<{ lifecycle_state: string }>(
          "select lifecycle_state from public.connector_installations where id=$1",
          [installationId],
        )
      ).rows[0]!.lifecycle_state,
    ).toBe("disconnected");
    await connectorDb.exec("reset role");
    await connectorDb.query("select set_config('request.jwt.claim.sub',$1,false)", [unrelated]);
    await connectorDb.exec("set role authenticated");
    expect(
      (
        await connectorDb.query(
          "select id from public.connector_installations where workspace_id=$1",
          [workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
    await connectorDb.exec("reset role");
    await connectorDb.close();
  });

  it("isolates GitHub installations and repositories and updates protection links atomically", async () => {
    const m7db = await makeDatabase();
    const owner = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const unrelated = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await m7db.query("insert into auth.users (id) values ($1),($2)", [owner, unrelated]);
    await m7db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await m7db.exec("set role authenticated");
    const workspace = await m7db.query<{ id: string }>(
      "select public.create_workspace('Repository tenant') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    await m7db.exec("reset role");
    await m7db.exec("set role service_role");
    await m7db.query(
      `insert into public.workspace_subscriptions(workspace_id,plan,status,current_period_start,current_period_end)
       values ($1,'pro','active',now(),now()+interval '30 days')`,
      [workspaceId],
    );
    const connection = await m7db.query<{ id: string }>(
      `insert into public.repository_connections(workspace_id,installation_id,account_login,connected_by)
       values ($1,9001,'auterim-fixture',$2) returning id`,
      [workspaceId, owner],
    );
    const dependency = await m7db.query<{ id: string }>(
      "select id from public.dependency_catalog where slug='openai'",
    );
    const workspaceDependency = await m7db.query<{ id: string }>(
      `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by)
       values ($1,$2,$3) returning id`,
      [workspaceId, dependency.rows[0]!.id, owner],
    );
    const repository = await m7db.query<{ id: string }>(
      `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch)
       values ($1,$2,9002,'auterim-fixture','sample-app','main') returning id`,
      [workspaceId, connection.rows[0]!.id],
    );
    await m7db.exec("reset role");

    await m7db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await m7db.exec("set role authenticated");
    const linked = await m7db.query<{
      value: { selectedForProtection: boolean; dependencyCount: number };
    }>("select public.set_repository_protection($1,true,array[$2::uuid]) as value", [
      repository.rows[0]!.id,
      workspaceDependency.rows[0]!.id,
    ]);
    expect(linked.rows[0]!.value).toMatchObject({
      selectedForProtection: true,
      dependencyCount: 1,
    });
    expect(
      (
        await m7db.query(
          "select * from public.workspace_repository_access where repository_id=$1",
          [repository.rows[0]!.id],
        )
      ).rows,
    ).toHaveLength(1);
    await m7db.exec("reset role");

    await m7db.query("select set_config('request.jwt.claim.sub',$1,false)", [unrelated]);
    await m7db.exec("set role authenticated");
    expect(
      (await m7db.query("select * from public.repositories where id=$1", [repository.rows[0]!.id]))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await m7db.query("select * from public.repository_connections where id=$1", [
          connection.rows[0]!.id,
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(
      m7db.query("select public.set_repository_protection($1,false,array[]::uuid[])", [
        repository.rows[0]!.id,
      ]),
    ).rejects.toBeTruthy();
    await expect(
      m7db.query("select * from public.repository_installation_states"),
    ).rejects.toBeTruthy();
    await m7db.exec("reset role");
  });

  it("isolates discovery evidence by workspace and preserves confirmed dependency decisions", async () => {
    const userA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const userB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await db.query("insert into auth.users (id) values ($1),($2)", [userA, userB]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await db.exec("set role authenticated");
    const workspace = await db.query<{ id: string }>(
      "select public.create_workspace('Discovery tenant') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    const company = await db.query<{ id: string }>(
      "insert into public.companies (workspace_id,name,slug) values ($1,'Discovery Co','discovery-co') returning id",
      [workspaceId],
    );
    const companyId = company.rows[0]!.id;
    await db.exec("reset role");

    await db.exec("set role service_role");
    const run = await db.query<{ id: string }>(
      `insert into public.dependency_discovery_runs (
        workspace_id,company_id,website_url,trigger_run_id,attempt_number
      ) values ($1,$2,'https://discovery.example/','discovery-run',1) returning id`,
      [workspaceId, companyId],
    );
    const provider = await db.query<{ id: string }>(
      "select id from public.dependency_catalog where slug='stripe'",
    );
    await db.query(
      `select public.complete_url_dependency_discovery_run(
        $1,$2,$3,'completed',null,false,0,0,
        '[{"provider_slug":"stripe","signature_key":"stripe-js-v3","signal_type":"script_host","strength":"strong","source_origin":"https://discovery.example"}]'::jsonb,
        '[{"provider_slug":"stripe","confidence":0.72,"confidence_label":"medium","evidence_summary":[{"signatureKey":"stripe-js-v3"}]}]'::jsonb,
        '{"outcome":"complete"}'::jsonb
      )`,
      [run.rows[0]!.id, workspaceId, companyId],
    );
    for (const [index, signalType] of [
      "resource_host",
      "csp_host",
      "api_endpoint",
      "js_sdk",
      "redirect_host",
      "runtime_host",
      "runtime_script_host",
      "runtime_api_host",
    ].entries()) {
      await db.query(
        `insert into public.dependency_discovery_evidence (
          workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin
        ) values ($1,$2,'stripe',$3,$4,'medium','https://discovery.example')`,
        [workspaceId, run.rows[0]!.id, `m11-signal-${index}`, signalType],
      );
    }
    await expect(
      db.query(
        `insert into public.dependency_discovery_evidence (
          workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin
        ) values ($1,$2,'stripe','m11-unknown-signal','unknown_type','medium','https://discovery.example')`,
        [workspaceId, run.rows[0]!.id],
      ),
    ).rejects.toBeTruthy();
    const candidate = await db.query<{ id: string }>(
      "select id from public.discovered_dependencies where company_id=$1 and dependency_id=$2",
      [companyId, provider.rows[0]!.id],
    );
    const candidateId = candidate.rows[0]!.id;
    await db.query("update public.discovered_dependencies set status='confirmed' where id=$1", [
      candidateId,
    ]);
    await db.query("select public.fail_url_dependency_discovery_run($1,$2,'network_error')", [
      run.rows[0]!.id,
      workspaceId,
    ]);
    const completedAfterLateFailure = await db.query<{ status: string }>(
      "select status from public.dependency_discovery_runs where id=$1",
      [run.rows[0]!.id],
    );
    expect(completedAfterLateFailure.rows[0]!.status).toBe("completed");

    const partialRun = await db.query<{ id: string }>(
      `insert into public.dependency_discovery_runs (
        workspace_id,company_id,website_url,trigger_run_id,attempt_number,deep_pass_requested
      ) values ($1,$2,'https://discovery.example/','partial-discovery-run',1,true) returning id`,
      [workspaceId, companyId],
    );
    const safeCoverage = {
      outcome: "partial",
      durationMs: 1200,
      html: { attempted: true, status: 200, bytesRead: 2097152, truncated: true },
      javascript: {
        scriptsDiscovered: 2,
        scriptsAttempted: 2,
        scriptsFetched: 1,
        bytesFetched: 4096,
      },
    };
    await db.query(
      `select public.complete_url_dependency_discovery_run(
        $1,$2,$3,'partial',null,true,1,4096,'[]'::jsonb,'[]'::jsonb,$4::jsonb
      )`,
      [partialRun.rows[0]!.id, workspaceId, companyId, JSON.stringify(safeCoverage)],
    );
    await expect(
      db.query(
        `select public.complete_url_dependency_discovery_run(
          $1,$2,$3,'partial',null,true,1,4096,'[]'::jsonb,'[]'::jsonb,$4::jsonb
        )`,
        [
          partialRun.rows[0]!.id,
          "00000000-0000-4000-8000-000000000099",
          "00000000-0000-4000-8000-000000000098",
          JSON.stringify(safeCoverage),
        ],
      ),
    ).rejects.toBeTruthy();
    const storedPartial = await db.query<{ status: string; coverage: unknown }>(
      "select status,coverage from public.dependency_discovery_runs where id=$1",
      [partialRun.rows[0]!.id],
    );
    expect(storedPartial.rows[0]).toMatchObject({ status: "partial", coverage: safeCoverage });
    const inconsistentRun = await db.query<{ id: string }>(
      `insert into public.dependency_discovery_runs (
        workspace_id,company_id,website_url,trigger_run_id,attempt_number
      ) values ($1,$2,'https://discovery.example/','inconsistent-outcome-run',1) returning id`,
      [workspaceId, companyId],
    );
    await expect(
      db.query(
        `select public.complete_url_dependency_discovery_run(
          $1,$2,$3,'partial',null,true,0,0,'[]'::jsonb,'[]'::jsonb,'{"outcome":"complete"}'::jsonb
        )`,
        [inconsistentRun.rows[0]!.id, workspaceId, companyId],
      ),
    ).rejects.toBeTruthy();
    const stillRunning = await db.query<{ status: string }>(
      "select status from public.dependency_discovery_runs where id=$1",
      [inconsistentRun.rows[0]!.id],
    );
    expect(stillRunning.rows[0]!.status).toBe("running");
    await db.query(
      `select public.upsert_discovered_dependency_candidate(
        $1,$2,$3,0.99,'high','[{"signatureKey":"new-evidence"}]'::jsonb
      )`,
      [workspaceId, companyId, provider.rows[0]!.id],
    );
    const preserved = await db.query<{
      status: string;
      confidence: string;
      evidence_summary: unknown;
    }>(
      "select status,confidence,evidence_summary from public.discovered_dependencies where id=$1",
      [candidateId],
    );
    expect(preserved.rows[0]).toMatchObject({
      status: "confirmed",
      confidence: "0.720",
      evidence_summary: [{ signatureKey: "stripe-js-v3" }],
    });

    const atomicRun = await db.query<{ id: string }>(
      `insert into public.dependency_discovery_runs (
        workspace_id,company_id,website_url,trigger_run_id,attempt_number
      ) values ($1,$2,'https://discovery.example/','atomic-failure-run',1) returning id`,
      [workspaceId, companyId],
    );
    await expect(
      db.query(
        `select public.complete_url_dependency_discovery_run(
          $1,$2,$3,'completed',null,false,0,0,'[]'::jsonb,
          '[{"provider_slug":"cloudflare","confidence":0.72,"confidence_label":"medium","evidence_summary":[]},
            {"provider_slug":"vercel","confidence":2,"confidence_label":"high","evidence_summary":[]}]'::jsonb
        )`,
        [atomicRun.rows[0]!.id, workspaceId, companyId],
      ),
    ).rejects.toBeTruthy();
    const rolledBackCandidates = await db.query<{ count: string }>(
      `select count(*)::text as count from public.discovered_dependencies d
       join public.dependency_catalog c on c.id=d.dependency_id
       where d.company_id=$1 and c.slug in ('cloudflare','vercel')`,
      [companyId],
    );
    expect(rolledBackCandidates.rows[0]!.count).toBe("0");
    const atomicState = await db.query<{ status: string }>(
      "select status from public.dependency_discovery_runs where id=$1",
      [atomicRun.rows[0]!.id],
    );
    expect(atomicState.rows[0]!.status).toBe("running");
    await db.exec("reset role");

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userB]);
    await db.exec("set role authenticated");
    expect(
      (
        await db.query("select * from public.dependency_discovery_runs where workspace_id=$1", [
          workspaceId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query("select * from public.dependency_discovery_evidence where workspace_id=$1", [
          workspaceId,
        ])
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query("select * from public.discovered_dependencies where workspace_id=$1", [
          workspaceId,
        ])
      ).rows,
    ).toHaveLength(0);
    await expect(
      db.query(
        "insert into public.discovered_dependencies (workspace_id,company_id,dependency_id,confidence,confidence_label) values ($1,$2,$3,0.5,'medium')",
        [workspaceId, companyId, provider.rows[0]!.id],
      ),
    ).rejects.toBeTruthy();
    await db.exec("reset role");
  });

  it("proves baseline, unchanged, concurrent change, replay and repeated content with immutable history", async () => {
    await db.exec("set role service_role");
    let content = "<h1>Version A</h1><p>Same baseline</p>";
    const controlledFetcher = async () => ({
      status: 200,
      body: Buffer.from(content),
      contentType: "text/html",
      etag: null,
      lastModified: null,
      finalUrl: "https://fixture.invalid/source",
    });
    const execute = (triggerRunId: string, attemptNumber = 1) =>
      scanSource(
        { sourceId, triggerRunId, attemptNumber },
        {
          repository,
          fetcher: controlledFetcher as never,
          enqueueClassifier: async () => undefined,
        },
      );

    const first = await execute("run-baseline");
    expect(first.status).toBe("success");
    expect(
      (await db.query("select * from public.source_snapshots where source_id=$1", [sourceId])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.source_changes where source_id=$1", [sourceId])).rows,
    ).toHaveLength(0);

    const second = await execute("run-unchanged");
    expect(second.status).toBe("unchanged");
    expect(
      (await db.query("select * from public.source_snapshots where source_id=$1", [sourceId])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.scan_runs where source_id=$1", [sourceId])).rows,
    ).toHaveLength(2);

    content = "<h1>Version B</h1><p>Meaningful change</p>";
    const concurrent = await Promise.all([execute("run-change-1"), execute("run-change-2")]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(["changed", "unchanged"]);
    const snapshots = await db.query<{
      id: string;
      version: number;
      previous_snapshot_id: string | null;
      normalized_content: string;
    }>(
      "select id,version,previous_snapshot_id,normalized_content from public.source_snapshots where source_id=$1 order by version",
      [sourceId],
    );
    expect(snapshots.rows).toHaveLength(2);
    expect(snapshots.rows[1]).toMatchObject({
      version: 2,
      previous_snapshot_id: snapshots.rows[0]!.id,
      normalized_content: "Version B\nMeaningful change",
    });
    const changes = await db.query<{ previous_snapshot_id: string; new_snapshot_id: string }>(
      "select previous_snapshot_id,new_snapshot_id from public.source_changes where source_id=$1",
      [sourceId],
    );
    expect(changes.rows).toEqual([
      { previous_snapshot_id: snapshots.rows[0]!.id, new_snapshot_id: snapshots.rows[1]!.id },
    ]);

    const queued = await db.query<{ id: string; change_id: string; status: string }>(
      "select id,change_id,status from public.source_change_classifications where change_id=(select id from public.source_changes where source_id=$1)",
      [sourceId],
    );
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]!.status).toBe("queued");
    const changeId = queued.rows[0]!.change_id;
    const classificationStart = await db.query<{ value: Record<string, unknown> }>(
      "select public.begin_source_change_classification($1,'classifier-run-1',1,'semantic-v1',1,'materiality-v1','openai') as value",
      [changeId],
    );
    const classificationPacket = classificationStart.rows[0]!.value;
    expect(classificationPacket).toMatchObject({ status: "processing", changeId });
    expect(classificationPacket).not.toHaveProperty("tenantContext");
    const evidenceFingerprint = classificationPacket.evidenceFingerprint;
    const classification = await db.query<{ value: Record<string, unknown> }>(
      `select public.record_source_change_classification(
        $1,'semantic-v1',$2,'classifier-run-1',1,'openai','fixture/model',1,'materiality-v1',true,
        'api_change','[\"/v2\"]'::jsonb,'high',0.91,'The changed API limit can affect integrations.',
        '[{"type":"added","excerpt":"Meaningful change"}]'::jsonb,
        'The source documents an API behavior change.','classified',null,null,5
      ) as value`,
      [changeId, evidenceFingerprint],
    );
    expect(classification.rows[0]!.value).toMatchObject({
      status: "classified",
      changeId,
      classification: {
        material: true,
        category: "api_change",
        affectedEntities: ["/v2"],
        severityHint: "high",
        decisionStatus: "classified",
      },
      replayed: false,
    });
    const replayedClassification = await db.query<{ value: Record<string, unknown> }>(
      "select public.begin_source_change_classification($1,'classifier-run-2',1,'semantic-v1',1,'materiality-v1','openai') as value",
      [changeId],
    );
    expect(replayedClassification.rows[0]!.value).toMatchObject({
      status: "classified",
      classification: { material: true, category: "api_change" },
      replayed: true,
    });

    const v2 = await db.query<{ value: Record<string, unknown> }>(
      `select public.begin_source_change_classification($1,'classifier-run-v2',1,'semantic-v2',2,'materiality-v2','openai') as value`,
      [changeId],
    );
    expect(v2.rows[0]!.value).toMatchObject({
      status: "processing",
      classifierVersion: "semantic-v2",
    });
    await db.query(
      `select public.record_source_change_classification(
        $1,'semantic-v2',$2,'classifier-run-v2',1,'openai','fixture/model-v2',2,'materiality-v2',true,
        'api_change','[\"/v2\"]'::jsonb,'high',0.91,'API contract changed.',
        '[{"type":"added","excerpt":"Meaningful change"}]'::jsonb,
        'The source documents an API behavior change.','classified',null,null,2
      )`,
      [changeId, evidenceFingerprint],
    );
    const versionRows = await db.query<{ classifier_version: string }>(
      "select classifier_version from public.source_change_classifications where change_id=$1 order by classifier_version",
      [changeId],
    );
    expect(versionRows.rows.map((row) => row.classifier_version)).toEqual([
      "semantic-v1",
      "semantic-v2",
    ]);

    const replay = await execute("run-change-1");
    expect(replay).toMatchObject({ status: "changed", replayed: true });
    const repeated = await execute("run-repeated-b");
    expect(repeated.status).toBe("unchanged");
    expect(
      (await db.query("select * from public.source_snapshots where source_id=$1", [sourceId])).rows,
    ).toHaveLength(2);
    expect(
      (await db.query("select * from public.source_changes where source_id=$1", [sourceId])).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.scan_runs where source_id=$1", [sourceId])).rows,
    ).toHaveLength(5);
    await expect(
      db.query("update public.source_snapshots set normalized_content='tampered' where id=$1", [
        snapshots.rows[0]!.id,
      ]),
    ).rejects.toBeTruthy();
    await expect(db.exec("truncate public.source_snapshots")).rejects.toBeTruthy();
    const due = await db.query<{ source_id: string }>(
      "select * from public.list_due_source_ids(now()+interval '2 days', 999)",
    );
    expect(due.rows.map((row) => row.source_id)).toContain(sourceId);
    await db.exec("reset role");
  });

  it("records 304 checks and classified fetch failures without creating snapshots", async () => {
    await db.exec("set role service_role");
    const before = await db.query("select id from public.source_snapshots where source_id=$1", [
      sourceId,
    ]);
    const notModified = await scanSource(
      { sourceId, triggerRunId: "run-not-modified", attemptNumber: 1 },
      {
        repository,
        fetcher: (async () => ({
          status: 304,
          body: Buffer.alloc(0),
          contentType: null,
          etag: null,
          lastModified: null,
          finalUrl: "https://fixture.invalid/source",
        })) as never,
      },
    );
    expect(notModified.status).toBe("not_modified");

    await expect(
      scanSource(
        { sourceId, triggerRunId: "run-fetch-failure", attemptNumber: 1 },
        {
          repository,
          fetcher: (async () => {
            throw new SafeFetchError("timeout", "The source request timed out.");
          }) as never,
        },
      ),
    ).rejects.toMatchObject({ category: "timeout" });

    const after = await db.query("select id from public.source_snapshots where source_id=$1", [
      sourceId,
    ]);
    expect(after.rows).toHaveLength(before.rows.length);
    const runs = await db.query<{ status: string; error_category: string | null }>(
      "select status,error_category from public.scan_runs where trigger_run_id in ('run-not-modified','run-fetch-failure') order by trigger_run_id",
    );
    expect(runs.rows).toContainEqual({ status: "failed", error_category: "timeout" });
    expect(runs.rows).toContainEqual({ status: "not_modified", error_category: null });
    await db.exec("reset role");
  });

  it("stores tenant impact separately, fingerprints re-evaluations, and enforces member-only reads", async () => {
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const dependency = await db.query<{ dependency_id: string }>(
      "select dependency_id from public.source_catalog where id=$1",
      [sourceId],
    );
    const workspaceA = await db.query<{ id: string }>(
      "select id from public.workspaces where created_by=$1 limit 1",
      [userA],
    );
    const classification = await db.query<{
      id: string;
      change_id: string;
      evidence_fingerprint: string;
    }>(
      "select id,change_id,evidence_fingerprint from public.source_change_classifications where status='classified' and material and decision_status='classified' order by created_at desc,id desc limit 1",
    );
    expect(workspaceA.rows).toHaveLength(1);
    expect(classification.rows).toHaveLength(1);

    await db.exec("set role service_role");
    const workspaceDependencyA = await db.query<{ id: string }>(
      "insert into public.workspace_dependencies (workspace_id,dependency_id,selected_by,protection_started_at) values ($1,$2,$3,'epoch') returning id",
      [workspaceA.rows[0]!.id, dependency.rows[0]!.dependency_id, userA],
    );
    const workspaceB = await db.query<{ id: string }>(
      "insert into public.workspaces (name,created_by) values ('Tenant B', $1) returning id",
      [userB],
    );
    await db.query(
      "insert into public.workspace_members (workspace_id,user_id,role) values ($1,$2,'owner')",
      [workspaceB.rows[0]!.id, userB],
    );
    const workspaceDependencyB = await db.query<{ id: string }>(
      "insert into public.workspace_dependencies (workspace_id,dependency_id,selected_by,protection_started_at) values ($1,$2,$3,'epoch') returning id",
      [workspaceB.rows[0]!.id, dependency.rows[0]!.dependency_id, userB],
    );
    await db.query(
      `insert into public.dependency_context (
        workspace_id,workspace_dependency_id,criticality,production_critical,used_for,context_note
      ) values ($1,$2,'critical',true,'["verification"]'::jsonb,'Tenant A private verification context'),
               ($3,$4,'normal',false,'["billing"]'::jsonb,'TENANT_B_SECRET_CONTEXT')`,
      [
        workspaceA.rows[0]!.id,
        workspaceDependencyA.rows[0]!.id,
        workspaceB.rows[0]!.id,
        workspaceDependencyB.rows[0]!.id,
      ],
    );

    const assessment = await db.query<{ id: string }>(
      `insert into public.impact_assessments (
        workspace_id,workspace_dependency_id,source_change_classification_id,context_fingerprint,
        impact_engine_version,schema_version,prompt_version,provider,model,status,attempt_count,
        trigger_run_id,attempt_number,relevant,relevance,severity,affected_areas,impact_summary,
        why_it_matters,action_required,recommended_action,confidence,missing_context,evidence_refs,assessed_at
      ) values (
        $1,$2,$3,repeat('a',64),'impact-v1',1,'impact-prompt-v1','openai','gpt-6.1-sol','assessed',1,
        'impact-run-a',1,true,'high','high','["verification"]'::jsonb,
        'The provider change may affect verification.','The dependency is marked production critical.',
        false,null,0.91,'[]'::jsonb,'[]'::jsonb,now()
      ) returning id`,
      [workspaceA.rows[0]!.id, workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
    );

    const packet = await db.query<{ value: Record<string, unknown> }>(
      "select public.load_customer_impact_packet($1,$2) as value",
      [workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
    );
    expect(JSON.stringify(packet.rows[0]!.value)).toContain(
      "Tenant A private verification context",
    );
    expect(JSON.stringify(packet.rows[0]!.value)).not.toContain("TENANT_B_SECRET_CONTEXT");
    await expect(
      db.query("select public.load_customer_impact_packet($1,$2)", [
        workspaceDependencyB.rows[0]!.id,
        classification.rows[0]!.id,
      ]),
    ).resolves.toBeTruthy();

    const targetIds = await db.query<{ workspace_dependency_id: string }>(
      "select workspace_dependency_id from public.customer_impact_dispatch_queue where source_change_classification_id=$1 and context_revision=1 and status='queued'",
      [classification.rows[0]!.id],
    );
    expect(targetIds.rows.map((row) => row.workspace_dependency_id).sort()).toEqual(
      [workspaceDependencyA.rows[0]!.id, workspaceDependencyB.rows[0]!.id].sort(),
    );

    const replay = await db.query<{ value: Record<string, unknown> }>(
      `select public.begin_customer_impact_assessment(
        $1,$2,repeat('a',64),'impact-v1',1,'impact-prompt-v1','openai','impact-run-replay',1
      ) as value`,
      [workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
    );
    expect(replay.rows[0]!.value).toMatchObject({ status: "assessed", replayed: true });

    const changedContext = await db.query<{ value: Record<string, unknown> }>(
      `select public.begin_customer_impact_assessment(
        $1,$2,repeat('b',64),'impact-v1',1,'impact-prompt-v1','openai','impact-run-context-v2',1
      ) as value`,
      [workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
    );
    expect(changedContext.rows[0]!.value).toMatchObject({ status: "processing", attemptCount: 1 });
    const history = await db.query<{ count: number }>(
      "select count(*)::int as count from public.impact_assessments where workspace_dependency_id=$1 and source_change_classification_id=$2",
      [workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
    );
    expect(history.rows[0]!.count).toBe(2);

    await db.query(
      `select public.upsert_dependency_impact_context($1,$2,'important',true,'["AI processing"]'::jsonb,'Updated context','{}'::jsonb)`,
      [workspaceA.rows[0]!.id, workspaceDependencyA.rows[0]!.id],
    );
    const queueHistory = await db.query<{
      context_revision: number;
      status: string;
      dispatch_attempt_count: number;
    }>(
      "select context_revision,status,dispatch_attempt_count from public.customer_impact_dispatch_queue where workspace_dependency_id=$1 and source_change_classification_id=$2 order by context_revision",
      [workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
    );
    expect(queueHistory.rows.map((row) => [row.context_revision, row.status])).toEqual([
      [0, "superseded"],
      [1, "superseded"],
      [2, "queued"],
    ]);
    const candidateA = queueHistory.rows[2]!;
    const queueIdA = await db.query<{ id: string }>(
      "select id from public.customer_impact_dispatch_queue where workspace_dependency_id=$1 and source_change_classification_id=$2 and context_revision=2",
      [workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
    );
    await db.query("select public.mark_customer_impact_queue_dispatched($1)", [
      queueIdA.rows[0]!.id,
    ]);
    await db.query("select public.mark_customer_impact_queue_complete($1)", [queueIdA.rows[0]!.id]);
    const queueIdBInitial = await db.query<{ id: string }>(
      "select id from public.customer_impact_dispatch_queue where workspace_dependency_id=$1 and source_change_classification_id=$2 and context_revision=1",
      [workspaceDependencyB.rows[0]!.id, classification.rows[0]!.id],
    );
    await db.query("select public.mark_customer_impact_queue_dispatched($1)", [
      queueIdBInitial.rows[0]!.id,
    ]);
    await db.exec("reset role");
    await db.exec(
      "alter table public.customer_impact_dispatch_queue disable trigger customer_impact_queue_set_updated_at",
    );
    await db.query(
      "update public.customer_impact_dispatch_queue set status='dispatched',updated_at=now()-interval '16 minutes' where workspace_dependency_id=$1 and source_change_classification_id=$2 and context_revision=1",
      [workspaceDependencyB.rows[0]!.id, classification.rows[0]!.id],
    );
    await db.exec(
      "alter table public.customer_impact_dispatch_queue enable trigger customer_impact_queue_set_updated_at",
    );
    await db.exec("set role service_role");
    const recoveredQueue = await db.query<{ queue_id: string }>(
      "select queue_id from public.list_customer_impact_dispatch_queue($1,100)",
      [classification.rows[0]!.change_id],
    );
    expect(recoveredQueue.rows).toHaveLength(1);
    const queueIdB = recoveredQueue.rows[0]!.queue_id;
    await db.query("select public.mark_customer_impact_queue_dispatched($1)", [queueIdB]);
    const dispatchAttempts = await db.query<{ dispatch_attempt_count: number }>(
      "select dispatch_attempt_count from public.customer_impact_dispatch_queue where id=$1",
      [queueIdB],
    );
    expect(dispatchAttempts.rows[0]!.dispatch_attempt_count).toBe(2);
    await db.query(
      `select public.upsert_dependency_impact_context($1,$2,'important',true,'["AI processing"]'::jsonb,'Updated context','{}'::jsonb)`,
      [workspaceA.rows[0]!.id, workspaceDependencyA.rows[0]!.id],
    );
    const unchangedContextRevision = await db.query<{ context_revision: number }>(
      "select context_revision from public.dependency_context where workspace_dependency_id=$1",
      [workspaceDependencyA.rows[0]!.id],
    );
    expect(unchangedContextRevision.rows[0]!.context_revision).toBe(2);
    await expect(
      db.query(
        `select public.upsert_dependency_impact_context($1,$2,'important',true,'["unknown label"]'::jsonb,'bad','{}'::jsonb)`,
        [workspaceA.rows[0]!.id, workspaceDependencyA.rows[0]!.id],
      ),
    ).rejects.toBeTruthy();
    expect(candidateA.dispatch_attempt_count).toBe(0);

    const staleAssessmentStart = await db.query<{ value: Record<string, unknown> }>(
      `select public.begin_customer_impact_assessment(
        $1,$2,repeat('e',64),'impact-race-v1',1,'impact-prompt-v1','openai','stale-race-run',1
      ) as value`,
      [workspaceDependencyB.rows[0]!.id, classification.rows[0]!.id],
    );
    expect(staleAssessmentStart.rows[0]!.value).toMatchObject({ status: "processing" });
    await db.query(
      "select public.begin_source_change_classification($1,'classifier-run-v3',1,'semantic-v3',3,'materiality-v3','openai')",
      [classification.rows[0]!.change_id],
    );
    await db.query(
      `select public.record_source_change_classification(
        $1,'semantic-v3',$2,'classifier-run-v3',1,'openai','fixture/model-v3',3,'materiality-v3',true,
        'api_change','["/v3"]'::jsonb,'high',0.94,'A newer global classification. ',
        '[{"type":"added","excerpt":"A newer global classification."}]'::jsonb,
        'The source documents a newer API behavior change.','classified',null,null,1
      )`,
      [classification.rows[0]!.change_id, classification.rows[0]!.evidence_fingerprint],
    );
    await expect(
      db.query("select public.load_customer_impact_packet($1,$2)", [
        workspaceDependencyA.rows[0]!.id,
        classification.rows[0]!.id,
      ]),
    ).rejects.toBeTruthy();
    await expect(
      db.query(
        `select public.record_customer_impact_assessment(
          $1,'stale-race-run',1,'openai','fixture/model-v1',false,'none','low',
          '["billing"]'::jsonb,'No recorded billing impact.','The tenant uses billing only.',
          false,null,0.7,'[]'::jsonb,
          '[{"source":"global_evidence","excerpt":"Meaningful change"},{"source":"dependency_context","excerpt":"billing"}]'::jsonb,
          100,50,1
        )`,
        [(staleAssessmentStart.rows[0]!.value as { id: string }).id],
      ),
    ).rejects.toBeTruthy();
    await expect(
      db.query(
        `select public.begin_customer_impact_assessment(
          $1,$2,repeat('d',64),'impact-v1',1,'impact-prompt-v1','openai','stale-run',1
        )`,
        [workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
      ),
    ).rejects.toBeTruthy();
    await db.query(
      "select public.begin_source_change_classification($1,'classifier-run-v4',1,'semantic-v4',4,'materiality-v4','openai')",
      [classification.rows[0]!.change_id],
    );
    await db.query(
      `select public.record_source_change_classification_failure(
        $1,'semantic-v4',$2,'classifier-run-v4',1,'openai',4,'materiality-v4',
        'fixture_failure','The newer classifier fixture failed.'
      )`,
      [classification.rows[0]!.change_id, classification.rows[0]!.evidence_fingerprint],
    );
    const latestSuccessful = await db.query<{ id: string }>(
      "select id from public.source_change_classifications where change_id=$1 and classifier_version='semantic-v3'",
      [classification.rows[0]!.change_id],
    );
    await expect(
      db.query("select public.load_customer_impact_packet($1,$2)", [
        workspaceDependencyA.rows[0]!.id,
        latestSuccessful.rows[0]!.id,
      ]),
    ).resolves.toBeTruthy();
    const recoveredAfterFailure = await db.query<{ source_change_classification_id: string }>(
      "select source_change_classification_id from public.list_customer_impact_dispatch_queue($1,100)",
      [classification.rows[0]!.change_id],
    );
    expect(recoveredAfterFailure.rows.length).toBeGreaterThan(0);
    expect(
      recoveredAfterFailure.rows.every(
        (row) => row.source_change_classification_id === latestSuccessful.rows[0]!.id,
      ),
    ).toBe(true);
    await db.exec("reset role");

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await db.exec("set role authenticated");
    const visibleToMember = await db.query<{ id: string }>(
      "select id from public.impact_assessments where id=$1",
      [assessment.rows[0]!.id],
    );
    expect(visibleToMember.rows).toHaveLength(1);
    await expect(
      db.query(
        "insert into public.impact_assessments (workspace_id,workspace_dependency_id,source_change_classification_id,context_fingerprint,impact_engine_version,schema_version,prompt_version,provider) values ($1,$2,$3,repeat('c',64),'impact-v1',1,'impact-prompt-v1','openai')",
        [workspaceA.rows[0]!.id, workspaceDependencyA.rows[0]!.id, classification.rows[0]!.id],
      ),
    ).rejects.toBeTruthy();
    await expect(
      db.query("select public.get_dependency_impact_context($1,$2)", [
        workspaceA.rows[0]!.id,
        workspaceDependencyA.rows[0]!.id,
      ]),
    ).rejects.toBeTruthy();
    await db.exec("reset role");

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userB]);
    await db.exec("set role authenticated");
    const hiddenFromOtherMember = await db.query<{ id: string }>(
      "select id from public.impact_assessments where id=$1",
      [assessment.rows[0]!.id],
    );
    expect(hiddenFromOtherMember.rows).toHaveLength(0);
    await db.exec("reset role");
    await db.exec("set role anon");
    await expect(db.query("select * from public.impact_assessments")).rejects.toBeTruthy();
    await db.exec("reset role");
  });

  it("keeps Growth Engine records and queue RPCs server-only with bounded claims", async () => {
    const tables = [
      "growth_topics",
      "growth_opportunities",
      "growth_opportunity_evaluations",
      "growth_opportunity_evidence",
      "growth_distribution_candidates",
      "growth_evaluation_queue",
    ];
    await db.exec("set role anon");
    for (const table of tables)
      await expect(db.query(`select * from public.${table}`)).rejects.toBeTruthy();
    await expect(
      db.query("select * from public.claim_growth_evaluation_batch(1)"),
    ).rejects.toBeTruthy();
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    ]);
    for (const table of tables)
      await expect(db.query(`select * from public.${table}`)).rejects.toBeTruthy();
    await expect(
      db.query("select * from public.claim_growth_evaluation_batch(1)"),
    ).rejects.toBeTruthy();
    await db.exec("reset role; set role service_role");
    await expect(
      db.query("select * from public.claim_growth_evaluation_batch(101)"),
    ).rejects.toBeTruthy();
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where oid=any($1::regclass[])",
      [tables.map((table) => `public.${table}`)],
    );
    expect(rls.rows).toHaveLength(tables.length);
    expect(rls.rows.every((row) => row.relrowsecurity)).toBe(true);
    await db.exec("reset role");
  });

  it("keeps Search Console credentials, queries, conversions and feedback private", async () => {
    const tables = [
      "growth_search_console_oauth_states",
      "growth_search_console_connection",
      "growth_search_console_metrics",
      "growth_first_party_events",
      "growth_public_event_ingest_buckets",
      "growth_feedback_opportunities",
      "growth_search_console_sync_runs",
    ];
    await db.exec("set role anon");
    for (const table of tables)
      await expect(db.query(`select * from public.${table}`)).rejects.toBeTruthy();
    await expect(
      db.query(
        "select public.claim_growth_search_console_oauth_state(repeat('a',64),repeat('b',64))",
      ),
    ).rejects.toBeTruthy();
    await db.exec("reset role; set role authenticated");
    for (const table of tables)
      await expect(db.query(`select * from public.${table}`)).rejects.toBeTruthy();
    await expect(
      db.query(
        "select public.persist_growth_search_console_connection('sc-domain:auterim.com','c','n','t',1,array['https://www.googleapis.com/auth/webmasters.readonly'],'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now())",
      ),
    ).rejects.toBeTruthy();
    await db.exec("reset role");
    const userId = "abababab-abab-4bab-8bab-abababababab";
    await db.query("insert into auth.users(id) values($1)", [userId]);
    await db.exec("set role service_role");
    await expect(
      db.query(
        "select public.persist_growth_search_console_connection('sc-domain:auterim.com','c','n','t',1,array['https://www.googleapis.com/auth/webmasters.readonly','https://www.googleapis.com/auth/webmasters'],'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now())",
      ),
    ).rejects.toBeTruthy();
    await expect(
      db.query(
        "select public.persist_growth_search_console_connection('sc-domain:auterim.com','c','n','t',1,null,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',now())",
      ),
    ).rejects.toBeTruthy();
    await db.query(
      "insert into public.growth_search_console_oauth_states(state_hash,actor_user_id,browser_hash,verifier_ciphertext,verifier_nonce,verifier_authentication_tag,verifier_key_version,actor_token_ciphertext,actor_token_nonce,actor_token_authentication_tag,actor_token_key_version,expires_at) values(repeat('a',64),$1,repeat('b',64),'cipher','nonce','tag',1,'actor','nonce','tag',1,now()+interval '5 minutes')",
      [userId],
    );
    const wrongBrowserClaim = await db.query(
      "select * from public.claim_growth_search_console_oauth_state(repeat('a',64),repeat('c',64))",
    );
    expect(wrongBrowserClaim.rows).toHaveLength(0);
    const claimed = await db.query<{ actor_user_id: string }>(
      "select * from public.claim_growth_search_console_oauth_state(repeat('a',64),repeat('b',64))",
    );
    expect(claimed.rows).toHaveLength(1);
    const replay = await db.query(
      "select * from public.claim_growth_search_console_oauth_state(repeat('a',64),repeat('b',64))",
    );
    expect(replay.rows).toHaveLength(0);
    const firstSyncClaim = await db.query<{ acquired: boolean }>(
      "select acquired from public.claim_growth_search_console_sync('m14-sync-test','2026-09-01','2026-09-30',$1)",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    );
    const competingSyncClaim = await db.query<{ acquired: boolean }>(
      "select acquired from public.claim_growth_search_console_sync('m14-sync-test','2026-09-01','2026-09-30',$1)",
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    );
    expect(firstSyncClaim.rows[0]?.acquired).toBe(true);
    expect(competingSyncClaim.rows[0]?.acquired).toBe(false);
    let acceptedPublicEvents = 0;
    for (let index = 0; index < 121; index += 1) {
      const allowed = await db.query<{ allowed: boolean }>(
        "select public.claim_growth_public_conversion_event() as allowed",
      );
      if (allowed.rows[0]?.allowed) acceptedPublicEvents += 1;
    }
    expect(acceptedPublicEvents).toBe(120);
    const candidatePayload = {
      opportunity_key: "c".repeat(64),
      opportunity_type: "near_page_one",
      canonical_path: "/tools",
      topic_key: null,
      evidence: { currentImpressions: 123, rulesVersion: "growth-feedback-v2-rules-1" },
      rules_version: "growth-feedback-v2-rules-1",
    };
    const firstCandidate = await db.query<{ id: string }>(
      "select public.record_growth_feedback_candidate($1::jsonb) as id",
      [JSON.stringify(candidatePayload)],
    );
    await db.query(
      "update public.growth_feedback_opportunities set status='approved' where opportunity_key=$1",
      [candidatePayload.opportunity_key],
    );
    const retryCandidate = await db.query<{ id: string }>(
      "select public.record_growth_feedback_candidate($1::jsonb) as id",
      [
        JSON.stringify({
          ...candidatePayload,
          evidence: { currentImpressions: 150, rulesVersion: "growth-feedback-v2-rules-1" },
        }),
      ],
    );
    expect(retryCandidate.rows[0]?.id).toBe(firstCandidate.rows[0]?.id);
    const preservedCandidate = await db.query<{
      status: string;
      evidence: Record<string, unknown>;
    }>(
      "select status,evidence from public.growth_feedback_opportunities where opportunity_key=$1",
      [candidatePayload.opportunity_key],
    );
    expect(preservedCandidate.rows[0]).toMatchObject({
      status: "approved",
      evidence: { currentImpressions: 150 },
    });
    const metricColumns = await db.query<{ has_query_text: boolean }>(
      "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='growth_search_console_metrics' and column_name in ('query','query_text')) as has_query_text",
    );
    expect(metricColumns.rows[0]?.has_query_text).toBe(false);
    const visitorColumns = await db.query<{ has_visitor_identifier: boolean }>(
      "select exists(select 1 from information_schema.columns where table_schema='public' and table_name='growth_first_party_events' and column_name in ('visitor_id','visitor_hash','fingerprint')) as has_visitor_identifier",
    );
    expect(visitorColumns.rows[0]?.has_visitor_identifier).toBe(false);
    await db.query(
      "insert into public.growth_search_console_metrics(metric_key,property,metric_date,query_fingerprint,query_fingerprint_key_version,query_topic_match,page_url,clicks,impressions,ctr,average_position) values(repeat('d',64),'sc-domain:auterim.com','2026-10-01',repeat('e',64),1,true,'https://auterim.com/tools',1,100,0.01,10) on conflict(metric_key) do update set clicks=excluded.clicks,impressions=excluded.impressions,ctr=excluded.ctr",
    );
    await db.query(
      "insert into public.growth_search_console_metrics(metric_key,property,metric_date,query_fingerprint,query_fingerprint_key_version,query_topic_match,page_url,clicks,impressions,ctr,average_position) values(repeat('d',64),'sc-domain:auterim.com','2026-10-01',repeat('e',64),1,true,'https://auterim.com/tools',3,120,0.025,9) on conflict(metric_key) do update set clicks=excluded.clicks,impressions=excluded.impressions,ctr=excluded.ctr",
    );
    const reconciledMetric = await db.query<{ count: number; clicks: number }>(
      "select count(*)::int as count,max(clicks)::int as clicks from public.growth_search_console_metrics where metric_key=repeat('d',64)",
    );
    expect(reconciledMetric.rows[0]).toEqual({ count: 1, clicks: 3 });
    await db.query(
      "insert into public.growth_search_console_connection(id,property,lifecycle_state,health_state,scopes,ciphertext,nonce,authentication_tag,key_version,access_expires_at) values('auterim','sc-domain:auterim.com','connected','healthy',array['https://www.googleapis.com/auth/webmasters.readonly'],'c','n','t',1,now()-interval '1 minute')",
    );
    const refreshA = await db.query<{ credential_version: number }>(
      "select credential_version from public.claim_growth_search_console_refresh($1)",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    );
    const refreshB = await db.query(
      "select * from public.claim_growth_search_console_refresh($1)",
      ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    );
    expect(refreshA.rows).toHaveLength(1);
    expect(refreshB.rows).toHaveLength(0);
    const refreshReleased = await db.query<{ released: boolean }>(
      "select public.release_growth_search_console_refresh($1,'degraded','degraded','provider_unavailable') as released",
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    );
    expect(refreshReleased.rows[0]?.released).toBe(true);
    const syncRun = await db.query<{ id: string }>(
      "select id from public.growth_search_console_sync_runs where run_key='m14-sync-test'",
    );
    const completedSync = await db.query<{ finished: boolean }>(
      "select public.finish_growth_search_console_sync($1,$2,'complete',2,12,12,null,now()) as finished",
      [syncRun.rows[0]?.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    );
    expect(completedSync.rows[0]?.finished).toBe(true);
    const completedHealth = await db.query<{ status: string; health_state: string }>(
      `select run.status,connection.health_state from public.growth_search_console_sync_runs run
       cross join public.growth_search_console_connection connection where run.run_key='m14-sync-test'`,
    );
    expect(completedHealth.rows[0]).toEqual({ status: "complete", health_state: "healthy" });
    const replayedFinish = await db.query<{ finished: boolean }>(
      "select public.finish_growth_search_console_sync($1,$2,'complete',2,12,12,null,now()) as finished",
      [syncRun.rows[0]?.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    );
    expect(replayedFinish.rows[0]?.finished).toBe(false);

    const expiredClaim = await db.query<{ run_id: string; acquired: boolean }>(
      "select run_id,acquired from public.claim_growth_search_console_sync('m14-expired-sync-test','2026-09-01','2026-09-30',$1)",
      ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    );
    await db.query(
      "update public.growth_search_console_sync_runs set lease_until=now()-interval '1 second' where run_key='m14-expired-sync-test'",
    );
    const expiredFinish = await db.query<{ finished: boolean }>(
      "select public.finish_growth_search_console_sync($1,$2,'complete',1,1,1,null,now()) as finished",
      [expiredClaim.rows[0]?.run_id, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"],
    );
    expect(expiredClaim.rows[0]?.acquired).toBe(true);
    expect(expiredFinish.rows[0]?.finished).toBe(false);

    const failedClaim = await db.query<{ run_id: string; acquired: boolean }>(
      "select run_id,acquired from public.claim_growth_search_console_sync('m14-failed-sync-test','2026-09-01','2026-09-30',$1)",
      ["dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
    );
    const failedFinish = await db.query<{ finished: boolean }>(
      "select public.finish_growth_search_console_sync($1,$2,'failed',1,0,0,'provider_unavailable',now()) as finished",
      [failedClaim.rows[0]?.run_id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"],
    );
    const failedHealth = await db.query<{ status: string; health_state: string }>(
      "select last_sync_status as status,health_state from public.growth_search_console_connection where id='auterim'",
    );
    expect(failedFinish.rows[0]?.finished).toBe(true);
    expect(failedHealth.rows[0]).toEqual({ status: "failed", health_state: "degraded" });
    await expect(
      db.query(
        "insert into public.growth_search_console_connection(id,property,lifecycle_state,health_state,scopes,ciphertext,nonce,authentication_tag,key_version) values('auterim','https://example.com','connected','healthy',array[]::text[],'c','n','t',1)",
      ),
    ).rejects.toBeTruthy();
    const secured = await db.query<{ table_name: string; relrowsecurity: boolean }>(
      "select c.relname as table_name,c.relrowsecurity from pg_class c where c.oid=any($1::regclass[])",
      [tables.map((table) => `public.${table}`)],
    );
    expect(secured.rows).toHaveLength(tables.length);
    expect(secured.rows.every((row) => row.relrowsecurity)).toBe(true);
    await db.exec("reset role");
  });

  it("only persists evidence excerpts that match public classified evidence and deduplicates retries", async () => {
    const available = await db.query<{
      change_id: string;
      source_id: string;
      classification_id: string;
      provider_slug: string;
      category: string;
      source_url: string;
      evidence: { type: "added" | "removed" | "changed"; excerpt: string }[];
      affected_entities: string[];
      confidence: number;
    }>(`
      select change.id as change_id,source.id as source_id,classification.id as classification_id,
        provider.slug as provider_slug,classification.category,source.url as source_url,
        classification.evidence,classification.affected_entities,classification.confidence
      from public.source_change_classifications classification
      join public.source_changes change on change.id=classification.change_id
      join public.source_catalog source on source.id=change.source_id and source.enabled
      join public.dependency_catalog provider on provider.id=source.dependency_id and provider.enabled
      where classification.status='classified' and classification.material
        and jsonb_array_length(classification.evidence)>0
      order by classification.classified_at desc,classification.id desc limit 1
    `);
    expect(available.rows).toHaveLength(1);
    const sample = available.rows[0]!;
    const firstEvidence = sample.evidence[0]!;
    const entity = `evidence-${sample.change_id.slice(0, 8)}`;
    const payload = {
      providerSlug: sample.provider_slug,
      topicKey: sample.category,
      entityKey: entity,
      topicLabel: `${sample.provider_slug} verified public evidence`,
      canonicalSlug: `verified-evidence-${sample.change_id.slice(0, 12)}`,
      sourceChangeId: sample.change_id,
      classificationId: sample.classification_id,
      evaluatorVersion: "growth-test-v1",
      packetSchemaVersion: 1,
      policyVersion: "growth-test-policy-v1",
      evidenceFingerprint: "a".repeat(64),
      decision: "HUB_UPDATE",
      status: "candidate",
      recommendedSurface: "PROVIDER_HUB",
      publicationReady: true,
      indexable: false,
      headline: "A verified provider update",
      publicSummary:
        "A material public provider update is retained for its evidence-backed provider hub.",
      generalImpact:
        "Applications relying on this provider should review the authoritative published requirements.",
      affectedPublicEntities: sample.affected_entities,
      reasons: ["material_change"],
      blockers: [],
      factors: { evidenceQuality: "authoritative" },
      confidence: sample.confidence,
      freshness: "current",
      announcedAt: null,
      effectiveAt: null,
      publicSafetyVersion: "public-safety-test-v1",
      distributionTypes: [],
      suggestedAngle: "Review the public provider update and its source evidence.",
      safeClaimBoundaries: ["public_provider_evidence_only"],
      freeToolType: null,
      ctaTypes: ["CHECK_MY_STACK"],
      evidence: [
        {
          sourceId: sample.source_id,
          sourceChangeId: sample.change_id,
          classificationId: sample.classification_id,
          sourceUrl: sample.source_url,
          type: firstEvidence.type,
          excerpt: firstEvidence.excerpt,
        },
      ],
    };
    await db.exec("set role service_role");
    await expect(
      db.query("select public.record_growth_evaluation($1::jsonb)", [
        JSON.stringify({
          ...payload,
          evidence: [
            {
              ...payload.evidence[0],
              excerpt: "invented excerpt not present in the classifier evidence",
            },
          ],
        }),
      ]),
    ).rejects.toBeTruthy();
    const first = await db.query<{ value: { opportunityId: string; evaluationId: string } }>(
      "select public.record_growth_evaluation($1::jsonb) as value",
      [JSON.stringify(payload)],
    );
    const retry = await db.query<{ value: { opportunityId: string; evaluationId: string } }>(
      "select public.record_growth_evaluation($1::jsonb) as value",
      [JSON.stringify(payload)],
    );
    expect(retry.rows[0]!.value).toMatchObject({
      opportunityId: first.rows[0]!.value.opportunityId,
      evaluationId: first.rows[0]!.value.evaluationId,
    });
    const counts = await db.query<{
      topics: number;
      opportunities: number;
      evaluations: number;
      evidence: number;
    }>(
      `select
        (select count(*)::int from public.growth_topics where canonical_slug=$1) topics,
        (select count(*)::int from public.growth_opportunities where id=$2::uuid) opportunities,
        (select count(*)::int from public.growth_opportunity_evaluations where id=$3::uuid) evaluations,
        (select count(*)::int from public.growth_opportunity_evidence where opportunity_id=$2::uuid) evidence`,
      [
        payload.canonicalSlug,
        first.rows[0]!.value.opportunityId,
        first.rows[0]!.value.evaluationId,
      ],
    );
    expect(counts.rows[0]).toEqual({ topics: 1, opportunities: 1, evaluations: 1, evidence: 1 });
    await db.exec("reset role");
  });
});
