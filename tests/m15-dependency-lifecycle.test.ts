import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";

const migrationNames = [
  "20261002232050_auterim_monitoring_foundation.sql",
  "20261003010000_semantic_change_classification.sql",
  "20261004010000_customer_impact_intelligence.sql",
  "20261004020000_url_dependency_discovery.sql",
  "20261004030000_onboarding_activation_backend.sql",
  "20261011010000_preserve_partial_discovery.sql",
  "20261011020000_discovery_outcome_consistency.sql",
  "20261005000000_preflight_breakage_prevention.sql",
  "20261005010000_preflight_claim_privilege_hardening.sql",
  "20261006000000_auth_accounts_billing_entitlements.sql",
  "20261007000000_protection_value_notifications.sql",
  "20261012000000_runtime_dependency_discovery.sql",
  "20261013000000_prevent_implicit_multiple_onboarding_workspaces.sql",
  "20261018000000_launch_provider_catalog_breadth.sql",
  "20261019000000_provider_monitoring_coverage_wave.sql",
  "20261020000000_m15_production_hardening.sql",
];
const migrations = await Promise.all(
  migrationNames.map((name) =>
    readFile(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url)), "utf8"),
  ),
);
const productMigrations = await Promise.all(
  [
    "20261021000000_m15_protected_product_entitlements.sql",
    "20261022000000_m15_product_scoped_dependencies_and_idempotency.sql",
    "20261024020000_m15_dependency_lifecycle.sql",
  ].map((name) =>
    readFile(fileURLToPath(new URL(`../supabase/migrations/${name}`, import.meta.url)), "utf8"),
  ),
);

const ownerId = "11111111-1111-4111-8111-111111111111";
const outsiderId = "99999999-9999-4999-8999-999999999999";
const dbs: PGlite[] = [];

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
  for (const migration of productMigrations) await db.exec(migration);
  dbs.push(db);
  return db;
}

async function createProtectedDependency(db: PGlite) {
  await db.query("insert into auth.users(id) values ($1),($2)", [ownerId, outsiderId]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
  const onboarding = await db.query<{ value: { workspaceId: string } }>(
    `select public.start_workspace_onboarding(
      $1,'Lifecycle workspace','Lifecycle company','https://lifecycle.example/','lifecycle.example',
      'lifecycle-start-request-0001',null
    ) as value`,
    [ownerId],
  );
  const workspaceId = onboarding.rows[0]!.value.workspaceId;
  const product = await db.query<{ id: string }>(
    `update public.workspace_products set status='protected',protected_at=now()
     where workspace_id=$1 and is_default returning id`,
    [workspaceId],
  );
  const dependency = await db.query<{ id: string }>(
    `insert into public.workspace_dependencies
       (workspace_id,protected_product_id,dependency_id,selected_by,origin,monitoring_enabled,protection_started_at)
     select $1,$2,catalog.id,$3,'manual',true,now()
     from public.dependency_catalog catalog where catalog.slug='openai' returning id`,
    [workspaceId, product.rows[0]!.id, ownerId],
  );
  await db.query(
    `insert into public.dependency_context(workspace_id,workspace_dependency_id,criticality,used_for,context_note)
     values ($1,$2,'critical','["AI processing"]'::jsonb,'lifecycle evidence retained')`,
    [workspaceId, dependency.rows[0]!.id],
  );
  return { workspaceId, productId: product.rows[0]!.id, dependencyId: dependency.rows[0]!.id };
}

describe("M15 dependency lifecycle migration", () => {
  afterAll(async () => {
    await Promise.all(dbs.map((db) => db.close()));
  });

  it("lets an owner disable one dependency idempotently while preserving its context and identity", async () => {
    const db = await database();
    const fixture = await createProtectedDependency(db);

    const first = await db.query<{ result: Record<string, unknown> }>(
      `select public.disable_workspace_dependency($1,$2) as result`,
      [fixture.workspaceId, fixture.dependencyId],
    );
    const second = await db.query<{ result: Record<string, unknown> }>(
      `select public.disable_workspace_dependency($1,$2) as result`,
      [fixture.workspaceId, fixture.dependencyId],
    );
    const persisted = await db.query<{
      id: string;
      monitoring_enabled: boolean;
      context_note: string;
      criticality: string;
    }>(
      `select dependency.id,dependency.monitoring_enabled,context.context_note,context.criticality
       from public.workspace_dependencies dependency
       join public.dependency_context context on context.workspace_dependency_id=dependency.id
       where dependency.workspace_id=$1 and dependency.id=$2`,
      [fixture.workspaceId, fixture.dependencyId],
    );

    expect(first.rows[0]!.result).toMatchObject({
      workspaceId: fixture.workspaceId,
      workspaceDependencyId: fixture.dependencyId,
      monitoringEnabled: false,
      changed: true,
    });
    expect(second.rows[0]!.result).toMatchObject({ monitoringEnabled: false, changed: false });
    expect(persisted.rows).toEqual([
      {
        id: fixture.dependencyId,
        monitoring_enabled: false,
        context_note: "lifecycle evidence retained",
        criticality: "critical",
      },
    ]);
  });

  it("denies members and unrelated users and prevents direct authenticated table updates", async () => {
    const db = await database();
    const fixture = await createProtectedDependency(db);
    const memberId = "88888888-8888-4888-8888-888888888888";
    await db.query("insert into auth.users(id) values ($1)", [memberId]);
    await db.query(
      "insert into public.workspace_members(workspace_id,user_id,role) values ($1,$2,'member')",
      [fixture.workspaceId, memberId],
    );

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [memberId]);
    await expect(
      db.query("select public.disable_workspace_dependency($1,$2)", [
        fixture.workspaceId,
        fixture.dependencyId,
      ]),
    ).rejects.toThrow("owner_or_admin_required");

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsiderId]);
    await expect(
      db.query("select public.disable_workspace_dependency($1,$2)", [
        fixture.workspaceId,
        fixture.dependencyId,
      ]),
    ).rejects.toThrow("owner_or_admin_required");

    await db.query("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
    await expect(
      db.query("update public.workspace_dependencies set monitoring_enabled=false where id=$1", [
        fixture.dependencyId,
      ]),
    ).rejects.toThrow();
  });

  it("does not allow disabling a dependency by supplying another workspace id", async () => {
    const db = await database();
    const fixture = await createProtectedDependency(db);
    await expect(
      db.query("select public.disable_workspace_dependency($1,$2)", [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        fixture.dependencyId,
      ]),
    ).rejects.toThrow("owner_or_admin_required");

    const state = await db.query<{ monitoring_enabled: boolean }>(
      "select monitoring_enabled from public.workspace_dependencies where id=$1",
      [fixture.dependencyId],
    );
    expect(state.rows[0]!.monitoring_enabled).toBe(true);
  });
});
