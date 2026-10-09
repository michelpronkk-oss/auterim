import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
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
const growthClaimAmbiguityMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261112000000_growth_claim_attempts_ambiguity_fix.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const baselineDispatchRecoveryMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261110000000_baseline_dispatch_recovery_openai_pricing_source.sql",
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
const onboardingFunnelEventsMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261118000000_m155_onboarding_funnel_events.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const protectionDependencyDetailMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261020000000_m15_production_hardening.sql", import.meta.url),
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
const companySurfaceMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261004144308_company_surface_discovery.sql", import.meta.url),
  ),
  "utf8",
);
const companySurfaceFinalizeMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261014000000_company_surface_discovery_finalize.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const technologyObservationMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261015000000_technology_observation_registry.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const technologyObservationReasonCodesMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261016000000_technology_observation_reason_codes.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const completeTechnologyFingerprintMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261017000000_complete_technology_fingerprint_model.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const protectedProductMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261021000000_m15_protected_product_entitlements.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const productScopedDependencyMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261022000000_m15_product_scoped_dependencies_and_idempotency.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const persistedMoneyPathMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261023000000_m15_persisted_money_path.sql", import.meta.url),
  ),
  "utf8",
);
const phase4cCorrectnessMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261023100000_m15_phase4c_retry_and_quota_fixes.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const dependencyLifecycleMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261024020000_m15_dependency_lifecycle.sql", import.meta.url),
  ),
  "utf8",
);
const businessHandoffMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261024030000_m15_business_handoff_preparation.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const staleWorkerExecutionMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261025000000_m15_stale_worker_execution_guards.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const completionTimeStaleStateMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261108000000_m15_completion_time_stale_state_guards.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const preflightWorkerRpcAclMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261109000000_m15_preflight_worker_rpc_acl_hardening.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const productRepositoryProtectionMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261113000000_m15_product_repository_protection.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const productScopedWorkerGuardsMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261114000000_m15_product_scoped_worker_repository_guards.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const deterministicLegacyRepositoryAttributionMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261115000000_m15_deterministic_legacy_repository_attribution.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const legacyAttributionQuotaConsistencyMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261116000000_m15_legacy_attribution_quota_consistency.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const onboardingV2Migration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261117000000_m155_onboarding_v2.sql", import.meta.url),
  ),
  "utf8",
);
const workspaceMemberManagementMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261119000000_m155_workspace_member_management.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const cliProductDiscoveryMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261120000000_m156_cli_product_discovery.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const cliDraftProductOnboardingMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261121000000_m156_cli_draft_product_onboarding.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const deploymentSurfacesMigration = await readFile(
  fileURLToPath(
    new URL("../supabase/migrations/20261122000000_m157_deployment_surfaces.sql", import.meta.url),
  ),
  "utf8",
);
const deploymentGrantHardeningMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261123000000_m157_deployment_client_grant_hardening.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

async function makeDatabase(
  applyCompanySurfaceMigration = true,
  applyProductRepositoryProtectionMigration = true,
) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create schema extensions;
    create extension pgcrypto with schema extensions;
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
  if (applyCompanySurfaceMigration) await db.exec(companySurfaceMigration);
  await db.exec(preflightMigration);
  await db.exec(preflightPrivilegeMigration);
  await db.exec(billingMigration);
  await db.exec(protectionMigration);
  await db.exec(growthMigration);
  await db.exec(growthBoundsMigration);
  await db.exec(growthClaimAmbiguityMigration);
  await db.exec(baselineDispatchRecoveryMigration);
  await db.exec(connectorMigration);
  await db.exec(growthFeedbackMigration);
  await db.exec(growthSearchConsoleScopeMigration);
  await db.exec(partialDiscoveryMigration);
  await db.exec(discoveryOutcomeConsistencyMigration);
  await db.exec(runtimeDiscoveryMigration);
  await db.exec(onboardingWorkspaceIdempotencyMigration);
  if (applyCompanySurfaceMigration) {
    await db.exec(companySurfaceFinalizeMigration);
    await db.exec(technologyObservationMigration);
    await db.exec(technologyObservationReasonCodesMigration);
    await db.exec(completeTechnologyFingerprintMigration);
  }
  await db.exec(protectionDependencyDetailMigration);
  await db.exec(protectedProductMigration);
  await db.exec(productScopedDependencyMigration);
  await db.exec(persistedMoneyPathMigration);
  await db.exec(phase4cCorrectnessMigration);
  await db.exec(dependencyLifecycleMigration);
  await db.exec(businessHandoffMigration);
  await db.exec(staleWorkerExecutionMigration);
  await db.exec(completionTimeStaleStateMigration);
  await db.exec(preflightWorkerRpcAclMigration);
  if (applyProductRepositoryProtectionMigration)
    await db.exec(productRepositoryProtectionMigration);
  if (applyProductRepositoryProtectionMigration) await db.exec(productScopedWorkerGuardsMigration);
  if (applyProductRepositoryProtectionMigration)
    await db.exec(deterministicLegacyRepositoryAttributionMigration);
  if (applyProductRepositoryProtectionMigration)
    await db.exec(legacyAttributionQuotaConsistencyMigration);
  if (applyProductRepositoryProtectionMigration) await db.exec(onboardingV2Migration);
  if (applyProductRepositoryProtectionMigration) await db.exec(workspaceMemberManagementMigration);
  await db.exec(onboardingFunnelEventsMigration);
  await db.exec(cliProductDiscoveryMigration);
  await db.exec(cliDraftProductOnboardingMigration);
  if (applyProductRepositoryProtectionMigration) {
    // Model the broad inherited grants in Supabase's default public-schema setup.
    await db.exec("alter default privileges in schema public grant all on tables to authenticated");
    await db.exec(deploymentSurfacesMigration);
    await db.exec(deploymentGrantHardeningMigration);
  }
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
  it("accepts one-time onboarding Growth events and keeps their keys opaque and idempotent", async () => {
    const db = await makeDatabase();
    const events = [
      "product_selected",
      "dependency_confirmed",
      "protection_graph_viewed",
      "first_grounded_value",
    ];
    for (const [index, eventType] of events.entries()) {
      const eventKey = (index + 1).toString(16).padStart(64, "0");
      await db.query(
        `insert into public.growth_first_party_events(event_key,event_type,event_source)
         values($1,$2,'server') on conflict(event_key) do nothing`,
        [eventKey, eventType],
      );
      await db.query(
        `insert into public.growth_first_party_events(event_key,event_type,event_source)
         values($1,$2,'server') on conflict(event_key) do nothing`,
        [eventKey, eventType],
      );
    }
    const rows = await db.query<{ count: number; distinct_events: number }>(
      `select count(*)::int as count,count(distinct event_type)::int as distinct_events
       from public.growth_first_party_events where event_type=any($1::text[])`,
      [events],
    );
    expect(rows.rows[0]).toEqual({ count: 4, distinct_events: 4 });
    const columns = await db.query<{ has_tenant_payload: boolean }>(
      `select exists(select 1 from information_schema.columns
       where table_schema='public' and table_name='growth_first_party_events'
         and column_name in ('workspace_id','product_id','metadata','payload')) as has_tenant_payload`,
    );
    expect(columns.rows[0]!.has_tenant_payload).toBe(false);
    await db.close();
  });

  it("backfills existing discovery evidence before validating surface provenance", async () => {
    const db = await makeDatabase(false);
    const userId = "11111111-1111-4111-8111-111111111111";
    const workspaceId = "22222222-2222-4222-8222-222222222222";
    const companyId = "33333333-3333-4333-8333-333333333333";
    await db.query("insert into auth.users(id) values ($1)", [userId]);
    await db.query(
      "insert into public.workspaces(id,name,created_by) values ($1,'Old workspace',$2)",
      [workspaceId, userId],
    );
    await db.query(
      "insert into public.companies(id,workspace_id,name,slug) values ($1,$2,'Old company','old-company')",
      [companyId, workspaceId],
    );
    const run = await db.query<{ id: string }>(
      `insert into public.dependency_discovery_runs (
        workspace_id,company_id,website_url,trigger_run_id,attempt_number
      ) values ($1,$2,'https://old-company.example/','pre-surface-run',1) returning id`,
      [workspaceId, companyId],
    );
    await db.query(
      `insert into public.dependency_discovery_evidence (
        workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin
      ) values ($1,$2,'stripe','old-stripe-sdk','script_host','strong','https://api.stripe.com')`,
      [workspaceId, run.rows[0]!.id],
    );
    await db.query(
      `insert into public.dependency_discovery_evidence (
        workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin
      ) values ($1,$2,'stripe','old-stripe-ipv6','script_host','strong','https://[2606:4700:4700::1111]')`,
      [workspaceId, run.rows[0]!.id],
    );

    await db.exec(companySurfaceMigration);
    await db.exec(companySurfaceFinalizeMigration);
    await db.exec(technologyObservationMigration);
    await db.exec(technologyObservationReasonCodesMigration);
    await db.exec(completeTechnologyFingerprintMigration);
    const backfilled = await db.query<{ surface_host: string; surface_type: string }>(
      "select surface_host,surface_type from public.dependency_discovery_evidence where run_id=$1 order by signature_key",
      [run.rows[0]!.id],
    );
    expect(backfilled.rows).toEqual([
      { surface_host: "[2606:4700:4700::1111]", surface_type: "ROOT_MARKETING" },
      { surface_host: "api.stripe.com", surface_type: "ROOT_MARKETING" },
    ]);
    await db.close();
  });

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

  it("stores bounded surface provenance under the existing tenant RLS boundary", async () => {
    const result = await db.query<{
      row_security: boolean;
      surface_type: boolean;
      surface_host: boolean;
    }>(
      `select cls.relrowsecurity as row_security,
        exists(select 1 from information_schema.columns where table_schema='public' and table_name='dependency_discovery_evidence' and column_name='surface_type') as surface_type,
        exists(select 1 from information_schema.columns where table_schema='public' and table_name='dependency_discovery_evidence' and column_name='surface_host') as surface_host
       from pg_class cls where cls.oid='public.dependency_discovery_evidence'::regclass`,
    );
    expect(result.rows[0]).toEqual({ row_security: true, surface_type: true, surface_host: true });
    await expect(
      db.query(
        `insert into public.dependency_discovery_evidence
          (workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin,surface_type,surface_host)
         values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','openai','bad-host','api_endpoint','strong','https://example.com','PRODUCT_APP','https://example.com/path')`,
      ),
    ).rejects.toBeTruthy();
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

  it("adds only existing confirmed accounts through an idempotent owner/admin-only boundary", async () => {
    const membershipDb = await makeDatabase();
    const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondOwner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const admin = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const member = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const target = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const unconfirmed = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await membershipDb.query(
      `insert into auth.users(id,email,email_confirmed_at) values
        ($1,'owner@example.test',now()),($2,'second-owner@example.test',now()),
        ($3,'admin@example.test',now()),($4,'member@example.test',now()),
        ($5,'target@example.test',now()),($6,'unconfirmed@example.test',null)`,
      [owner, secondOwner, admin, member, target, unconfirmed],
    );
    await membershipDb.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await membershipDb.exec("set role authenticated");
    const firstWorkspace = await membershipDb.query<{ id: string }>(
      "select public.create_workspace('Company A') as id",
    );
    await membershipDb.exec("reset role");
    await membershipDb.query("select set_config('request.jwt.claim.sub',$1,false)", [secondOwner]);
    await membershipDb.exec("set role authenticated");
    const secondWorkspace = await membershipDb.query<{ id: string }>(
      "select public.create_workspace('Company B') as id",
    );
    await membershipDb.exec("reset role");
    const companyA = firstWorkspace.rows[0]!.id;
    const companyB = secondWorkspace.rows[0]!.id;
    await membershipDb.query(
      "insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,'admin'),($1,$3,'member')",
      [companyB, admin, member],
    );

    await membershipDb.exec("set role service_role");
    await membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
      companyB,
      secondOwner,
      "TARGET@example.test",
    ]);
    await membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
      companyB,
      secondOwner,
      "target@example.test",
    ]);
    await membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
      companyB,
      admin,
      "target@example.test",
    ]);
    await membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
      companyB,
      secondOwner,
      "unconfirmed@example.test",
    ]);
    await membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
      companyB,
      secondOwner,
      "missing@example.test",
    ]);
    const targetMembership = await membershipDb.query<{ role: string; count: string }>(
      `select min(role) as role, count(*)::text as count from public.workspace_members
       where workspace_id=$1 and user_id=$2`,
      [companyB, target],
    );
    expect(targetMembership.rows[0]).toEqual({ role: "member", count: "1" });
    const ownerMembership = await membershipDb.query<{ role: string; count: string }>(
      `select min(role) as role, count(*)::text as count from public.workspace_members
       where workspace_id=$1 and user_id=$2`,
      [companyB, secondOwner],
    );
    expect(ownerMembership.rows[0]).toEqual({ role: "owner", count: "1" });
    const targetA = await membershipDb.query<{ count: string }>(
      "select count(*)::text as count from public.workspace_members where workspace_id=$1 and user_id=$2",
      [companyA, target],
    );
    expect(targetA.rows[0]!.count).toBe("0");
    const roster = await membershipDb.query<{ email: string; role: string }>(
      "select email,role from public.list_workspace_members_for_admin($1,$2)",
      [companyB, secondOwner],
    );
    expect(roster.rows).toContainEqual({ email: "target@example.test", role: "member" });
    await expect(
      membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
        companyB,
        member,
        "another@example.test",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
        companyB,
        secondOwner,
        "owner@example.test",
      ]),
    ).resolves.toBeTruthy();
    await expect(
      membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
        companyA,
        secondOwner,
        "target@example.test",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await membershipDb.exec("reset role; set role authenticated");
    await membershipDb.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await expect(
      membershipDb.query("select public.add_existing_workspace_member($1,$2,$3)", [
        companyB,
        owner,
        "target@example.test",
      ]),
    ).rejects.toBeTruthy();
    await membershipDb.exec("reset role; set role anon");
    await expect(
      membershipDb.query("select * from public.list_workspace_members_for_admin($1,$2)", [
        companyB,
        secondOwner,
      ]),
    ).rejects.toBeTruthy();
    await membershipDb.exec("reset role");
    await membershipDb.close();
  });

  it("keeps M15.6 scan history Product-scoped, member-readable, and server-write-only", async () => {
    const cliDb = await makeDatabase();
    const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await cliDb.query("insert into auth.users(id) values($1),($2)", [userA, userB]);
    const expiredRateLimitBucket = "abcdef0123456789".repeat(4);
    await cliDb.query(
      `insert into public.public_rate_limit_buckets(policy,client_fingerprint,window_start,request_count)
       values('cli_poll',$1,now()-interval '3 days',1)`,
      [expiredRateLimitBucket],
    );
    await cliDb.query("select * from public.claim_public_rate_limit('cli_poll',$1,100,300,now())", [
      "1".repeat(64),
    ]);
    expect(
      (
        await cliDb.query(
          "select 1 from public.public_rate_limit_buckets where client_fingerprint=$1",
          [expiredRateLimitBucket],
        )
      ).rows,
    ).toHaveLength(0);
    await cliDb.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await cliDb.exec("set role authenticated");
    const workspaceA = (
      await cliDb.query<{ id: string }>("select public.create_workspace('CLI Tenant A') as id")
    ).rows[0]!.id;
    await cliDb.exec("reset role");
    await cliDb.query("select set_config('request.jwt.claim.sub',$1,false)", [userB]);
    await cliDb.exec("set role authenticated");
    const workspaceB = (
      await cliDb.query<{ id: string }>("select public.create_workspace('CLI Tenant B') as id")
    ).rows[0]!.id;
    await cliDb.exec("reset role");
    const companyId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const productId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await cliDb.query(
      "insert into public.companies(id,workspace_id,name,slug) values($1,$2,'Tenant A','tenant-a')",
      [companyId, workspaceA],
    );
    await cliDb.query(
      "insert into public.workspace_products(id,workspace_id,name,slug,status) values($1,$2,'Product A','product-a','draft')",
      [productId, workspaceA],
    );
    const scanId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await cliDb.query(
      `insert into public.cli_scan_runs(workspace_id,company_id,product_id,scan_id,payload_digest,
      schema_version,scanner_version,registry_version,status,project_name,observation_count)
      values($1,$2,$3,$4,$5,'1.0.0','0.1.0','m15.6-provider-map-1','complete','sample',0)`,
      [workspaceA, companyId, productId, scanId, "a".repeat(64)],
    );

    await cliDb.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await cliDb.exec("set role authenticated");
    expect(
      (await cliDb.query("select id from public.cli_scan_runs where product_id=$1", [productId]))
        .rows,
    ).toHaveLength(1);
    await expect(
      cliDb.query("delete from public.cli_scan_runs where product_id=$1", [productId]),
    ).rejects.toThrow();
    await expect(cliDb.query("select * from private.cli_connect_sessions")).rejects.toThrow();
    await cliDb.exec("reset role");

    await cliDb.query("select set_config('request.jwt.claim.sub',$1,false)", [userB]);
    await cliDb.exec("set role authenticated");
    expect(
      (await cliDb.query("select id from public.cli_scan_runs where product_id=$1", [productId]))
        .rows,
    ).toHaveLength(0);
    await cliDb.exec("reset role; set role anon");
    await expect(cliDb.query("select * from public.cli_observations")).rejects.toThrow();
    await cliDb.exec("reset role");

    await expect(
      cliDb.query(
        `insert into public.cli_scan_runs(workspace_id,company_id,product_id,scan_id,payload_digest,
      schema_version,scanner_version,registry_version,status,project_name,observation_count)
      values($1,$2,$3,$4,$5,'1.0.0','0.1.0','m15.6-provider-map-1','complete','forged',0)`,
        [workspaceB, companyId, productId, "ffffffff-ffff-4fff-8fff-ffffffffffff", "b".repeat(64)],
      ),
    ).rejects.toThrow();
    const policy = await cliDb.query<{ row_security: boolean }>(
      `select c.relrowsecurity as row_security from pg_class c where c.oid='public.cli_observations'::regclass`,
    );
    expect(policy.rows[0]?.row_security).toBe(true);

    await cliDb.query(
      "update public.workspace_products set status='protected',protected_at=now() where id=$1",
      [productId],
    );
    await cliDb.query(
      "insert into public.product_onboarding_progress(workspace_id,product_id,company_id) values($1,$2,$3)",
      [workspaceA, productId, companyId],
    );
    const stripeId = (
      await cliDb.query<{ id: string }>(
        "select id from public.dependency_catalog where slug='stripe'",
      )
    ).rows[0]!.id;
    const confirmedStripeId = (
      await cliDb.query<{ id: string }>(
        `insert into public.workspace_dependencies(workspace_id,protected_product_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
         values($1,$2,$3,$4,'manual',true,now()) returning id`,
        [workspaceA, productId, stripeId, userA],
      )
    ).rows[0]!.id;
    await cliDb.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await cliDb.exec("set role authenticated");
    const coverage = await cliDb.query<{ provider_id: string; enabled_source_count: bigint }>(
      "select * from public.get_cli_product_provider_coverage($1,$2,array[$3]::uuid[])",
      [workspaceA, productId, stripeId],
    );
    expect(coverage.rows).toHaveLength(1);
    expect(Number(coverage.rows[0]?.enabled_source_count)).toBeGreaterThanOrEqual(0);
    await expect(
      cliDb.query(
        "select * from public.get_cli_product_provider_coverage($1,$2,array[$3]::uuid[])",
        [workspaceB, productId, stripeId],
      ),
    ).rejects.toThrow();
    await expect(
      cliDb.query("select * from public.get_cli_product_provider_coverage($1,$2,$3::uuid[])", [
        workspaceA,
        productId,
        Array.from({ length: 501 }, () => stripeId),
      ]),
    ).rejects.toThrow();
    await cliDb.exec("reset role");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const userCodeHash = "1".repeat(64);
    const pollHash = "2".repeat(64);
    const credentialHash = "3".repeat(64);
    await cliDb.query("select * from public.create_cli_connect_session($1,$2,$3,$4)", [
      sessionId,
      userCodeHash,
      pollHash,
      credentialHash,
    ]);
    await expect(
      cliDb.query("select * from public.approve_cli_connect_session($1,$2,$3,$4,$5)", [
        userCodeHash,
        userB,
        workspaceB,
        companyId,
        productId,
      ]),
    ).rejects.toThrow();
    const approved = await cliDb.query<{ state: string }>(
      "select state from public.approve_cli_connect_session($1,$2,$3,$4,$5)",
      [userCodeHash, userA, workspaceA, companyId, productId],
    );
    expect(approved.rows[0]?.state).toBe("approved");
    await expect(
      cliDb.query("select * from public.redeem_cli_connect_session($1,$2)", [
        sessionId,
        "f".repeat(64),
      ]),
    ).rejects.toThrow();
    const redeemed = await cliDb.query<{ state: string; credential_hash: string | null }>(
      "select state,credential_hash from public.redeem_cli_connect_session($1,$2)",
      [sessionId, pollHash],
    );
    expect(redeemed.rows[0]).toEqual({ state: "approved", credential_hash: credentialHash });
    const replayed = await cliDb.query<{ state: string; credential_hash: string | null }>(
      "select state,credential_hash from public.redeem_cli_connect_session($1,$2)",
      [sessionId, pollHash],
    );
    expect(replayed.rows[0]).toEqual({ state: "redeemed", credential_hash: null });
    const payload = {
      schemaVersion: "1.0.0",
      scannerVersion: "0.1.0",
      registryVersion: "m15.6-provider-map-1",
      scanId: "22222222-2222-4222-8222-222222222222",
      status: "complete",
      projectSummary: { rootName: "sample", git: {} },
      stats: { totalBytesRead: 32, observations: 2, truncated: false },
      observations: [
        {
          id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          evidenceFamily: "package_manifest",
          normalizedIdentifier: "stripe",
          reasonCode: "known_package_provider",
          confidence: 0.9,
          safeRelativePath: "package.json",
          subproject: null,
          metadata: {},
        },
        {
          id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          evidenceFamily: "package_manifest",
          normalizedIdentifier: "@example/private-sdk",
          reasonCode: "unmapped_package",
          confidence: 0.5,
          safeRelativePath: "package.json",
          subproject: null,
          metadata: {},
        },
      ],
    };
    const draftProductId = "77777777-7777-4777-8777-777777777777";
    await cliDb.query(
      "insert into public.workspace_products(id,workspace_id,name,slug,status) values($1,$2,'Draft Product','draft-product','draft')",
      [draftProductId, workspaceA],
    );
    await cliDb.query(
      "insert into public.product_onboarding_progress(workspace_id,product_id,company_id,created_by) values($1,$2,$3,$4)",
      [workspaceA, draftProductId, companyId, userA],
    );
    await cliDb.query(
      "insert into public.workspace_onboarding(workspace_id,company_id,state) values($1,$2,'company_created') on conflict (workspace_id) do nothing",
      [workspaceA, companyId],
    );
    const draftSessionId = "88888888-8888-4888-8888-888888888888";
    const draftUserCodeHash = "d".repeat(64);
    const draftPollHash = "e".repeat(64);
    const draftCredentialHash = "f".repeat(64);
    await cliDb.query("select * from public.create_cli_connect_session($1,$2,$3,$4)", [
      draftSessionId,
      draftUserCodeHash,
      draftPollHash,
      draftCredentialHash,
    ]);
    expect(
      (
        await cliDb.query(
          `select 1 from public.workspace_products p
           join public.product_onboarding_progress o on o.product_id=p.id and o.workspace_id=p.workspace_id
           join public.workspace_members m on m.workspace_id=p.workspace_id
           where p.id=$1 and p.status='draft' and o.company_id=$2 and m.user_id=$3 and m.role='owner'`,
          [draftProductId, companyId, userA],
        )
      ).rows,
    ).toHaveLength(1);
    const draftApproval = await cliDb.query<{ state: string }>(
      "select state from public.approve_cli_connect_session($1,$2,$3,$4,$5)",
      [draftUserCodeHash, userA, workspaceA, companyId, draftProductId],
    );
    expect(draftApproval.rows[0]?.state).toBe("approved");
    await cliDb.query("select * from public.redeem_cli_connect_session($1,$2)", [
      draftSessionId,
      draftPollHash,
    ]);
    const draftPayload = {
      ...payload,
      scanId: "99999999-9999-4999-8999-999999999998",
      observations: [payload.observations[0]!],
      stats: { ...payload.stats, observations: 1 },
    };
    const draftProviderMatch = JSON.stringify([
      { observationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dependencyId: stripeId },
    ]);
    const draftIngestion = await cliDb.query<{ result: Record<string, unknown> }>(
      "select public.ingest_cli_discovery($1,$2,$3::jsonb,$4::jsonb) as result",
      [draftCredentialHash, "c".repeat(64), JSON.stringify(draftPayload), draftProviderMatch],
    );
    expect(draftIngestion.rows[0]?.result).toMatchObject({
      scanId: draftPayload.scanId,
      idempotent: false,
      observations: 1,
    });
    expect(
      (
        await cliDb.query<{ status: string }>(
          "select status from public.workspace_products where id=$1",
          [draftProductId],
        )
      ).rows[0]?.status,
    ).toBe("draft");
    expect(
      (
        await cliDb.query(
          "select state,activated_at from public.workspace_onboarding where workspace_id=$1",
          [workspaceA],
        )
      ).rows[0],
    ).toEqual({ state: "company_created", activated_at: null });
    expect(
      (
        await cliDb.query(
          "select id from public.workspace_dependencies where protected_product_id=$1",
          [draftProductId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await cliDb.query(
          `select provider_state,provider_id,workspace_dependency_id
             from public.cli_observations
            where product_id=$1 and normalized_identifier='stripe'`,
          [draftProductId],
        )
      ).rows,
    ).toEqual([{ provider_state: "known", provider_id: stripeId, workspace_dependency_id: null }]);

    const providerMatches = JSON.stringify([
      { observationId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dependencyId: stripeId },
    ]);
    const ingested = await cliDb.query<{ result: Record<string, unknown> }>(
      "select public.ingest_cli_discovery($1,$2,$3::jsonb,$4::jsonb) as result",
      [credentialHash, "a".repeat(64), JSON.stringify(payload), providerMatches],
    );
    expect(ingested.rows[0]?.result).toMatchObject({
      scanId: payload.scanId,
      idempotent: false,
      observations: 2,
    });
    const retried = await cliDb.query<{ result: Record<string, unknown> }>(
      "select public.ingest_cli_discovery($1,$2,$3::jsonb,$4::jsonb) as result",
      [credentialHash, "a".repeat(64), JSON.stringify(payload), providerMatches],
    );
    expect(retried.rows[0]?.result).toMatchObject({ scanId: payload.scanId, idempotent: true });
    await expect(
      cliDb.query("select public.ingest_cli_discovery($1,$2,$3::jsonb,$4::jsonb)", [
        credentialHash,
        "b".repeat(64),
        JSON.stringify(payload),
        providerMatches,
      ]),
    ).rejects.toThrow();
    expect(
      (await cliDb.query("select id from public.cli_scan_runs where product_id=$1", [productId]))
        .rows,
    ).toHaveLength(2);

    const storedCliObservations = await cliDb.query<{
      normalized_identifier: string;
      provider_state: string;
      provider_id: string | null;
      workspace_dependency_id: string | null;
    }>(
      "select normalized_identifier,provider_state,provider_id,workspace_dependency_id from public.cli_observations where product_id=$1 order by normalized_identifier",
      [productId],
    );
    expect(storedCliObservations.rows).toEqual([
      {
        normalized_identifier: "@example/private-sdk",
        provider_state: "unknown",
        provider_id: null,
        workspace_dependency_id: null,
      },
      {
        normalized_identifier: "stripe",
        provider_state: "known",
        provider_id: stripeId,
        workspace_dependency_id: confirmedStripeId,
      },
    ]);
    expect(
      (
        await cliDb.query(
          "select id from public.workspace_dependencies where protected_product_id=$1",
          [productId],
        )
      ).rows,
    ).toHaveLength(1);

    const secondSessionId = "33333333-3333-4333-8333-333333333333";
    const secondCodeHash = "4".repeat(64);
    const secondPollHash = "5".repeat(64);
    const secondCredentialHash = "6".repeat(64);
    await cliDb.query("select * from public.create_cli_connect_session($1,$2,$3,$4)", [
      secondSessionId,
      secondCodeHash,
      secondPollHash,
      secondCredentialHash,
    ]);
    await cliDb.query("select * from public.approve_cli_connect_session($1,$2,$3,$4,$5)", [
      secondCodeHash,
      userA,
      workspaceA,
      companyId,
      productId,
    ]);
    await cliDb.query("select * from public.redeem_cli_connect_session($1,$2)", [
      secondSessionId,
      secondPollHash,
    ]);
    const secondPayload = {
      ...payload,
      scanId: "44444444-4444-4444-8444-444444444444",
      status: "partial",
      observations: [payload.observations[0]!],
      stats: { ...payload.stats, observations: 1, truncated: true },
    };
    await cliDb.query("select public.ingest_cli_discovery($1,$2,$3::jsonb,$4::jsonb)", [
      secondCredentialHash,
      "d".repeat(64),
      JSON.stringify(secondPayload),
      providerMatches,
    ]);
    expect(
      (
        await cliDb.query(
          "select scan_id from public.cli_scan_runs where product_id=$1 order by received_at,id",
          [productId],
        )
      ).rows,
    ).toHaveLength(3);
    expect(
      (
        await cliDb.query(
          "select id from public.cli_observations where scan_run_id=(select id from public.cli_scan_runs where scan_id=$1)",
          [payload.scanId],
        )
      ).rows,
    ).toHaveLength(2);

    const revokedSessionId = "55555555-5555-4555-8555-555555555555";
    const revokedCodeHash = "7".repeat(64);
    const revokedPollHash = "8".repeat(64);
    const revokedCredentialHash = "9".repeat(64);
    await cliDb.query("select * from public.create_cli_connect_session($1,$2,$3,$4)", [
      revokedSessionId,
      revokedCodeHash,
      revokedPollHash,
      revokedCredentialHash,
    ]);
    await cliDb.query("select * from public.approve_cli_connect_session($1,$2,$3,$4,$5)", [
      revokedCodeHash,
      userA,
      workspaceA,
      companyId,
      productId,
    ]);
    await cliDb.query(
      "update private.cli_connect_sessions set credential_expires_at=now()-interval '1 second' where id=$1",
      [revokedSessionId],
    );
    const expiredCredential = await cliDb.query<{ state: string; credential_hash: string | null }>(
      "select state,credential_hash from public.redeem_cli_connect_session($1,$2)",
      [revokedSessionId, revokedPollHash],
    );
    expect(expiredCredential.rows[0]).toMatchObject({ state: "expired", credential_hash: null });
    const memberRevokedSessionId = "66666666-6666-4666-8666-666666666666";
    const memberRevokedCodeHash = "a".repeat(64);
    const memberRevokedPollHash = "b".repeat(64);
    const memberRevokedCredentialHash = "c".repeat(64);
    await cliDb.query("select * from public.create_cli_connect_session($1,$2,$3,$4)", [
      memberRevokedSessionId,
      memberRevokedCodeHash,
      memberRevokedPollHash,
      memberRevokedCredentialHash,
    ]);
    await cliDb.query("select * from public.approve_cli_connect_session($1,$2,$3,$4,$5)", [
      memberRevokedCodeHash,
      userA,
      workspaceA,
      companyId,
      productId,
    ]);
    await cliDb.query("select * from public.redeem_cli_connect_session($1,$2)", [
      memberRevokedSessionId,
      memberRevokedPollHash,
    ]);
    await cliDb.query("delete from public.workspace_members where workspace_id=$1 and user_id=$2", [
      workspaceA,
      userA,
    ]);
    await expect(
      cliDb.query("select public.ingest_cli_discovery($1,$2,$3::jsonb,$4::jsonb)", [
        memberRevokedCredentialHash,
        "f".repeat(64),
        JSON.stringify({ ...payload, scanId: "99999999-9999-4999-8999-999999999999" }),
        "[]",
      ]),
    ).rejects.toThrow();
    await cliDb.query("update public.workspaces set created_by=$1 where id=$2", [
      userB,
      workspaceA,
    ]);
    await cliDb.query(
      "update public.workspace_dependencies set selected_by=$1 where workspace_id=$2",
      [userB, workspaceA],
    );
    await expect(cliDb.query("delete from auth.users where id=$1", [userA])).resolves.toBeDefined();

    await cliDb.close();
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
    await m7db.query(
      "update public.workspace_products set status='protected',protected_at=now() where workspace_id=$1 and is_default",
      [workspaceId],
    );
    const proRepositoryLimit = await m7db.query<{ limit: number }>(
      "select private.workspace_repository_limit($1) as limit",
      [workspaceId],
    );
    expect(proRepositoryLimit.rows[0]!.limit).toBe(5);
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
    expect(
      (
        await m7db.query<{ protected_product_id: string; status: string }>(
          "select protected_product_id,status from public.workspace_product_repositories where repository_id=$1",
          [repository.rows[0]!.id],
        )
      ).rows,
    ).toEqual([
      {
        protected_product_id: (
          await m7db.query<{ protected_product_id: string }>(
            "select protected_product_id from public.workspace_dependencies where id=$1",
            [workspaceDependency.rows[0]!.id],
          )
        ).rows[0]!.protected_product_id,
        status: "active",
      },
    ]);
    await m7db.exec("reset role");

    await m7db.exec("set role service_role");
    await m7db.query(
      "update public.workspace_subscriptions set plan='business' where workspace_id=$1",
      [workspaceId],
    );
    const businessRepositoryLimit = await m7db.query<{ limit: number }>(
      "select private.workspace_repository_limit($1) as limit",
      [workspaceId],
    );
    expect(businessRepositoryLimit.rows[0]!.limit).toBe(25);
    await m7db.query("update public.workspace_subscriptions set plan='pro' where workspace_id=$1", [
      workspaceId,
    ]);
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

  it("maps repositories to products with distinct workspace quota and tenant-safe RPCs", async () => {
    const db = await makeDatabase();
    const owner = "10101010-1010-4010-8010-101010101010";
    const member = "20202020-2020-4020-8020-202020202020";
    const outsider = "30303030-3030-4030-8030-303030303030";
    await db.query("insert into auth.users(id) values($1),($2),($3)", [owner, member, outsider]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.exec("set role authenticated");
    const created = await db.query<{ id: string }>(
      "select public.create_workspace('Product mapping tenant') as id",
    );
    const workspaceId = created.rows[0]!.id;
    await db.exec("reset role; set role service_role");
    await db.query(
      `insert into public.workspace_subscriptions(workspace_id,plan,status,current_period_start,current_period_end)
       values($1,'pro','active',now(),now()+interval '30 days')`,
      [workspaceId],
    );
    const productA = (
      await db.query<{ id: string }>(
        "select id from public.workspace_products where workspace_id=$1 and is_default",
        [workspaceId],
      )
    ).rows[0]!.id;
    const productB = (
      await db.query<{ id: string }>(
        `insert into public.workspace_products(workspace_id,name,slug,status,created_by)
       values($1,'Second product','second-product','draft',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    await db.query(
      "update public.workspace_products set status='protected',protected_at=now() where id=any($1::uuid[])",
      [[productA, productB]],
    );
    await db.query(
      "insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,'member')",
      [workspaceId, member],
    );
    const connectionId = (
      await db.query<{ id: string }>(
        `insert into public.repository_connections(workspace_id,installation_id,account_login,connected_by)
       values($1,9101,'qa-account',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    const repositoryIds: string[] = [];
    for (let index = 0; index < 26; index += 1) {
      repositoryIds.push(
        (
          await db.query<{ id: string }>(
            `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch)
         values($1,$2,$3,'qa-account',$4,'main') returning id`,
            [workspaceId, connectionId, 9102 + index, `repo-${index}`],
          )
        ).rows[0]!.id,
      );
    }
    await db.exec("reset role");

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
    await db.exec("set role authenticated");
    const otherWorkspace = await db.query<{ id: string }>(
      "select public.create_workspace('Other tenant') as id",
    );
    const otherWorkspaceId = otherWorkspace.rows[0]!.id;
    await db.exec("reset role; set role service_role");
    await db.query(
      `insert into public.workspace_subscriptions(workspace_id,plan,status,current_period_start,current_period_end)
       values($1,'core','active',now(),now()+interval '30 days')`,
      [otherWorkspaceId],
    );
    const otherProductId = (
      await db.query<{ id: string }>(
        "select id from public.workspace_products where workspace_id=$1 and is_default",
        [otherWorkspaceId],
      )
    ).rows[0]!.id;
    await db.query(
      "update public.workspace_products set status='protected',protected_at=now() where id=$1",
      [otherProductId],
    );
    const otherConnectionId = (
      await db.query<{ id: string }>(
        `insert into public.repository_connections(workspace_id,installation_id,account_login,connected_by)
       values($1,9201,'other-account',$2) returning id`,
        [otherWorkspaceId, outsider],
      )
    ).rows[0]!.id;
    const otherRepositoryId = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch)
       values($1,$2,9202,'other-account','other-repo','main') returning id`,
        [otherWorkspaceId, otherConnectionId],
      )
    ).rows[0]!.id;
    await db.exec("reset role");

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.exec("set role authenticated");
    expect(
      (await db.query("select id from public.repositories where id=$1", [repositoryIds[0]])).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "select id from public.workspace_product_repositories where workspace_id=$1",
          [workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await db.query<{ selected_for_protection: boolean }>(
          "select selected_for_protection from public.repositories where id=$1",
          [repositoryIds[0]],
        )
      ).rows[0]!.selected_for_protection,
    ).toBe(false);
    await expect(
      db.query(
        `insert into public.workspace_product_repositories(workspace_id,protected_product_id,repository_id,status,provenance)
         values($1,$2,$3,'active','user_selected')`,
        [workspaceId, productA, repositoryIds[0]],
      ),
    ).rejects.toBeTruthy();

    const mapped = await db.query<{ value: { protectedRepositoryUsage: number } }>(
      "select public.map_repository_to_product($1,$2) as value",
      [productA, repositoryIds[0]],
    );
    expect(mapped.rows[0]!.value.protectedRepositoryUsage).toBe(1);
    await db.exec("reset role; set role service_role");
    await db.query("update public.repositories set selected_for_protection=true where id=$1", [
      repositoryIds[1],
    ]);
    expect(
      (
        await db.query<{ eligible: boolean }>(
          "select private.m15_product_repository_is_current($1,$2,$3) as eligible",
          [workspaceId, productA, repositoryIds[1]],
        )
      ).rows[0]!.eligible,
    ).toBe(false);
    await db.query("update public.repositories set selected_for_protection=false where id=$1", [
      repositoryIds[1],
    ]);
    await db.exec("reset role; set role authenticated");
    const repeated = await db.query<{ value: { protectedRepositoryUsage: number } }>(
      "select public.map_repository_to_product($1,$2) as value",
      [productA, repositoryIds[0]],
    );
    expect(repeated.rows[0]!.value.protectedRepositoryUsage).toBe(1);
    expect(
      (
        await db.query(
          "select id from public.workspace_product_repositories where protected_product_id=$1 and repository_id=$2",
          [productA, repositoryIds[0]],
        )
      ).rows,
    ).toHaveLength(1);
    await db.query("select public.map_repository_to_product($1,$2)", [productB, repositoryIds[0]]);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(distinct repository_id) as count from public.workspace_product_repositories where workspace_id=$1 and status='active'",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(1);
    await db.exec("reset role; set role service_role");
    await db.query("update public.repositories set selected_for_protection=false where id=$1", [
      repositoryIds[0],
    ]);
    await db.exec("reset role; set role authenticated");
    expect(
      (
        await db.query<{ selected_for_protection: boolean }>(
          "select selected_for_protection from public.repositories where id=$1",
          [repositoryIds[0]],
        )
      ).rows[0]!.selected_for_protection,
    ).toBe(true);

    const unmapOne = await db.query<{ value: { protectedRepositoryUsage: number } }>(
      "select public.unmap_repository_from_product($1,$2) as value",
      [productA, repositoryIds[0]],
    );
    expect(unmapOne.rows[0]!.value.protectedRepositoryUsage).toBe(1);
    await db.exec("reset role; set role service_role");
    expect(
      (
        await db.query<{ eligible: boolean }>(
          "select private.m15_product_repository_is_current($1,$2,$3) as eligible",
          [workspaceId, productA, repositoryIds[0]],
        )
      ).rows[0]!.eligible,
    ).toBe(false);
    expect(
      (
        await db.query<{ eligible: boolean }>(
          "select private.m15_product_repository_is_current($1,$2,$3) as eligible",
          [workspaceId, productB, repositoryIds[0]],
        )
      ).rows[0]!.eligible,
    ).toBe(true);
    await db.exec("reset role; set role authenticated");
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.workspace_product_repositories where protected_product_id=$1 and repository_id=$2",
          [productA, repositoryIds[0]],
        )
      ).rows[0]!.status,
    ).toBe("inactive");
    expect(
      (
        await db.query<{ selected_for_protection: boolean }>(
          "select selected_for_protection from public.repositories where id=$1",
          [repositoryIds[0]],
        )
      ).rows[0]!.selected_for_protection,
    ).toBe(true);
    const unmapFinal = await db.query<{ value: { protectedRepositoryUsage: number } }>(
      "select public.unmap_repository_from_product($1,$2) as value",
      [productB, repositoryIds[0]],
    );
    expect(unmapFinal.rows[0]!.value.protectedRepositoryUsage).toBe(0);
    expect(
      (
        await db.query<{ selected_for_protection: boolean }>(
          "select selected_for_protection from public.repositories where id=$1",
          [repositoryIds[0]],
        )
      ).rows[0]!.selected_for_protection,
    ).toBe(false);

    for (let index = 0; index < 5; index += 1)
      await db.query("select public.map_repository_to_product($1,$2)", [
        productA,
        repositoryIds[index],
      ]);
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productA, repositoryIds[5]]),
    ).rejects.toThrow(/repository_quota_exceeded/);
    await db.exec("reset role; set role service_role");
    await db.query(
      "update public.workspace_subscriptions set plan='business' where workspace_id=$1",
      [workspaceId],
    );
    await db.exec("reset role; set role authenticated");
    for (let index = 5; index < 25; index += 1)
      await db.query("select public.map_repository_to_product($1,$2)", [
        productA,
        repositoryIds[index],
      ]);
    await db.exec("reset role; set role service_role");
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(25);
    await db.exec("reset role; set role authenticated");
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productA, repositoryIds[25]]),
    ).rejects.toThrow(/repository_quota_exceeded/);
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [
        otherProductId,
        repositoryIds[0],
      ]),
    ).rejects.toThrow(/repository_not_found/);
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productA, otherRepositoryId]),
    ).rejects.toThrow(/repository_not_found/);
    const secondProductAtLimit = await db.query<{
      map_repository_to_product: { protectedRepositoryUsage: number };
    }>("select public.map_repository_to_product($1,$2)", [productB, repositoryIds[0]]);
    expect(secondProductAtLimit.rows[0]!.map_repository_to_product.protectedRepositoryUsage).toBe(
      25,
    );
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productA, repositoryIds[25]]),
    ).rejects.toThrow(/repository_quota_exceeded/);
    await db.exec("reset role; set role service_role");
    await db.query("update public.repositories set status='access_revoked' where id=$1", [
      repositoryIds[25],
    ]);
    await db.exec("reset role");
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productA, repositoryIds[25]]),
    ).rejects.toThrow(/repository_unavailable/);

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [member]);
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productA, repositoryIds[25]]),
    ).rejects.toThrow(/forbidden/);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [
        otherProductId,
        otherRepositoryId,
      ]),
    ).rejects.toThrow(/repository_plan_required/);
    await db.exec("reset role; set role authenticated");
    expect(
      (
        await db.query(
          "select id from public.workspace_product_repositories where workspace_id=$1",
          [workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (await db.query("select * from public.workspace_product_repositories")).rows,
    ).toHaveLength(0);
    await db.exec("reset role");
    await db.close();
  });

  it("requires unique Product evidence for history-free legacy repository protection and quota", async () => {
    const db = await makeDatabase();
    const owner = "41414141-4141-4141-8141-414141414141";
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.exec("set role authenticated");
    const workspaceId = (
      await db.query<{ id: string }>("select public.create_workspace('Legacy attribution') as id")
    ).rows[0]!.id;
    await db.exec("reset role; set role service_role");
    const productA = (
      await db.query<{ id: string }>(
        "select id from public.workspace_products where workspace_id=$1 and is_default",
        [workspaceId],
      )
    ).rows[0]!.id;
    const productB = (
      await db.query<{ id: string }>(
        `insert into public.workspace_products(workspace_id,name,slug,status,created_by)
         values($1,'Second product','second-product','protected',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    await db.query(
      "update public.workspace_products set status='protected',protected_at=now() where id=$1",
      [productA],
    );
    await db.query(
      `insert into public.workspace_subscriptions(workspace_id,plan,status,current_period_start,current_period_end)
       values($1,'pro','active',now(),now()+interval '30 days')`,
      [workspaceId],
    );
    const providerIds = new Map(
      (
        await db.query<{ id: string; slug: string }>(
          "select id,slug from public.dependency_catalog where slug in ('openai','stripe')",
        )
      ).rows.map((provider) => [provider.slug, provider.id]),
    );
    const dependencyA = (
      await db.query<{ id: string }>(
        `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by,protected_product_id)
         values($1,$2,$3,$4) returning id`,
        [workspaceId, providerIds.get("openai"), owner, productA],
      )
    ).rows[0]!.id;
    const dependencyB = (
      await db.query<{ id: string }>(
        `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by,protected_product_id)
         values($1,$2,$3,$4) returning id`,
        [workspaceId, providerIds.get("stripe"), owner, productB],
      )
    ).rows[0]!.id;
    const connectionId = (
      await db.query<{ id: string }>(
        `insert into public.repository_connections(workspace_id,installation_id,account_login,connected_by)
         values($1,9401,'legacy-account',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    const repositories = await db.query<{ id: string }>(
      `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch,selected_for_protection)
       values($1,$2,9402,'legacy-account','ambiguous','main',true),
             ($1,$2,9403,'legacy-account','single-product','main',true),
             ($1,$2,9404,'legacy-account','unattributed','main',true)
       returning id`,
      [workspaceId, connectionId],
    );
    const [ambiguousRepositoryId, singleProductRepositoryId, unlinkedRepositoryId] =
      repositories.rows.map((repository) => repository.id);
    await db.query(
      `insert into public.workspace_repository_access(workspace_id,workspace_dependency_id,repository_id)
       values($1,$2,$3),($1,$4,$3),($1,$2,$5)`,
      [workspaceId, dependencyA, ambiguousRepositoryId, dependencyB, singleProductRepositoryId],
    );
    const current = async (productId: string, repositoryId: string) =>
      db.query<{ current: boolean }>(
        "select private.m15_product_repository_is_current($1,$2,$3) as current",
        [workspaceId, productId, repositoryId],
      );
    expect((await current(productA, ambiguousRepositoryId)).rows[0]!.current).toBe(false);
    expect((await current(productB, ambiguousRepositoryId)).rows[0]!.current).toBe(false);
    expect((await current(productA, singleProductRepositoryId)).rows[0]!.current).toBe(true);
    expect((await current(productB, singleProductRepositoryId)).rows[0]!.current).toBe(false);
    expect((await current(productA, unlinkedRepositoryId)).rows[0]!.current).toBe(false);
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(1);

    await db.query(
      `insert into public.workspace_product_repositories(workspace_id,protected_product_id,repository_id,status,provenance)
       values($1,$2,$3,'active','user_selected')`,
      [workspaceId, productA, ambiguousRepositoryId],
    );
    await db.query("update public.repositories set selected_for_protection=false where id=$1", [
      ambiguousRepositoryId,
    ]);
    expect((await current(productA, ambiguousRepositoryId)).rows[0]!.current).toBe(true);
    expect((await current(productB, ambiguousRepositoryId)).rows[0]!.current).toBe(false);
    await db.query(
      `insert into public.workspace_product_repositories(workspace_id,protected_product_id,repository_id,status,provenance)
       values($1,$2,$3,'inactive','user_selected')`,
      [workspaceId, productB, singleProductRepositoryId],
    );
    expect((await current(productA, singleProductRepositoryId)).rows[0]!.current).toBe(false);
    expect((await current(productB, singleProductRepositoryId)).rows[0]!.current).toBe(false);
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(1);
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await expect(
      db.query("select public.set_repository_protection($1,true,array[$2::uuid,$3::uuid])", [
        ambiguousRepositoryId,
        dependencyA,
        dependencyB,
      ]),
    ).rejects.toThrow(/product_scoped_repository_mapping_required/);

    const legacyDefaultProductSelection = await db.query<{
      value: { productCount: number; selectedForProtection: boolean };
    }>("select public.set_repository_protection($1,true,array[$2::uuid]) as value", [
      singleProductRepositoryId,
      dependencyA,
    ]);
    expect(legacyDefaultProductSelection.rows[0]!.value).toMatchObject({
      productCount: 1,
      selectedForProtection: true,
    });
    await db.exec("reset role; set role service_role");
    expect((await current(productA, singleProductRepositoryId)).rows[0]!.current).toBe(true);
    expect((await current(productB, singleProductRepositoryId)).rows[0]!.current).toBe(false);
    expect(
      (
        await db.query<{ current: boolean }>(
          "select private.m15_product_repository_is_current($1,$2,$3) as current",
          ["ffffffff-ffff-4fff-8fff-ffffffffffff", productA, singleProductRepositoryId],
        )
      ).rows[0]!.current,
    ).toBe(false);

    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.query("select public.unmap_repository_from_product($1,$2)", [
      productA,
      ambiguousRepositoryId,
    ]);
    await db.exec("reset role; set role service_role");
    const quotaRepositories = await db.query<{ id: string }>(
      `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch,selected_for_protection)
       values($1,$2,9405,'legacy-account','mapped-quota-1','main',true),
             ($1,$2,9406,'legacy-account','mapped-quota-2','main',true),
             ($1,$2,9407,'legacy-account','mapped-quota-3','main',true)
       returning id`,
      [workspaceId, connectionId],
    );
    for (const repository of quotaRepositories.rows) {
      await db.query(
        `insert into public.workspace_product_repositories(
           workspace_id,protected_product_id,repository_id,status,provenance
         ) values($1,$2,$3,'active','user_selected')`,
        [workspaceId, productA, repository.id],
      );
    }
    const quotaTargetRepositoryId = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch)
         values($1,$2,9408,'legacy-account','quota-target','main') returning id`,
        [workspaceId, connectionId],
      )
    ).rows[0]!.id;
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(4);
    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    const belowLimitSelection = await db.query<{ value: { productCount: number } }>(
      "select public.set_repository_protection($1,true,array[$2::uuid]) as value",
      [quotaTargetRepositoryId, dependencyA],
    );
    expect(belowLimitSelection.rows[0]!.value.productCount).toBe(1);
    await db.exec("reset role; set role service_role");
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(5);
    await db.close();
  });

  it("releases archived product repository quota without deleting history", async () => {
    const db = await makeDatabase();
    const owner = "54545454-5454-4454-8454-545454545454";
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.exec("set role authenticated");
    const created = await db.query<{ id: string }>(
      "select public.create_workspace('Archive quota tenant') as id",
    );
    const workspaceId = created.rows[0]!.id;
    await db.exec("reset role; set role service_role");
    await db.query(
      `insert into public.workspace_subscriptions(workspace_id,plan,status,current_period_start,current_period_end)
       values($1,'pro','active',now(),now()+interval '30 days')`,
      [workspaceId],
    );
    const productA = (
      await db.query<{ id: string }>(
        "select id from public.workspace_products where workspace_id=$1 and is_default",
        [workspaceId],
      )
    ).rows[0]!.id;
    const productB = (
      await db.query<{ id: string }>(
        `insert into public.workspace_products(workspace_id,name,slug,status,created_by)
         values($1,'Archive candidate','archive-candidate','draft',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    const draftProduct = (
      await db.query<{ id: string }>(
        `insert into public.workspace_products(workspace_id,name,slug,status,created_by)
         values($1,'Inactive draft','inactive-draft','draft',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    await db.query(
      "update public.workspace_products set status='protected',protected_at=now() where id=any($1::uuid[])",
      [[productA, productB]],
    );
    const connectionId = (
      await db.query<{ id: string }>(
        `insert into public.repository_connections(workspace_id,installation_id,account_login,connected_by)
         values($1,9401,'archive-qa',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    const repositoryIds = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch)
         values($1,$2,9402,'archive-qa','shared','main'),($1,$2,9403,'archive-qa','archive-only','main') returning id`,
        [workspaceId, connectionId],
      )
    ).rows.map((repository) => repository.id);
    await db.exec("reset role; set role authenticated");

    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [draftProduct, repositoryIds[0]]),
    ).rejects.toThrow(/product_not_available/);
    await db.query("select public.map_repository_to_product($1,$2)", [productA, repositoryIds[0]]);
    await db.query("select public.map_repository_to_product($1,$2)", [productB, repositoryIds[0]]);
    await db.query("select public.map_repository_to_product($1,$2)", [productB, repositoryIds[1]]);
    await db.exec("reset role; set role service_role");
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(2);
    await db.exec("reset role; set role authenticated");

    const archived = await db.query<{ archive_workspace_product: { status: string } }>(
      "select public.archive_workspace_product($1,$2)",
      [workspaceId, productB],
    );
    expect(archived.rows[0]!.archive_workspace_product.status).toBe("archived");
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.workspace_product_repositories where protected_product_id=$1 order by repository_id",
          [productB],
        )
      ).rows,
    ).toEqual([{ status: "inactive" }, { status: "inactive" }]);
    expect(
      (
        await db.query<{ selected_for_protection: boolean }>(
          "select selected_for_protection from public.repositories where id=any($1::uuid[]) order by name",
          [repositoryIds],
        )
      ).rows,
    ).toEqual([{ selected_for_protection: false }, { selected_for_protection: true }]);
    await db.exec("reset role; set role service_role");
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(1);
    await db.exec("reset role; set role authenticated");
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productB, repositoryIds[1]]),
    ).rejects.toThrow(/product_not_available/);

    await db.exec("reset role; set role service_role");
    const productC = (
      await db.query<{ id: string }>(
        `insert into public.workspace_products(workspace_id,name,slug,status,protected_at,created_by)
         values($1,'Replacement','replacement','protected',now(),$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    await db.exec("reset role; set role authenticated");
    await db.query("select public.map_repository_to_product($1,$2)", [productC, repositoryIds[1]]);
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::integer as count from public.workspace_product_repositories where protected_product_id=$1 and repository_id=$2",
          [productB, repositoryIds[1]],
        )
      ).rows[0]!.count,
    ).toBe(1);
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.workspace_product_repositories where protected_product_id=$1 and repository_id=$2",
          [productB, repositoryIds[1]],
        )
      ).rows[0]!.status,
    ).toBe("inactive");
    await db.exec("reset role; set role service_role");
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(2);
    await db.exec("reset role; set role authenticated");
    await db.exec("reset role; set role service_role");
    await db.query(
      "update public.workspace_subscriptions set status='past_due' where workspace_id=$1",
      [workspaceId],
    );
    const repositoryC = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch)
         values($1,$2,9404,'archive-qa','past-due','main') returning id`,
        [workspaceId, connectionId],
      )
    ).rows[0]!.id;
    await db.exec("reset role; set role authenticated");
    await expect(
      db.query("select public.map_repository_to_product($1,$2)", [productA, repositoryC]),
    ).rejects.toThrow(/repository_plan_required/);
    await db.query("select public.unmap_repository_from_product($1,$2)", [
      productA,
      repositoryIds[0],
    ]);
    await db.close();
  });

  it("rejects Product A workers for an ambiguous legacy-selected repository", async () => {
    const db = await makeDatabase();
    const owner = "51515151-5151-4151-8151-515151515151";
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.exec("set role authenticated");
    const workspaceId = (
      await db.query<{ id: string }>("select public.create_workspace('Worker guard tenant') as id")
    ).rows[0]!.id;
    await db.exec("reset role; set role service_role");
    await db.query(
      `insert into public.workspace_subscriptions(workspace_id,plan,status,current_period_start,current_period_end)
       values($1,'pro','active',now(),now()+interval '30 days')`,
      [workspaceId],
    );
    const productA = (
      await db.query<{ id: string }>(
        "select id from public.workspace_products where workspace_id=$1 and is_default",
        [workspaceId],
      )
    ).rows[0]!.id;
    const productB = (
      await db.query<{ id: string }>(
        `insert into public.workspace_products(workspace_id,name,slug,status,created_by)
         values($1,'Product B','product-b','protected',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    await db.query(
      "update public.workspace_products set status='protected',protected_at=now() where id=$1",
      [productA],
    );
    const provider = (
      await db.query<{ id: string }>("select id from public.dependency_catalog where slug='openai'")
    ).rows[0]!.id;
    const dependencyId = (
      await db.query<{ id: string }>(
        `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by,protected_product_id)
         values($1,$2,$3,$4) returning id`,
        [workspaceId, provider, owner, productA],
      )
    ).rows[0]!.id;
    const secondProvider = (
      await db.query<{ id: string }>("select id from public.dependency_catalog where slug='stripe'")
    ).rows[0]!.id;
    const secondDependencyId = (
      await db.query<{ id: string }>(
        `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by,protected_product_id)
         values($1,$2,$3,$4) returning id`,
        [workspaceId, secondProvider, owner, productB],
      )
    ).rows[0]!.id;
    const connectionId = (
      await db.query<{ id: string }>(
        `insert into public.repository_connections(workspace_id,installation_id,account_login,connected_by)
         values($1,95101,'worker-guard-fixture',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    const repositoryId = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch,selected_for_protection)
         values($1,$2,95102,'worker-guard-fixture','shared-repo','main',true) returning id`,
        [workspaceId, connectionId],
      )
    ).rows[0]!.id;
    await db.query(
      `insert into public.workspace_repository_access(workspace_id,workspace_dependency_id,repository_id)
       values($1,$2,$3),($1,$4,$3)`,
      [workspaceId, dependencyId, repositoryId, secondDependencyId],
    );

    const sourceId = (
      await db.query<{ id: string }>(
        `select source.id from public.source_catalog source
         join public.dependency_catalog dependency on dependency.id=source.dependency_id
         where dependency.slug='openai' and source.enabled order by source.id limit 1`,
      )
    ).rows[0]!.id;
    const firstScanId = (
      await db.query<{ id: string }>(
        `insert into public.scan_runs(source_id,trigger_run_id,attempt_number,status,finished_at)
         values($1,'worker-guard-before',1,'success',now()) returning id`,
        [sourceId],
      )
    ).rows[0]!.id;
    const firstSnapshotId = (
      await db.query<{ id: string }>(
        `insert into public.source_snapshots(source_id,scan_run_id,version,content_hash,normalized_content,normalized_bytes,content_bytes)
         values($1,$2,95101,repeat('a',64),'before',6,6) returning id`,
        [sourceId, firstScanId],
      )
    ).rows[0]!.id;
    const secondScanId = (
      await db.query<{ id: string }>(
        `insert into public.scan_runs(source_id,trigger_run_id,attempt_number,status,finished_at)
         values($1,'worker-guard-after',1,'changed',now()) returning id`,
        [sourceId],
      )
    ).rows[0]!.id;
    const secondSnapshotId = (
      await db.query<{ id: string }>(
        `insert into public.source_snapshots(source_id,scan_run_id,previous_snapshot_id,version,content_hash,normalized_content,normalized_bytes,content_bytes)
         values($1,$2,$3,95102,repeat('b',64),'after!',6,6) returning id`,
        [sourceId, secondScanId, firstSnapshotId],
      )
    ).rows[0]!.id;
    const changeId = (
      await db.query<{ id: string }>(
        `insert into public.source_changes(source_id,scan_run_id,previous_snapshot_id,new_snapshot_id,diff_text,added_lines,removed_lines,previous_bytes,new_bytes)
         values($1,$2,$3,$4,'fixture change',1,0,6,6) returning id`,
        [sourceId, secondScanId, firstSnapshotId, secondSnapshotId],
      )
    ).rows[0]!.id;
    const classificationId = (
      await db.query<{ id: string }>(
        `insert into public.source_change_classifications(
           change_id,classifier_version,schema_version,prompt_version,evidence_fingerprint,provider,status,
           material,category,affected_entities,severity_hint,confidence,summary,evidence,reasoning_summary,
           decision_status,classified_at
         ) values($1,'fixture-v1',1,'fixture-prompt-v1',repeat('c',32),'fixture','classified',true,
           'api_change','[]'::jsonb,'high',0.9,'Fixture change','[]'::jsonb,'Fixture evidence',
           'classified',now()) returning id`,
        [changeId],
      )
    ).rows[0]!.id;
    const assessmentId = (
      await db.query<{ id: string }>(
        `insert into public.impact_assessments(
           workspace_id,workspace_dependency_id,source_change_classification_id,context_fingerprint,
           impact_engine_version,schema_version,prompt_version,provider,status,attempt_count,relevant,
           relevance,severity,affected_areas,impact_summary,why_it_matters,action_required,
           recommended_action,confidence,missing_context,evidence_refs,assessed_at
         ) values($1,$2,$3,repeat('d',64),'impact-v1',1,'impact-prompt-v1','fixture','assessed',1,
           true,'high','high','[]'::jsonb,'Fixture impact','Fixture context',true,'Review the change',
           0.9,'[]'::jsonb,'[]'::jsonb,now()) returning id`,
        [workspaceId, dependencyId, classificationId],
      )
    ).rows[0]!.id;
    const verifiedRunId = (
      await db.query<{ id: string }>(
        `insert into public.preflight_runs(
           workspace_id,impact_assessment_id,status,verified_impact,confidence,preflight_version,
           repository_set_fingerprint,change_fingerprint,started_at,completed_at,repositories_scanned
         ) values($1,$2,'completed','verified',0.9,'fixture-v1',repeat('e',64),repeat('f',64),now(),now(),1)
         returning id`,
        [workspaceId, assessmentId],
      )
    ).rows[0]!.id;
    await db.query(
      `insert into public.preflight_findings(
         workspace_id,preflight_run_id,repository_id,commit_sha,file_path,line_start,line_end,
         finding_type,affected_entity,confidence,verification,explanation,evidence_fingerprint
       ) values($1,$2,$3,repeat('a',40),'src/app.ts',1,1,'provider_import','OpenAI',0.9,
         'verified','Fixture finding',repeat('b',64))`,
      [workspaceId, verifiedRunId, repositoryId],
    );
    const queuedRunId = (
      await db.query<{ id: string }>(
        `insert into public.preflight_runs(workspace_id,impact_assessment_id,preflight_version,
           repository_set_fingerprint,change_fingerprint)
         values($1,$2,'fixture-v1',repeat('1',64),repeat('2',64)) returning id`,
        [workspaceId, assessmentId],
      )
    ).rows[0]!.id;
    const runningRunId = (
      await db.query<{ id: string; run_claim_token: string }>(
        `insert into public.preflight_runs(workspace_id,impact_assessment_id,status,preflight_version,
           repository_set_fingerprint,change_fingerprint,started_at,run_claim_token,run_lease_until)
         values($1,$2,'running','fixture-v1',repeat('3',64),repeat('4',64),now(),gen_random_uuid(),now()+interval '5 minutes')
         returning id,run_claim_token`,
        [workspaceId, assessmentId],
      )
    ).rows[0]!;
    const prepQueueId = (
      await db.query<{ id: string }>(
        `insert into public.remediation_preparation_queue(workspace_id,preflight_run_id,impact_assessment_id,status,attempt_count)
         values($1,$2,$3,'dispatched',1) returning id`,
        [workspaceId, verifiedRunId, assessmentId],
      )
    ).rows[0]!.id;

    await db.exec("reset role; set role service_role");

    expect(
      (
        await db.query<{ claim: string | null }>("select public.claim_preflight_run($1) as claim", [
          queuedRunId,
        ])
      ).rows[0]!.claim,
    ).toBeNull();
    await expect(
      db.query("select public.save_preflight_result($1,$2,array[$3::uuid],'{}'::jsonb)", [
        runningRunId.id,
        runningRunId.run_claim_token,
        repositoryId,
      ]),
    ).rejects.toThrow(/preflight_repository_product_access_revoked/);
    expect(
      (
        await db.query<{ status: string; verified_impact: string | null }>(
          "select status,verified_impact from public.preflight_runs where id=$1",
          [runningRunId.id],
        )
      ).rows[0],
    ).toEqual({ status: "running", verified_impact: null });

    expect(
      (
        await db.query<{ claim: string | null }>(
          "select public.claim_remediation_preparation($1,1) as claim",
          [prepQueueId],
        )
      ).rows[0]!.claim,
    ).toBeNull();
    expect(
      (
        await db.query<{ status: string; error_category: string }>(
          "select status,error_category from public.remediation_preparation_queue where id=$1",
          [prepQueueId],
        )
      ).rows[0],
    ).toEqual({ status: "denied", error_category: "product_repository_unavailable" });

    const claimToken = "61616161-6161-4161-8161-616161616161";
    await db.query(
      `update public.remediation_preparation_queue set status='running',claim_token=$2,
       lease_until=now()+interval '5 minutes' where id=$1`,
      [prepQueueId, claimToken],
    );
    const completion = await db.query<{ value: { status: string } }>(
      `select public.complete_remediation_preparation($1,$2,'completed',
       jsonb_build_object('product_id',$3::uuid,'generation_metadata',jsonb_build_object('repository',jsonb_build_object('id',$4::uuid))),null) as value`,
      [prepQueueId, claimToken, productA, repositoryId],
    );
    expect(completion.rows[0]!.value.status).toBe("denied");
    expect(
      (
        await db.query<{ count: number }>(
          "select count(*)::int as count from public.remediation_proposals where workspace_id=$1",
          [workspaceId],
        )
      ).rows[0]!.count,
    ).toBe(0);

    const proposalId = (
      await db.query<{ id: string }>(
        `insert into public.remediation_proposals(
           workspace_id,preflight_run_id,proposal_kind,proposal_fingerprint,rationale,
           validation_requirements,affected_files,patch,base_commit_sha,product_id,
           workspace_dependency_id,source_change_id,source_change_classification_id,
           patch_fingerprint,generation_metadata,patch_validation_status
         ) values($1,$2,'patch',repeat('9',64),'Grounded fixture proposal','[]'::jsonb,
           '["src/app.ts"]'::jsonb,'fixture patch',repeat('a',40),$3,$4,$5,$6,repeat('8',64),
           jsonb_build_object('repository',jsonb_build_object('id',$7::uuid)), 'validating') returning id`,
        [
          workspaceId,
          verifiedRunId,
          productA,
          dependencyId,
          changeId,
          classificationId,
          repositoryId,
        ],
      )
    ).rows[0]!.id;
    const validationQueueId = (
      await db.query<{ id: string }>(
        `select id from public.remediation_validation_queue
         where workspace_id=$1 and remediation_proposal_id=$2 and patch_fingerprint=repeat('8',64)`,
        [workspaceId, proposalId],
      )
    ).rows[0]!.id;
    await db.query(
      `update public.remediation_validation_queue set status='running',attempt_count=1,
       claim_token='71717171-7171-4171-8171-717171717171',lease_until=now()+interval '5 minutes'
       where id=$1`,
      [validationQueueId],
    );
    await db.query(
      "update public.remediation_proposals set patch_validation_status='validating' where id=$1",
      [proposalId],
    );
    await db.query(
      `select public.complete_remediation_validation(
         $1,'71717171-7171-4171-8171-717171717171','validated',null,'[]'::jsonb,'Fixture result',10
       )`,
      [validationQueueId],
    );
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.remediation_validation_queue where id=$1",
          [validationQueueId],
        )
      ).rows[0]!.status,
    ).toBe("denied");
    expect(
      (
        await db.query<{ outcome: string }>(
          "select outcome from public.remediation_validation_attempts where queue_id=$1",
          [validationQueueId],
        )
      ).rows[0]!.outcome,
    ).toBe("denied");
    expect(
      (
        await db.query<{ patch_validation_status: string }>(
          "select patch_validation_status from public.remediation_proposals where id=$1",
          [proposalId],
        )
      ).rows[0]!.patch_validation_status,
    ).toBe("validation_failed");

    const queuedProposalId = (
      await db.query<{ id: string }>(
        `insert into public.remediation_proposals(
           workspace_id,preflight_run_id,proposal_kind,proposal_fingerprint,rationale,
           validation_requirements,affected_files,patch,base_commit_sha,product_id,
           workspace_dependency_id,source_change_id,source_change_classification_id,
           patch_fingerprint,generation_metadata,patch_validation_status
         ) values($1,$2,'patch',repeat('6',64),'Second fixture proposal','[]'::jsonb,
           '["src/app.ts"]'::jsonb,'second fixture patch',repeat('a',40),$3,$4,$5,$6,repeat('7',64),
           jsonb_build_object('repository',jsonb_build_object('id',$7::uuid)), 'queued') returning id`,
        [
          workspaceId,
          verifiedRunId,
          productA,
          dependencyId,
          changeId,
          classificationId,
          repositoryId,
        ],
      )
    ).rows[0]!.id;
    const queuedValidationId = (
      await db.query<{ id: string }>(
        `select id from public.remediation_validation_queue
         where workspace_id=$1 and remediation_proposal_id=$2 and patch_fingerprint=repeat('7',64)`,
        [workspaceId, queuedProposalId],
      )
    ).rows[0]!.id;
    await db.query(
      `update public.remediation_validation_queue set status='dispatched',attempt_count=1
       where id=$1`,
      [queuedValidationId],
    );
    expect(
      (
        await db.query<{ claim: string | null }>(
          "select public.claim_remediation_validation($1,1) as claim",
          [queuedValidationId],
        )
      ).rows[0]!.claim,
    ).toBeNull();
    expect(
      (
        await db.query<{ status: string }>(
          "select status from public.remediation_validation_queue where id=$1",
          [queuedValidationId],
        )
      ).rows[0]!.status,
    ).toBe("denied");
    expect(
      (
        await db.query<{ patch_validation_status: string }>(
          "select patch_validation_status from public.remediation_proposals where id=$1",
          [queuedProposalId],
        )
      ).rows[0]!.patch_validation_status,
    ).toBe("validation_failed");

    await db.query(
      `insert into public.workspace_product_repositories(
         workspace_id,protected_product_id,repository_id,status,provenance
       ) values($1,$2,$3,'active','user_selected')`,
      [workspaceId, productA, repositoryId],
    );
    await db.query("update public.repositories set selected_for_protection=false where id=$1", [
      repositoryId,
    ]);
    const replacementEvidenceId = (
      await db.query<{ id: string }>(
        `insert into public.source_remediation_replacements(
           source_change_id,source_change_classification_id,old_expression,new_expression,
           evidence_source_url,evidence_fingerprint,synthetic,internal_qa,public_eligible
         ) values($1,$2,'legacyCall()','modernCall()','https://provider.example/changelog',repeat('c',64),true,true,false)
         returning id`,
        [changeId, classificationId],
      )
    ).rows[0]!.id;
    await db.query(
      `insert into public.product_remediation_policies(
         workspace_id,product_id,enabled,draft_pr_preparation_allowed,allowed_repository_ids,updated_by
       ) values($1,$2,true,true,array[$3::uuid],$4)
       on conflict(product_id) do update set enabled=true,draft_pr_preparation_allowed=true,
         allowed_repository_ids=excluded.allowed_repository_ids,updated_by=excluded.updated_by`,
      [workspaceId, productA, repositoryId, owner],
    );
    const explicitlyMappedProposalId = (
      await db.query<{ id: string }>(
        `insert into public.remediation_proposals(
           workspace_id,preflight_run_id,proposal_kind,proposal_fingerprint,rationale,
           validation_requirements,affected_files,patch,base_commit_sha,product_id,
           workspace_dependency_id,source_change_id,source_change_classification_id,
           patch_fingerprint,generation_metadata,patch_validation_status
         ) values($1,$2,'patch',repeat('5',64),'Explicit mapping proposal','[]'::jsonb,
           '["src/app.ts"]'::jsonb,'mapped fixture patch',repeat('a',40),$3,$4,$5,$6,repeat('6',64),
           jsonb_build_object('repository',jsonb_build_object('id',$7::uuid),
             'replacementEvidenceId',$8::text,'internalQaOnly',true), 'queued') returning id`,
        [
          workspaceId,
          verifiedRunId,
          productA,
          dependencyId,
          changeId,
          classificationId,
          repositoryId,
          replacementEvidenceId,
        ],
      )
    ).rows[0]!.id;
    const explicitlyMappedQueueId = (
      await db.query<{ id: string }>(
        `select id from public.remediation_validation_queue
         where workspace_id=$1 and remediation_proposal_id=$2 and patch_fingerprint=repeat('6',64)`,
        [workspaceId, explicitlyMappedProposalId],
      )
    ).rows[0]!.id;
    await db.query(
      `update public.remediation_validation_queue set status='dispatched',attempt_count=1
       where id=$1`,
      [explicitlyMappedQueueId],
    );
    expect(
      (
        await db.query<{ claim: string | null }>(
          "select public.claim_remediation_validation($1,1) as claim",
          [explicitlyMappedQueueId],
        )
      ).rows[0]!.claim,
    ).not.toBeNull();
    expect(
      (
        await db.query<{ selected_for_protection: boolean }>(
          "select selected_for_protection from public.repositories where id=$1",
          [repositoryId],
        )
      ).rows[0]!.selected_for_protection,
    ).toBe(true);

    await db.exec("reset role; set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    const observations = await db.query<{
      source_id: string;
      snapshot_id: string;
      scan_status: string;
    }>("select * from public.get_product_source_observation_states($1,array[$2::uuid])", [
      workspaceId,
      sourceId,
    ]);
    expect(observations.rows).toEqual([
      expect.objectContaining({
        source_id: sourceId,
        snapshot_id: secondSnapshotId,
        scan_status: "changed",
      }),
    ]);
    const outsider = "81818181-8181-4181-8181-818181818181";
    await db.exec("reset role");
    await db.query("insert into auth.users(id) values($1)", [outsider]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
    await db.exec("set role authenticated");
    await expect(
      db.query("select * from public.get_product_source_observation_states($1,array[$2::uuid])", [
        workspaceId,
        sourceId,
      ]),
    ).rejects.toThrow();
    await db.close();
  });

  it("backfills only uniquely evidenced product repository intent", async () => {
    const db = await makeDatabase(true, false);
    const owner = "41414141-4141-4141-8141-414141414141";
    await db.query("insert into auth.users(id) values($1)", [owner]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await db.exec("set role authenticated");
    const workspace = await db.query<{ id: string }>(
      "select public.create_workspace('Backfill tenant') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    await db.exec("reset role; set role service_role");
    const productIds = (
      await db.query<{ id: string }>(
        "select id from public.workspace_products where workspace_id=$1 order by is_default desc",
        [workspaceId],
      )
    ).rows.map((product) => product.id);
    const secondProduct = (
      await db.query<{ id: string }>(
        `insert into public.workspace_products(workspace_id,name,slug,status,created_by)
       values($1,'Second product','second-product','draft',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    await db.query(
      "update public.workspace_products set status='protected',protected_at=now() where id=$1",
      [productIds[0]],
    );
    const providers = await db.query<{ id: string; slug: string }>(
      "select id,slug from public.dependency_catalog where slug in ('openai','stripe')",
    );
    const providerId = new Map(providers.rows.map((provider) => [provider.slug, provider.id]));
    const dependencyA = (
      await db.query<{ id: string }>(
        `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by,protected_product_id)
       values($1,$2,$3,$4) returning id`,
        [workspaceId, providerId.get("openai"), owner, productIds[0]],
      )
    ).rows[0]!.id;
    const dependencyB = (
      await db.query<{ id: string }>(
        `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by,protected_product_id)
       values($1,$2,$3,$4) returning id`,
        [workspaceId, providerId.get("stripe"), owner, secondProduct],
      )
    ).rows[0]!.id;
    const connection = (
      await db.query<{ id: string }>(
        `insert into public.repository_connections(workspace_id,installation_id,account_login,connected_by)
       values($1,9301,'backfill-account',$2) returning id`,
        [workspaceId, owner],
      )
    ).rows[0]!.id;
    const repositoryA = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch,selected_for_protection)
       values($1,$2,9302,'backfill-account','deterministic','main',true) returning id`,
        [workspaceId, connection],
      )
    ).rows[0]!.id;
    const repositoryB = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch,selected_for_protection)
       values($1,$2,9303,'backfill-account','ambiguous','main',true) returning id`,
        [workspaceId, connection],
      )
    ).rows[0]!.id;
    const repositoryC = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch,selected_for_protection)
       values($1,$2,9304,'backfill-account','unlinked','main',true) returning id`,
        [workspaceId, connection],
      )
    ).rows[0]!.id;
    const repositoryD = (
      await db.query<{ id: string }>(
        `insert into public.repositories(workspace_id,connection_id,external_id,owner,name,default_branch,selected_for_protection)
       values($1,$2,9305,'backfill-account','draft-product','main',true) returning id`,
        [workspaceId, connection],
      )
    ).rows[0]!.id;
    await db.query(
      "insert into public.workspace_repository_access(workspace_id,workspace_dependency_id,repository_id) values($1,$2,$3),($1,$4,$5),($1,$6,$5),($1,$7,$8)",
      [
        workspaceId,
        dependencyA,
        repositoryA,
        dependencyA,
        repositoryB,
        dependencyB,
        dependencyB,
        repositoryD,
      ],
    );
    await db.exec("reset role");
    await db.exec(productRepositoryProtectionMigration);

    const backfilled = await db.query<{
      repository_id: string;
      protected_product_id: string;
      provenance: string;
      status: string;
    }>(
      "select repository_id,protected_product_id,provenance,status from public.workspace_product_repositories order by repository_id",
    );
    expect(backfilled.rows).toHaveLength(2);
    expect(backfilled.rows).toEqual(
      expect.arrayContaining([
        {
          repository_id: repositoryA,
          protected_product_id: productIds[0],
          provenance: "legacy_deterministic",
          status: "active",
        },
        {
          repository_id: repositoryD,
          protected_product_id: secondProduct,
          provenance: "legacy_deterministic",
          status: "inactive",
        },
      ]),
    );
    expect(
      (
        await db.query(
          "select repository_id from public.workspace_repository_access where repository_id=$1",
          [repositoryA],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "select id from public.repositories where id in ($1,$2,$3,$4) and selected_for_protection",
          [repositoryA, repositoryB, repositoryC, repositoryD],
        )
      ).rows,
    ).toHaveLength(3);
    expect(
      (
        await db.query<{ usage: number }>(
          "select private.workspace_protected_repository_usage($1) as usage",
          [workspaceId],
        )
      ).rows[0]!.usage,
    ).toBe(3);
    await db.close();
  });

  it("returns dependency baseline metadata to workspace members without granting snapshot reads", async () => {
    const baselineDb = await makeDatabase();
    const owner = "12121212-1212-4212-8212-121212121212";
    const outsider = "34343434-3434-4434-8434-343434343434";
    await baselineDb.query("insert into auth.users (id) values ($1),($2)", [owner, outsider]);
    await baselineDb.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await baselineDb.exec("set role authenticated");
    const workspace = await baselineDb.query<{ id: string }>(
      "select public.create_workspace('Baseline tenant') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    await baselineDb.exec("reset role; set role service_role");
    const provider = await baselineDb.query<{ id: string }>(
      "select id from public.dependency_catalog where slug='openai'",
    );
    await baselineDb.query(
      "insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by) values ($1,$2,$3)",
      [workspaceId, provider.rows[0]!.id, owner],
    );
    const source = await baselineDb.query<{ id: string }>(
      "select id from public.source_catalog where dependency_id=$1 and enabled order by id limit 1",
      [provider.rows[0]!.id],
    );
    await baselineDb.exec("reset role; set role authenticated");
    const baseline = await baselineDb.query<{
      source_id: string;
      latest_baseline_at: string | null;
    }>("select * from public.get_dependency_source_baselines($1,array[$2::uuid])", [
      workspaceId,
      source.rows[0]!.id,
    ]);
    expect(baseline.rows).toEqual([{ source_id: source.rows[0]!.id, latest_baseline_at: null }]);
    await expect(baselineDb.query("select * from public.source_snapshots")).rejects.toBeTruthy();
    await baselineDb.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
    await expect(
      baselineDb.query("select * from public.get_dependency_source_baselines($1,array[$2::uuid])", [
        workspaceId,
        source.rows[0]!.id,
      ]),
    ).rejects.toThrow();
    await baselineDb.close();
  });

  it("atomically enforces a service-only public rate-limit bucket", async () => {
    const rateDb = await makeDatabase();
    await rateDb.exec("set role service_role");
    const fingerprint = "a".repeat(64);
    const first = await rateDb.query<{
      allowed: boolean;
      remaining: number;
      retry_after_seconds: number;
    }>(
      "select * from public.claim_public_rate_limit('public_stack_scan',$1,1,1800,'2026-10-05T12:00:00Z'::timestamptz)",
      [fingerprint],
    );
    const second = await rateDb.query<{
      allowed: boolean;
      remaining: number;
      retry_after_seconds: number;
    }>(
      "select * from public.claim_public_rate_limit('public_stack_scan',$1,1,1800,'2026-10-05T12:00:00Z'::timestamptz)",
      [fingerprint],
    );
    const stored = await rateDb.query<{ request_count: number }>(
      "select request_count from public.public_rate_limit_buckets where client_fingerprint=$1",
      [fingerprint],
    );
    expect(stored.rows).toEqual([{ request_count: 2 }]);
    expect(first.rows[0]).toMatchObject({ allowed: true, remaining: 0 });
    expect(second.rows[0]).toMatchObject({ allowed: false, remaining: 0 });
    expect(second.rows[0]!.retry_after_seconds).toBeGreaterThan(0);
    await rateDb.exec("reset role; set role authenticated");
    await expect(rateDb.query("select * from public.public_rate_limit_buckets")).rejects.toThrow();
    await expect(
      rateDb.query(
        "select * from public.claim_public_rate_limit('public_stack_scan',$1,1,1800,now())",
        [fingerprint],
      ),
    ).rejects.toThrow();
    await rateDb.close();
  });

  it("saturates concurrently scheduled rate-limit and scan-slot claims", async () => {
    const concurrentDb = await makeDatabase();
    await concurrentDb.exec("set role service_role");
    const fingerprint = "b".repeat(64);
    const rateClaims = await Promise.all(
      Array.from({ length: 20 }, () =>
        concurrentDb.query<{ allowed: boolean }>(
          "select allowed from public.claim_public_rate_limit('public_stack_scan',$1,4,1800,'2026-10-05T12:00:00Z'::timestamptz)",
          [fingerprint],
        ),
      ),
    );
    expect(rateClaims.filter((claim) => claim.rows[0]!.allowed)).toHaveLength(4);
    const rateBucket = await concurrentDb.query<{ request_count: number }>(
      "select request_count from public.public_rate_limit_buckets where client_fingerprint=$1",
      [fingerprint],
    );
    expect(rateBucket.rows[0]!.request_count).toBe(5);

    const leaseIds = Array.from(
      { length: 20 },
      (_, index) => `55555555-5555-4555-8555-${index.toString().padStart(12, "0")}`,
    );
    const leaseClaims = await Promise.all(
      leaseIds.map((leaseId) =>
        concurrentDb.query<{ acquired: boolean }>(
          "select acquired from public.claim_public_scan_slot($1,2,30)",
          [leaseId],
        ),
      ),
    );
    expect(leaseClaims.filter((claim) => claim.rows[0]!.acquired)).toHaveLength(2);
    const leaseCount = await concurrentDb.query<{ count: number }>(
      "select count(*)::integer as count from public.public_scan_leases",
    );
    expect(leaseCount.rows[0]!.count).toBe(2);
    await concurrentDb.close();
  });

  it("bounds global public scan concurrency with expiring service-only leases", async () => {
    const leaseDb = await makeDatabase();
    await leaseDb.exec("set role service_role");
    const firstLease = "11111111-1111-4111-8111-111111111111";
    const secondLease = "22222222-2222-4222-8222-222222222222";
    const first = await leaseDb.query<{ acquired: boolean; lease_id: string | null }>(
      "select * from public.claim_public_scan_slot($1,1,30)",
      [firstLease],
    );
    const second = await leaseDb.query<{ acquired: boolean; lease_id: string | null }>(
      "select * from public.claim_public_scan_slot($1,1,30)",
      [secondLease],
    );
    expect(first.rows[0]).toEqual({ acquired: true, lease_id: firstLease });
    expect(second.rows[0]).toEqual({ acquired: false, lease_id: null });
    const released = await leaseDb.query<{ release_public_scan_slot: boolean }>(
      "select public.release_public_scan_slot($1)",
      [firstLease],
    );
    expect(released.rows[0]!.release_public_scan_slot).toBe(true);
    const retried = await leaseDb.query<{ acquired: boolean; lease_id: string | null }>(
      "select * from public.claim_public_scan_slot($1,1,30)",
      [secondLease],
    );
    expect(retried.rows[0]).toEqual({ acquired: true, lease_id: secondLease });
    await leaseDb.exec("reset role; set role authenticated");
    await expect(leaseDb.query("select * from public.public_scan_leases")).rejects.toThrow();
    await leaseDb.close();
  });

  it("recovers global scan capacity from an expired lease", async () => {
    const expiryDb = await makeDatabase();
    await expiryDb.exec("set role service_role");
    const abandonedLease = "33333333-3333-4333-8333-333333333333";
    const replacementLease = "44444444-4444-4444-8444-444444444444";
    const abandoned = await expiryDb.query<{ acquired: boolean; lease_id: string | null }>(
      "select * from public.claim_public_scan_slot($1,1,15)",
      [abandonedLease],
    );
    expect(abandoned.rows[0]).toEqual({ acquired: true, lease_id: abandonedLease });
    await expiryDb.query(
      "update public.public_scan_leases set expires_at=now()-interval '1 second' where lease_id=$1",
      [abandonedLease],
    );
    const replacement = await expiryDb.query<{ acquired: boolean; lease_id: string | null }>(
      "select * from public.claim_public_scan_slot($1,1,15)",
      [replacementLease],
    );
    expect(replacement.rows[0]).toEqual({ acquired: true, lease_id: replacementLease });
    const expired = await expiryDb.query(
      "select lease_id from public.public_scan_leases where lease_id=$1",
      [abandonedLease],
    );
    expect(expired.rows).toEqual([]);
    await expiryDb.close();
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
    await db.query(
      `insert into public.workspace_onboarding(workspace_id,company_id,state)
       values ($1,$2,'company_created')`,
      [workspaceId, companyId],
    );
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
        '[{"provider_slug":"stripe","signature_key":"stripe-js-v3","signal_type":"script_host","strength":"strong","source_origin":"https://discovery.example","surface_type":"ROOT_MARKETING","surface_host":"discovery.example"}]'::jsonb,
        '[{"provider_slug":"stripe","confidence":0.72,"confidence_label":"medium","evidence_summary":[{"signatureKey":"stripe-js-v3"}]}]'::jsonb,
        '{"outcome":"complete","company":{"surfacesObserved":1,"surfacesSelected":1,"surfacesScanned":1,"surfaces":[],"suppressedObservations":[],"providersSuggested":1,"providersSuppressed":0,"technologyObservations":[{"fingerprintId":"internal-fingerprint-must-not-leak","sourceHost":"private.example"}]}}'::jsonb,
        '[{"technology_slug":"stripe","technology_name":"Stripe","category":"payments","fingerprint_id":"provider-stripe-js-v3","registry_version":"2026-10-04.2","evidence_family":"script_url","strength":"strong","relationship":"provides_service","protectability":"protectable","status":"supported","disposition":"suggested","suppression_reason":null,"surface_type":"ROOT_MARKETING","surface_host":"discovery.example","source_host":"discovery.example"}]'::jsonb
      )`,
      [run.rows[0]!.id, workspaceId, companyId],
    );
    expect(
      (
        await db.query<{ fingerprint_id: string; registry_version: string }>(
          "select fingerprint_id,registry_version from public.technology_observations where run_id=$1",
          [run.rows[0]!.id],
        )
      ).rows,
    ).toEqual([{ fingerprint_id: "provider-stripe-js-v3", registry_version: "2026-10-04.2" }]);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await db.exec("set role authenticated");
    const candidateToDismiss = await db.query<{ id: string }>(
      "select id from public.discovered_dependencies where company_id=$1 and dependency_id=$2",
      [companyId, provider.rows[0]!.id],
    );
    expect(candidateToDismiss.rows).toHaveLength(1);
    const dismissal = await db.query<{ value: { decision: string } }>(
      "select public.decide_onboarding_dependency_candidate($1,$2,'rejected') as value",
      [workspaceId, candidateToDismiss.rows[0]!.id],
    );
    expect(dismissal.rows[0]!.value.decision).toBe("rejected");
    await db.exec("reset role; set role service_role");
    const separatedDisposition = await db.query<{
      candidate_status: string;
      observation_status: string;
      observation_disposition: string;
      evidence_count: number;
    }>(
      `select candidate.status as candidate_status, observation.status as observation_status,
              observation.disposition as observation_disposition,
              (select count(*)::int from public.dependency_discovery_evidence evidence
               where evidence.run_id=observation.run_id and evidence.provider_slug='stripe') as evidence_count
       from public.discovered_dependencies candidate
       join public.technology_observations observation on observation.run_id=$2
       where candidate.id=$1`,
      [candidateToDismiss.rows[0]!.id, run.rows[0]!.id],
    );
    expect(separatedDisposition.rows).toEqual([
      {
        candidate_status: "rejected",
        observation_status: "supported",
        observation_disposition: "suggested",
        evidence_count: 1,
      },
    ]);
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await db.exec("set role authenticated");
    const safeOnboarding = await db.query<{ value: unknown }>(
      "select public.get_onboarding_status_with_discovery_coverage($1) as value",
      [workspaceId],
    );
    expect(JSON.stringify(safeOnboarding.rows[0]!.value)).not.toContain(
      "internal-fingerprint-must-not-leak",
    );
    expect(JSON.stringify(safeOnboarding.rows[0]!.value)).not.toContain("private.example");
    expect(JSON.stringify(safeOnboarding.rows[0]!.value)).not.toContain("technologyObservations");
    await db.exec("reset role");
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
          workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin,surface_type,surface_host
        ) values ($1,$2,'stripe',$3,$4,'medium','https://discovery.example','ROOT_MARKETING','discovery.example')`,
        [workspaceId, run.rows[0]!.id, `m11-signal-${index}`, signalType],
      );
    }
    await expect(
      db.query(
        `insert into public.dependency_discovery_evidence (
          workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin,surface_type,surface_host
        ) values ($1,$2,'stripe','m11-unknown-signal','unknown_type','medium','https://discovery.example','ROOT_MARKETING','discovery.example')`,
        [workspaceId, run.rows[0]!.id],
      ),
    ).rejects.toBeTruthy();
    await expect(
      db.query(
        `insert into public.dependency_discovery_evidence (
          workspace_id,run_id,provider_slug,signature_key,signal_type,strength,source_origin,surface_type,surface_host
        ) values ($1,$2,'stripe','m11-mismatched-host','resource_host','medium','https://api.stripe.com','PRODUCT_APP','discovery.example')`,
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
    await expect(
      db.query("select * from public.technology_observations where workspace_id=$1", [workspaceId]),
    ).rejects.toBeTruthy();
    await expect(
      db.query(
        "insert into public.technology_observations(workspace_id,run_id,technology_slug,technology_name,category,fingerprint_id,registry_version,evidence_family,strength,relationship,protectability,status,disposition,surface_type,surface_host,source_host) values ($1,$2,'nextjs','Next.js','framework','nextjs-static-script','2026-10-04.1','script_asset','strong','framework_for','non_protectable','strong','suppressed','ROOT_MARKETING','discovery.example','discovery.example')",
        [workspaceId, run.rows[0]!.id],
      ),
    ).rejects.toBeTruthy();
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

    await db.query(
      `insert into public.workspace_subscriptions (
         workspace_id,plan,status,current_period_start,current_period_end
       ) values ($1,'pro','active',now(),now()+interval '30 days')
       on conflict (workspace_id) do update set plan='pro',status='active',
         current_period_start=now(),current_period_end=now()+interval '30 days',
         trial_started_at=null,trial_ends_at=null`,
      [workspaceA.rows[0]!.id],
    );
    const retryQueue = await db.query<{ id: string }>(
      `insert into public.preflight_dispatch_queue (
         workspace_id,impact_assessment_id,repository_set_fingerprint,status,attempt_count,trigger_run_id
       ) values ($1,$2,repeat('d',64),'failed',2,'stale-trigger-run') returning id`,
      [workspaceA.rows[0]!.id, assessment.rows[0]!.id],
    );
    const retriedAttempt = await db.query<{ attempt: number }>(
      "select public.mark_preflight_dispatch($1,'dispatched') as attempt",
      [retryQueue.rows[0]!.id],
    );
    expect(retriedAttempt.rows[0]!.attempt).toBe(3);
    expect(
      (
        await db.query<{ trigger_run_id: string | null }>(
          "select trigger_run_id from public.preflight_dispatch_queue where id=$1",
          [retryQueue.rows[0]!.id],
        )
      ).rows[0]!.trigger_run_id,
    ).toBeNull();
    const acceptedRunIdentity = await db.query<{ accepted: boolean }>(
      "select public.mark_preflight_dispatch_run($1,3,'fresh-trigger-run') as accepted",
      [retryQueue.rows[0]!.id],
    );
    expect(acceptedRunIdentity.rows[0]!.accepted).toBe(true);
    expect(
      (
        await db.query<{ trigger_run_id: string | null }>(
          "select trigger_run_id from public.preflight_dispatch_queue where id=$1",
          [retryQueue.rows[0]!.id],
        )
      ).rows[0]!.trigger_run_id,
    ).toBe("fresh-trigger-run");

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
    let remainingClaims: { queue_id: string }[] = [{ queue_id: "pending" }];
    let claimCalls = 0;
    while (remainingClaims.length > 0 && claimCalls < 10) {
      const claim = await db.query<{ queue_id: string }>(
        "select * from public.claim_growth_evaluation_batch(100)",
      );
      remainingClaims = claim.rows;
      claimCalls += 1;
    }
    expect(remainingClaims).toHaveLength(0);
    expect(claimCalls).toBeGreaterThan(1);
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
    await db.query(
      "insert into public.growth_search_console_oauth_states(state_hash,actor_user_id,browser_hash,verifier_ciphertext,verifier_nonce,verifier_authentication_tag,verifier_key_version,actor_token_ciphertext,actor_token_nonce,actor_token_authentication_tag,actor_token_key_version,expires_at) values(repeat('f',64),$1,repeat('e',64),'cipher','nonce','tag',1,'actor','nonce','tag',1,now()-interval '1 second')",
      [userId],
    );
    const expiredOAuthClaim = await db.query(
      "select * from public.claim_growth_search_console_oauth_state(repeat('f',64),repeat('e',64))",
    );
    expect(expiredOAuthClaim.rows).toHaveLength(0);
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
    // `now()` is transaction-stable in Postgres. Keep the rate-limit probe in one
    // transaction so a minute boundary cannot grant a second bucket mid-test.
    await db.exec("begin");
    await db.exec("truncate public.growth_public_event_ingest_buckets");
    let acceptedPublicEvents = 0;
    for (let index = 0; index < 121; index += 1) {
      const allowed = await db.query<{ allowed: boolean }>(
        "select public.claim_growth_public_conversion_event() as allowed",
      );
      if (allowed.rows[0]?.allowed) acceptedPublicEvents += 1;
    }
    expect(acceptedPublicEvents).toBe(120);
    await db.exec("commit");
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

  it("restricts preflight dispatch worker RPCs to service_role", async () => {
    const db = await makeDatabase();
    const privileges = await db.query<{
      function_name: string;
      anon_execute: boolean;
      authenticated_execute: boolean;
      service_role_execute: boolean;
      public_execute: boolean;
    }>(`
      select
        procedure.proname as function_name,
        has_function_privilege('anon', procedure.oid, 'execute') as anon_execute,
        has_function_privilege('authenticated', procedure.oid, 'execute') as authenticated_execute,
        has_function_privilege('service_role', procedure.oid, 'execute') as service_role_execute,
        exists (
          select 1
          from aclexplode(procedure.proacl) privilege
          where privilege.grantee = 0 and privilege.privilege_type = 'EXECUTE'
        ) as public_execute
      from pg_proc procedure
      join pg_namespace namespace on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and procedure.oid in (
          'public.list_preflight_dispatch_queue(integer)'::regprocedure,
          'public.mark_preflight_dispatch(uuid,text,text)'::regprocedure
        )
      order by procedure.proname
    `);

    expect(privileges.rows).toEqual([
      {
        function_name: "list_preflight_dispatch_queue",
        anon_execute: false,
        authenticated_execute: false,
        service_role_execute: true,
        public_execute: false,
      },
      {
        function_name: "mark_preflight_dispatch",
        anon_execute: false,
        authenticated_execute: false,
        service_role_execute: true,
        public_execute: false,
      },
    ]);
  });

  it("keeps persisted remediation credentials private and validation/policy reads tenant gated", async () => {
    const db = await makeDatabase();
    const relations = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relation.relname,relation.relrowsecurity
       from pg_class relation join pg_namespace namespace on namespace.oid=relation.relnamespace
       where namespace.nspname='public' and relation.relname = any($1::text[])`,
      [
        [
          "source_remediation_replacements",
          "product_remediation_policies",
          "remediation_validation_queue",
          "remediation_validation_attempts",
          "remediation_preparation_queue",
          "customer_risk_resolutions",
        ],
      ],
    );
    expect(relations.rows).toHaveLength(6);
    expect(relations.rows.every((relation) => relation.relrowsecurity)).toBe(true);

    const privileges = await db.query<{
      policyRead: boolean;
      queueRead: boolean;
      attemptsRead: boolean;
      preparationRead: boolean;
      resolutionRead: boolean;
      resolutionWrite: boolean;
      replacementRead: boolean;
      queueWrite: boolean;
      preparationWrite: boolean;
      policyWrite: boolean;
      setPolicy: boolean;
      anonSetPolicy: boolean;
      serviceClaim: boolean;
      memberClaim: boolean;
      request_result_type: string;
      request_rpc_exposes_claim_token: boolean;
      servicePreparationClaim: boolean;
      memberPreparationClaim: boolean;
      serviceDispatchRun: boolean;
      memberDispatchRun: boolean;
      resolveRisk: boolean;
      anonResolveRisk: boolean;
    }>(`
      select
        has_table_privilege('authenticated','public.product_remediation_policies','select') policy_read,
        has_table_privilege('authenticated','public.remediation_validation_queue','select') queue_read,
        has_table_privilege('authenticated','public.remediation_validation_attempts','select') attempts_read,
        has_table_privilege('authenticated','public.remediation_preparation_queue','select') preparation_read,
        has_table_privilege('authenticated','public.customer_risk_resolutions','select') resolution_read,
        has_table_privilege('authenticated','public.customer_risk_resolutions','insert,update,delete') resolution_write,
        has_table_privilege('authenticated','public.source_remediation_replacements','select') replacement_read,
        has_table_privilege('authenticated','public.remediation_validation_queue','insert,update,delete') queue_write,
        has_table_privilege('authenticated','public.remediation_preparation_queue','insert,update,delete') preparation_write,
        has_table_privilege('authenticated','public.product_remediation_policies','insert,update,delete') policy_write,
        has_function_privilege('authenticated','public.set_product_remediation_policy(uuid,uuid,boolean,boolean,boolean,boolean,uuid[])','execute') set_policy,
        has_function_privilege('anon','public.set_product_remediation_policy(uuid,uuid,boolean,boolean,boolean,boolean,uuid[])','execute') anon_set_policy,
        has_function_privilege('service_role','public.claim_remediation_validation(uuid,integer)','execute') service_claim,
        has_function_privilege('authenticated','public.claim_remediation_validation(uuid,integer)','execute') member_claim,
        has_function_privilege('service_role','public.claim_remediation_preparation(uuid,integer)','execute') service_preparation_claim,
        has_function_privilege('authenticated','public.claim_remediation_preparation(uuid,integer)','execute') member_preparation_claim,
        has_function_privilege('service_role','public.mark_preflight_dispatch_run(uuid,integer,text)','execute') service_dispatch_run,
        has_function_privilege('authenticated','public.mark_preflight_dispatch_run(uuid,integer,text)','execute') member_dispatch_run,
        has_function_privilege('authenticated','public.resolve_customer_risk(uuid,uuid,text)','execute') resolve_risk,
        has_function_privilege('anon','public.resolve_customer_risk(uuid,uuid,text)','execute') anon_resolve_risk
    `);
    expect(privileges.rows[0]).toEqual({
      policy_read: true,
      queue_read: true,
      attempts_read: true,
      preparation_read: true,
      resolution_read: true,
      resolution_write: false,
      replacement_read: false,
      queue_write: false,
      preparation_write: false,
      policy_write: false,
      set_policy: true,
      anon_set_policy: false,
      service_claim: true,
      member_claim: false,
      service_preparation_claim: true,
      member_preparation_claim: false,
      service_dispatch_run: true,
      member_dispatch_run: false,
      resolve_risk: true,
      anon_resolve_risk: false,
    });
  });

  it("keeps Business handoff requests tenant-readable and worker mutations service-only", async () => {
    const db = await makeDatabase();
    const relations = await db.query<{ relrowsecurity: boolean }>(`
      select relrowsecurity from pg_class relation
      join pg_namespace namespace on namespace.oid=relation.relnamespace
      where namespace.nspname='public' and relation.relname='business_handoff_requests'
    `);
    expect(relations.rows).toEqual([{ relrowsecurity: true }]);
    const privileges = await db.query<{
      memberRead: boolean;
      memberSafeStatusRead: boolean;
      memberClaimTokenRead: boolean;
      memberWrite: boolean;
      serviceWrite: boolean;
      requestRpc: boolean;
      anonRequestRpc: boolean;
      serviceClaim: boolean;
      memberClaim: boolean;
    }>(`
      select
        has_table_privilege('authenticated','public.business_handoff_requests','select') member_read,
        has_column_privilege('authenticated','public.business_handoff_requests','status','select') member_safe_status_read,
        has_column_privilege('authenticated','public.business_handoff_requests','claim_token','select') member_claim_token_read,
        has_table_privilege('authenticated','public.business_handoff_requests','insert,update,delete') member_write,
        has_table_privilege('service_role','public.business_handoff_requests','insert,update,delete') service_write,
        has_function_privilege('authenticated','public.request_business_handoff(uuid,uuid,uuid,text)','execute') request_rpc,
        has_function_privilege('anon','public.request_business_handoff(uuid,uuid,uuid,text)','execute') anon_request_rpc,
        has_function_privilege('service_role','public.claim_business_handoff_execution(uuid,integer)','execute') service_claim,
        has_function_privilege('authenticated','public.claim_business_handoff_execution(uuid,integer)','execute') member_claim,
        pg_get_function_result('public.request_business_handoff(uuid,uuid,uuid,text)'::regprocedure) request_result_type,
        position('claim_token' in pg_get_functiondef('public.request_business_handoff(uuid,uuid,uuid,text)'::regprocedure)) > 0 request_rpc_exposes_claim_token
    `);
    expect(privileges.rows[0]).toEqual({
      member_read: false,
      member_safe_status_read: true,
      member_claim_token_read: false,
      member_write: false,
      service_write: true,
      request_rpc: true,
      anon_request_rpc: false,
      service_claim: true,
      member_claim: false,
      request_result_type: "jsonb",
      request_rpc_exposes_claim_token: false,
    });
  });

  it("persists Product onboarding with member RLS, ordered resume, scoped activation, and one trial", async () => {
    const onboardingDb = await makeDatabase();
    const owner = "d1515151-5151-4515-8515-151515151515";
    const outsider = "d2525252-5252-4525-8525-252525252525";
    await onboardingDb.query("insert into auth.users(id) values($1),($2)", [owner, outsider]);
    await onboardingDb.query("select set_config('request.jwt.claim.sub',$1,false)", [owner]);
    await onboardingDb.exec("set role authenticated");
    const workspace = await onboardingDb.query<{ id: string }>(
      "select public.create_workspace('V2 onboarding tenant') as id",
    );
    const workspaceId = workspace.rows[0]!.id;
    await onboardingDb.exec("reset role; set role service_role");
    const company = await onboardingDb.query<{ id: string }>(
      `insert into public.companies(workspace_id,name,slug,website_url,website_domain)
       values($1,'V2 Example','v2-example','https://v2.example/','v2.example') returning id`,
      [workspaceId],
    );
    const companyId = company.rows[0]!.id;
    await onboardingDb.query(
      `insert into public.workspace_onboarding(workspace_id,company_id,state,
        dependency_review_completed_at,context_completed_at,notifications_completed_at)
       values($1,$2,'notifications_setup',now(),now(),now())`,
      [workspaceId, companyId],
    );
    const product = await onboardingDb.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 and is_default",
      [workspaceId],
    );
    const productId = product.rows[0]!.id;
    const dependency = await onboardingDb.query<{ id: string }>(
      "select id from public.dependency_catalog where slug='stripe'",
    );
    await onboardingDb.query(
      `insert into public.workspace_dependencies(workspace_id,protected_product_id,dependency_id,selected_by,origin)
       values($1,$2,$3,$4,'manual')`,
      [workspaceId, productId, dependency.rows[0]!.id, owner],
    );
    await onboardingDb.exec("reset role; set role authenticated");

    const started = await onboardingDb.query<{ value: { stage: string; productId: string } }>(
      "select public.start_product_onboarding_v2($1,$2) as value",
      [workspaceId, productId],
    );
    expect(started.rows[0]!.value).toMatchObject({ stage: "scan_import", productId });
    const replayed = await onboardingDb.query<{ value: { stage: string } }>(
      "select public.start_product_onboarding_v2($1,$2) as value",
      [workspaceId, productId],
    );
    expect(replayed.rows[0]!.value.stage).toBe("scan_import");
    await expect(
      onboardingDb.query("select public.transition_product_onboarding_v2($1,$2,'discovery')", [
        workspaceId,
        productId,
      ]),
    ).rejects.toThrow(/out_of_order/);

    for (const stage of [
      "company",
      "product",
      "discovery",
      "dependency_confirmation",
      "protection_graph",
      "strengthen_protection",
      "activation",
    ]) {
      await onboardingDb.query("select public.transition_product_onboarding_v2($1,$2,$3)", [
        workspaceId,
        productId,
        stage,
      ]);
    }
    const activated = await onboardingDb.query<{
      value: { activatedAt: string; productId: string };
    }>("select public.activate_product_protection_v2($1,$2) as value", [workspaceId, productId]);
    expect(activated.rows[0]!.value.productId).toBe(productId);
    const completed = await onboardingDb.query<{ value: { stage: string } }>(
      "select public.transition_product_onboarding_v2($1,$2,'complete') as value",
      [workspaceId, productId],
    );
    expect(completed.rows[0]!.value.stage).toBe("complete");
    const trialRows = await onboardingDb.query<{ count: number }>(
      "select count(*)::integer as count from public.workspace_subscriptions where workspace_id=$1 and status='trialing'",
      [workspaceId],
    );
    expect(trialRows.rows[0]!.count).toBe(1);
    const activatedAgain = await onboardingDb.query<{ value: { activatedAt: string } }>(
      "select public.activate_product_protection_v2($1,$2) as value",
      [workspaceId, productId],
    );
    expect(activatedAgain.rows[0]!.value.activatedAt).toBe(activated.rows[0]!.value.activatedAt);
    expect(
      (
        await onboardingDb.query(
          "select workspace_id from public.workspace_subscriptions where workspace_id=$1",
          [workspaceId],
        )
      ).rows,
    ).toHaveLength(1);

    const secondProductResult = await onboardingDb.query<{ value: { product: { id: string } } }>(
      "select public.create_workspace_product($1,'Second Product','[]'::jsonb,null) as value",
      [workspaceId],
    );
    const secondProductId = secondProductResult.rows[0]!.value.product.id;
    await onboardingDb.query("select public.add_product_dependency_manually($1,$2,'openai')", [
      workspaceId,
      secondProductId,
    ]);
    await onboardingDb.query("select public.start_product_onboarding_v2($1,$2)", [
      workspaceId,
      secondProductId,
    ]);
    await onboardingDb.exec("reset role; set role service_role");
    await onboardingDb.query("select * from public.claim_onboarding_baseline_sources($1,$2,100)", [
      owner,
      workspaceId,
    ]);
    const draftProductBaselineRows = await onboardingDb.query<{ count: number }>(
      `select count(*)::integer as count from public.baseline_scan_queue queue
       join public.source_catalog source on source.id=queue.source_id
       join public.dependency_catalog dependency on dependency.id=source.dependency_id
       where dependency.slug='openai'`,
    );
    expect(draftProductBaselineRows.rows[0]!.count).toBe(0);
    await onboardingDb.exec("reset role; set role authenticated");
    await expect(
      onboardingDb.query("select public.activate_product_protection_v2($1,$2)", [
        workspaceId,
        secondProductId,
      ]),
    ).rejects.toThrow(/activation_stage_required/);
    await onboardingDb.exec("reset role; set role service_role");
    const secondRun = await onboardingDb.query<{ id: string }>(
      `insert into public.dependency_discovery_runs(workspace_id,company_id,website_url,trigger_run_id,attempt_number,status,finished_at)
       values($1,$2,'https://v2.example/','v2-completed-discovery',1,'completed',now()) returning id`,
      [workspaceId, companyId],
    );
    const stripeId = (
      await onboardingDb.query<{ id: string }>(
        "select id from public.dependency_catalog where slug='stripe'",
      )
    ).rows[0]!.id;
    const candidate = await onboardingDb.query<{ id: string }>(
      `insert into public.discovered_dependencies(workspace_id,company_id,dependency_id,confidence,confidence_label,evidence_summary)
       values($1,$2,$3,0.8,'high','[]'::jsonb) returning id`,
      [workspaceId, companyId, stripeId],
    );
    expect(secondRun.rows).toHaveLength(1);
    expect(candidate.rows).toHaveLength(1);
    await onboardingDb.exec("reset role; set role authenticated");
    for (const stage of [
      "company",
      "product",
      "discovery",
      "dependency_confirmation",
      "protection_graph",
      "strengthen_protection",
      "activation",
    ]) {
      if (stage === "activation") {
        await expect(
          onboardingDb.query("select public.transition_product_onboarding_v2($1,$2,$3)", [
            workspaceId,
            secondProductId,
            stage,
          ]),
        ).rejects.toThrow(/review_pending_candidates/);
        expect(
          (
            await onboardingDb.query(
              "select id from public.workspace_dependencies where workspace_id=$1 and protected_product_id=$2",
              [workspaceId, secondProductId],
            )
          ).rows,
        ).toHaveLength(1);
        await onboardingDb.exec("reset role; set role service_role");
        await onboardingDb.query(
          "update public.discovered_dependencies set status='rejected' where id=$1",
          [candidate.rows[0]!.id],
        );
        await onboardingDb.exec("reset role; set role authenticated");
      }
      await onboardingDb.query("select public.transition_product_onboarding_v2($1,$2,$3)", [
        workspaceId,
        secondProductId,
        stage,
      ]);
    }
    const secondActivation = await onboardingDb.query<{ value: { productId: string } }>(
      "select public.activate_product_protection_v2($1,$2) as value",
      [workspaceId, secondProductId],
    );
    expect(secondActivation.rows[0]!.value.productId).toBe(secondProductId);
    const productDependencies = (
      await onboardingDb.query<{ monitoring_enabled: boolean; protected_product_id: string }>(
        "select monitoring_enabled,protected_product_id from public.workspace_dependencies where workspace_id=$1 order by protected_product_id",
        [workspaceId],
      )
    ).rows;
    expect(productDependencies).toHaveLength(2);
    expect(productDependencies.every((dependency) => dependency.monitoring_enabled)).toBe(true);
    expect(productDependencies.map((dependency) => dependency.protected_product_id).sort()).toEqual(
      [productId, secondProductId].sort(),
    );
    expect(
      (
        await onboardingDb.query(
          "select workspace_id from public.workspace_subscriptions where workspace_id=$1",
          [workspaceId],
        )
      ).rows,
    ).toHaveLength(1);

    await onboardingDb.exec("reset role");
    await onboardingDb.query("select set_config('request.jwt.claim.sub',$1,false)", [outsider]);
    await onboardingDb.exec("set role authenticated");
    expect(
      (
        await onboardingDb.query(
          "select * from public.product_onboarding_progress where workspace_id=$1",
          [workspaceId],
        )
      ).rows,
    ).toHaveLength(0);
    await expect(
      onboardingDb.query("select public.start_product_onboarding_v2($1,$2)", [
        workspaceId,
        productId,
      ]),
    ).rejects.toThrow();
    await expect(
      onboardingDb.query(
        "insert into public.product_onboarding_progress(workspace_id,product_id,company_id) values($1,$2,$3)",
        [workspaceId, productId, companyId],
      ),
    ).rejects.toThrow();
    await onboardingDb.exec("reset role; set role anon");
    await expect(
      onboardingDb.query("select * from public.product_onboarding_progress"),
    ).rejects.toThrow();
    await onboardingDb.close();
  });
});

describe("M15.7 deployment migration", () => {
  it("adds tenant-scoped deployment tables with RLS and no anonymous access", async () => {
    const db = await makeDatabase();
    const tables = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      anon_select: boolean;
      authenticated_select: boolean;
      authenticated_insert: boolean;
      authenticated_update: boolean;
      authenticated_delete: boolean;
      authenticated_truncate: boolean;
    }>(`
      select c.relname,c.relrowsecurity,
        has_table_privilege('anon',format('public.%I',c.relname),'select') as anon_select,
        has_table_privilege('authenticated',format('public.%I',c.relname),'select') as authenticated_select,
        has_table_privilege('authenticated',format('public.%I',c.relname),'insert') as authenticated_insert,
        has_table_privilege('authenticated',format('public.%I',c.relname),'update') as authenticated_update,
        has_table_privilege('authenticated',format('public.%I',c.relname),'delete') as authenticated_delete,
        has_table_privilege('authenticated',format('public.%I',c.relname),'truncate') as authenticated_truncate
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname in (
        'deployment_surfaces','workspace_product_deployment_surfaces',
        'deployment_observations','deployment_sync_attempts','product_deployment_evidence'
      ) order by c.relname
    `);
    expect(tables.rows).toHaveLength(5);
    expect(tables.rows.every((row) => row.relrowsecurity)).toBe(true);
    expect(tables.rows.every((row) => !row.anon_select && row.authenticated_select)).toBe(true);
    expect(
      tables.rows.every(
        (row) =>
          !row.authenticated_insert &&
          !row.authenticated_update &&
          !row.authenticated_delete &&
          !row.authenticated_truncate,
      ),
    ).toBe(true);
    const catalog = await db.query<{ provider: string; capability: string }>(`
      select p.provider,c.capability from public.connector_providers p
      join public.connector_provider_capabilities c using(provider) where p.provider='vercel'
    `);
    expect(catalog.rows).toEqual([
      { provider: "vercel", capability: "CAN_READ_DEPLOYMENT_CONTEXT" },
    ]);
    const constraints = await db.query<{ table_name: string; constraint_name: string }>(`
      select tc.table_name,tc.constraint_name from information_schema.table_constraints tc
      where tc.table_schema='public' and tc.constraint_type='FOREIGN KEY'
        and tc.table_name in ('deployment_surfaces','workspace_product_deployment_surfaces','deployment_observations','product_deployment_evidence')
    `);
    expect(constraints.rows.length).toBeGreaterThanOrEqual(10);
    const userA = "a1000000-0000-4000-8000-000000000001";
    const userB = "a1000000-0000-4000-8000-000000000002";
    const workspaceA = "a2000000-0000-4000-8000-000000000001";
    const workspaceB = "a2000000-0000-4000-8000-000000000002";
    const installationA = "a3000000-0000-4000-8000-000000000001";
    const installationB = "a3000000-0000-4000-8000-000000000002";
    await db.query(
      "insert into auth.users(id,email) values($1,'a@example.test'),($2,'b@example.test')",
      [userA, userB],
    );
    await db.query(
      "insert into public.workspaces(id,name,created_by) values($1,'A',$2),($3,'B',$4)",
      [workspaceA, userA, workspaceB, userB],
    );
    await db.query(
      "insert into public.workspace_members(workspace_id,user_id,role) values($1,$2,'owner'),($3,$4,'owner')",
      [workspaceA, userA, workspaceB, userB],
    );
    await db.exec("set role service_role");
    await db.query(
      `insert into public.connector_installations(id,workspace_id,provider,external_account_id,account_name,connected_by)
      values($1,$2,'vercel','icfg_a','Vercel A',$3),($4,$5,'vercel','icfg_b','Vercel B',$6)`,
      [installationA, workspaceA, userA, installationB, workspaceB, userB],
    );
    await db.query(
      `insert into public.deployment_surfaces(workspace_id,installation_id,external_project_id,project_name,environment_scope)
      values($1,$2,'prj_a','Project A','all'),($3,$4,'prj_b','Project B','all')`,
      [workspaceA, installationA, workspaceB, installationB],
    );
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [userA]);
    await db.exec("set role authenticated");
    const own = await db.query<{ project_name: string }>(
      "select project_name from public.deployment_surfaces where workspace_id=$1",
      [workspaceA],
    );
    const crossTenant = await db.query(
      "select * from public.deployment_surfaces where workspace_id=$1",
      [workspaceB],
    );
    expect(own.rows.map((row) => row.project_name)).toEqual(["Project A"]);
    expect(crossTenant.rows).toHaveLength(0);
    await db.exec("reset role; set role anon");
    await expect(db.query("select * from public.deployment_surfaces")).rejects.toThrow();
    await db.close();
  });
});
