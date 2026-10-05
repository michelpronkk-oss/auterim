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
const productMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261021000000_m15_protected_product_entitlements.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);
const m15FollowupMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261022000000_m15_product_scoped_dependencies_and_idempotency.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

async function database(includeProducts = true) {
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
  if (includeProducts) {
    await db.exec(productMigration);
    await db.exec(m15FollowupMigration);
  }
  return db;
}

let ownerSequence = 1;
const outsiderId = "99999999-9999-4999-8999-999999999999";
const dbs: PGlite[] = [];

async function newWorkspace(db: PGlite, slug: string, plan: "core" | "pro" | "business") {
  const ownerId = `11111111-1111-4111-8111-${String(ownerSequence++).padStart(12, "0")}`;
  await db.query("insert into auth.users(id) values ($1) on conflict do nothing", [ownerId]);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ownerId]);
  const started = await db.query<{ value: { workspaceId: string; companyId: string } }>(
    `select public.start_workspace_onboarding(
      $1,$2,$3,$4,$5,$6,null
    ) as value`,
    [
      ownerId,
      `${slug} workspace`,
      `${slug} company`,
      `https://${slug}.example/`,
      `${slug}.example`,
      `product-test-${slug}-0001`,
    ],
  );
  const workspaceId = started.rows[0]!.value.workspaceId;
  await db.query(
    `insert into public.workspace_subscriptions(workspace_id,plan,status,current_period_start,current_period_end)
     values ($1,$2,'active',now(),now()+interval '30 days')`,
    [workspaceId, plan],
  );
  return { workspaceId, companyId: started.rows[0]!.value.companyId };
}

describe("protected product entitlement foundation", () => {
  afterAll(async () => {
    await Promise.all(dbs.map((db) => db.close()));
  });

  it("backfills a default product and surface without changing dependency identity", async () => {
    const db = await database(false);
    dbs.push(db);
    const ownerId = "11111111-1111-4111-8111-111111111111";
    await db.query("insert into auth.users(id) values ($1)", [ownerId]);
    const workspace = "22222222-2222-4222-8222-222222222222";
    const company = "33333333-3333-4333-8333-333333333333";
    await db.query(
      "insert into public.workspaces(id,name,created_by) values ($1,'Legacy Workspace',$2)",
      [workspace, ownerId],
    );
    await db.query(
      "insert into public.companies(id,workspace_id,name,slug,website_url,website_domain) values ($1,$2,'Legacy Product','legacy-product','https://legacy.example/','legacy.example')",
      [company, workspace],
    );
    await db.query(
      `insert into public.workspace_onboarding(workspace_id,company_id,state)
       values ($1,$2,'dependencies_review')`,
      [workspace, company],
    );
    const legacy = await db.query<{ id: string }>(
      `insert into public.workspace_dependencies(workspace_id,dependency_id,selected_by,origin,monitoring_enabled)
       select $1,id,$2,'manual',false from public.dependency_catalog where slug='openai' returning id`,
      [workspace, ownerId],
    );
    await db.exec(productMigration);
    const linked = await db.query<{ id: string; protected_product_id: string }>(
      "select id,protected_product_id from public.workspace_dependencies where workspace_id=$1",
      [workspace],
    );
    const product = await db.query<{
      id: string;
      name: string;
      is_default: boolean;
      status: string;
    }>("select id,name,is_default,status from public.workspace_products where workspace_id=$1", [
      workspace,
    ]);
    const surface = await db.query<{ url: string; surface_type: string }>(
      "select url,surface_type from public.workspace_product_surfaces where workspace_id=$1",
      [workspace],
    );
    expect(linked.rows).toEqual([
      { id: legacy.rows[0]!.id, protected_product_id: product.rows[0]!.id },
    ]);
    expect(product.rows).toEqual([
      expect.objectContaining({ name: "Legacy Product", is_default: true, status: "draft" }),
    ]);
    expect(surface.rows).toEqual([{ url: "https://legacy.example/", surface_type: "website" }]);
  });

  it("enforces Core 1, Pro 3, and Business 10 slots while allowing many surfaces per slot", async () => {
    const db = await database();
    dbs.push(db);
    const core = await newWorkspace(db, "core-limit", "core");
    const coreLimit = await db.query<{ limit: number }>(
      "select private.workspace_product_limit($1)::int as limit",
      [core.workspaceId],
    );
    expect(coreLimit.rows[0]!.limit).toBe(1);
    await expect(
      db.query("select public.create_workspace_product($1,'Core extra','[]'::jsonb)", [
        core.workspaceId,
      ]),
    ).rejects.toThrow("product_quota_exceeded");

    const pro = await newWorkspace(db, "pro-limit", "pro");
    const proLimit = await db.query<{ limit: number }>(
      "select private.workspace_product_limit($1)::int as limit",
      [pro.workspaceId],
    );
    expect(proLimit.rows[0]!.limit).toBe(3);
    for (const name of ["Product Two", "Product Three"]) {
      await db.query(`select public.create_workspace_product($1,$2,$3::jsonb)`, [
        pro.workspaceId,
        name,
        JSON.stringify([
          {
            surfaceType: "website",
            url: `https://${name.toLowerCase().replaceAll(" ", "-")}.example/`,
          },
          {
            surfaceType: "docs",
            url: `https://docs.${name.toLowerCase().replaceAll(" ", "-")}.example/`,
          },
        ]),
      ]);
    }
    await expect(
      db.query("select public.create_workspace_product($1,'Product Four','[]'::jsonb)", [
        pro.workspaceId,
      ]),
    ).rejects.toThrow("product_quota_exceeded");
    const proCounts = await db.query<{ products: number; surfaces: number }>(
      `select (select count(*)::int from public.workspace_products where workspace_id=$1 and status<>'archived') products,
        (select count(*)::int from public.workspace_product_surfaces where workspace_id=$1) surfaces`,
      [pro.workspaceId],
    );
    expect(proCounts.rows[0]).toEqual({ products: 3, surfaces: 5 });

    const business = await newWorkspace(db, "business-limit", "business");
    const businessLimit = await db.query<{ limit: number }>(
      "select private.workspace_product_limit($1)::int as limit",
      [business.workspaceId],
    );
    expect(businessLimit.rows[0]!.limit).toBe(10);
  });

  it("attaches the onboarding company website to its default product before activation", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "preactivation-surface", "pro");
    const surfaces = await db.query<{ surface_type: string; url: string }>(
      `select surface_type,url from public.workspace_product_surfaces
       where workspace_id=$1 and product_id=(
         select id from public.workspace_products where workspace_id=$1 and is_default
       )`,
      [workspaceId],
    );
    expect(surfaces.rows).toEqual([
      { surface_type: "website", url: "https://preactivation-surface.example/" },
    ]);
  });

  it("attaches dependencies to an explicitly selected product with same-product idempotency", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "product-dependency-scope", "pro");
    await db.query("select public.create_workspace_product($1,'Second Product','[]'::jsonb)", [
      workspaceId,
    ]);
    const products = await db.query<{ id: string; is_default: boolean }>(
      "select id,is_default from public.workspace_products where workspace_id=$1 order by is_default desc",
      [workspaceId],
    );
    const first = await db.query<{ value: { workspaceDependencyId: string } }>(
      "select public.add_product_dependency_manually($1,$2,'openai') as value",
      [workspaceId, products.rows[0]!.id],
    );
    const sameProductRetry = await db.query<{ value: { workspaceDependencyId: string } }>(
      "select public.add_product_dependency_manually($1,$2,'openai') as value",
      [workspaceId, products.rows[0]!.id],
    );
    const secondProduct = await db.query<{ value: { workspaceDependencyId: string } }>(
      "select public.add_product_dependency_manually($1,$2,'openai') as value",
      [workspaceId, products.rows[1]!.id],
    );
    const rows = await db.query<{ protected_product_id: string; id: string }>(
      "select protected_product_id,id from public.workspace_dependencies where workspace_id=$1 and dependency_id=(select id from public.dependency_catalog where slug='openai') order by protected_product_id",
      [workspaceId],
    );
    expect(sameProductRetry.rows[0]!.value.workspaceDependencyId).toBe(
      first.rows[0]!.value.workspaceDependencyId,
    );
    expect(secondProduct.rows[0]!.value.workspaceDependencyId).not.toBe(
      first.rows[0]!.value.workspaceDependencyId,
    );
    expect(rows.rows).toHaveLength(2);
    expect(new Set(rows.rows.map((row) => row.protected_product_id))).toEqual(
      new Set(products.rows.map((product) => product.id)),
    );
  });

  it("replays product creation by idempotency key and rejects changed payloads", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "product-idempotency", "pro");
    const args = [workspaceId, "Console", JSON.stringify([]), null, "create-console-001"];
    const created = await db.query<{ value: { product: { id: string } } }>(
      "select public.create_workspace_product_idempotent($1,$2,$3::jsonb,$4,$5) as value",
      args,
    );
    const retry = await db.query<{ value: { product: { id: string } } }>(
      "select public.create_workspace_product_idempotent($1,$2,$3::jsonb,$4,$5) as value",
      args,
    );
    expect(retry.rows[0]!.value.product.id).toBe(created.rows[0]!.value.product.id);
    await expect(
      db.query("select public.create_workspace_product_idempotent($1,$2,$3::jsonb,$4,$5)", [
        workspaceId,
        "Different payload",
        JSON.stringify([]),
        null,
        "create-console-001",
      ]),
    ).rejects.toThrow("product_idempotency_key_reused");
    const count = await db.query<{ count: number }>(
      "select count(*)::int as count from public.workspace_products where workspace_id=$1",
      [workspaceId],
    );
    expect(count.rows[0]!.count).toBe(2);
  });

  it("confirms a discovery candidate for one product and retains its provenance", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId, companyId } = await newWorkspace(db, "product-candidate", "pro");
    await db.query("select public.create_workspace_product($1,'Second Product','[]'::jsonb)", [
      workspaceId,
    ]);
    const products = await db.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 order by is_default desc",
      [workspaceId],
    );
    const candidate = await db.query<{ id: string }>(
      `insert into public.discovered_dependencies
        (workspace_id,company_id,dependency_id,confidence,confidence_label,evidence_summary)
       select $1,$2,id,0.9,'high','[]'::jsonb from public.dependency_catalog where slug='vercel'
       returning id`,
      [workspaceId, companyId],
    );
    const confirmedFirst = await db.query<{
      value: { workspaceDependencyId: string; productId: string; decision: string };
    }>("select public.decide_product_dependency_candidate($1,$2,$3,'confirmed') as value", [
      workspaceId,
      products.rows[0]!.id,
      candidate.rows[0]!.id,
    ]);
    const confirmed = await db.query<{
      value: { workspaceDependencyId: string; productId: string; decision: string };
    }>("select public.decide_product_dependency_candidate($1,$2,$3,'confirmed') as value", [
      workspaceId,
      products.rows[1]!.id,
      candidate.rows[0]!.id,
    ]);
    const retry = await db.query<{
      value: { workspaceDependencyId: string; productId: string; decision: string };
    }>("select public.decide_product_dependency_candidate($1,$2,$3,'confirmed') as value", [
      workspaceId,
      products.rows[1]!.id,
      candidate.rows[0]!.id,
    ]);
    const history = await db.query<{ status: string; links: number }>(
      `select candidate.status,
        (select count(*)::int from public.workspace_dependency_discovery_links link
         where link.discovered_dependency_id=candidate.id) as links
       from public.discovered_dependencies candidate where candidate.id=$1`,
      [candidate.rows[0]!.id],
    );
    expect(confirmed.rows[0]!.value.productId).toBe(products.rows[1]!.id);
    expect(retry.rows[0]!.value.workspaceDependencyId).toBe(
      confirmed.rows[0]!.value.workspaceDependencyId,
    );
    expect(confirmedFirst.rows[0]!.value.workspaceDependencyId).not.toBe(
      confirmed.rows[0]!.value.workspaceDependencyId,
    );
    expect(history.rows).toEqual([{ status: "confirmed", links: 2 }]);
  });

  it("denies cross-workspace product dependencies and nonmembers", async () => {
    const db = await database();
    dbs.push(db);
    const first = await newWorkspace(db, "product-dependency-owner", "pro");
    const second = await newWorkspace(db, "product-dependency-other", "pro");
    const secondProduct = await db.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 limit 1",
      [second.workspaceId],
    );
    const firstOwner = await db.query<{ user_id: string }>(
      "select user_id from public.workspace_members where workspace_id=$1 and role='owner'",
      [first.workspaceId],
    );
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      firstOwner.rows[0]!.user_id,
    ]);
    await expect(
      db.query("select public.add_product_dependency_manually($1,$2,'openai')", [
        first.workspaceId,
        secondProduct.rows[0]!.id,
      ]),
    ).rejects.toThrow("product_not_found");
    await db.query("insert into auth.users(id) values ($1)", [outsiderId]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsiderId]);
    await expect(
      db.query("select public.add_product_dependency_manually($1,$2,'openai')", [
        first.workspaceId,
        secondProduct.rows[0]!.id,
      ]),
    ).rejects.toThrow("Workspace is not available");
  });

  it("grants only authenticated execution of product operations and keeps idempotency rows private", async () => {
    const db = await database();
    dbs.push(db);
    const privileges = await db.query<{
      add_allowed: boolean;
      read_allowed: boolean;
      anon_add_allowed: boolean;
      anon_table_read: boolean;
      authenticated_table_read: boolean;
    }>(`
      select
        has_function_privilege('authenticated','public.add_product_dependency_manually(uuid,uuid,text)','EXECUTE') as add_allowed,
        has_function_privilege('authenticated','public.get_product_dependencies(uuid,uuid)','EXECUTE') as read_allowed,
        has_function_privilege('anon','public.add_product_dependency_manually(uuid,uuid,text)','EXECUTE') as anon_add_allowed,
        has_table_privilege('anon','private.workspace_product_requests','SELECT') as anon_table_read,
        has_table_privilege('authenticated','private.workspace_product_requests','SELECT') as authenticated_table_read
    `);
    expect(privileges.rows[0]).toEqual({
      add_allowed: true,
      read_allowed: true,
      anon_add_allowed: false,
      anon_table_read: false,
      authenticated_table_read: false,
    });
  });

  it("serializes concurrent same-key product creation retries to one product", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "product-idempotency-concurrent", "pro");
    const query = () =>
      db.query<{ value: { product: { id: string } } }>(
        "select public.create_workspace_product_idempotent($1,$2,$3::jsonb,$4,$5) as value",
        [workspaceId, "Concurrent Console", JSON.stringify([]), null, "concurrent-console-01"],
      );
    const [first, second] = await Promise.all([query(), query()]);
    expect(first.rows[0]!.value.product.id).toBe(second.rows[0]!.value.product.id);
    const count = await db.query<{ count: number }>(
      "select count(*)::int as count from public.workspace_products where workspace_id=$1",
      [workspaceId],
    );
    expect(count.rows[0]!.count).toBe(2);
  });

  it("preserves history on replace/archive and continues attaching legacy onboarding dependencies to the default", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "replace-flow", "core");
    const defaultProduct = await db.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 and is_default",
      [workspaceId],
    );
    const added = await db.query<{ value: { workspaceDependencyId: string } }>(
      "select public.add_onboarding_dependency_manually($1,'openai') as value",
      [workspaceId],
    );
    const originalDependencyId = added.rows[0]!.value.workspaceDependencyId;
    await db.query("update public.workspace_dependencies set monitoring_enabled=true where id=$1", [
      originalDependencyId,
    ]);
    const replacement = await db.query<{
      value: { product: { id: string }; replacedProductId: string };
    }>("select public.create_workspace_product($1,'Replacement','[]'::jsonb,$2) as value", [
      workspaceId,
      defaultProduct.rows[0]!.id,
    ]);
    const retired = await db.query<{ status: string; archived_at: string | null }>(
      "select status,archived_at from public.workspace_products where id=$1",
      [defaultProduct.rows[0]!.id],
    );
    const oldDependency = await db.query<{
      protected_product_id: string;
      monitoring_enabled: boolean;
    }>(
      "select protected_product_id,monitoring_enabled from public.workspace_dependencies where id=$1",
      [originalDependencyId],
    );
    const currentDefault = await db.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 and is_default",
      [workspaceId],
    );
    expect(replacement.rows[0]!.value.replacedProductId).toBe(defaultProduct.rows[0]!.id);
    expect(retired.rows[0]).toMatchObject({ status: "archived" });
    expect(retired.rows[0]!.archived_at).not.toBeNull();
    expect(oldDependency.rows[0]).toEqual({
      protected_product_id: defaultProduct.rows[0]!.id,
      monitoring_enabled: false,
    });
    expect(currentDefault.rows[0]!.id).toBe(replacement.rows[0]!.value.product.id);
    expect(
      await db.query("select id from public.workspace_dependencies where id=$1", [
        originalDependencyId,
      ]),
    ).toMatchObject({
      rows: [{ id: originalDependencyId }],
    });
    expect(
      await db.query("select private.workspace_product_limit($1)::int as limit", [workspaceId]),
    ).toMatchObject({
      rows: [{ limit: 1 }],
    });
  });

  it("archives a default product and promotes its successor without violating uniqueness", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "archive-default", "pro");
    const defaults = await db.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 and is_default",
      [workspaceId],
    );
    const successor = await db.query<{ value: { product: { id: string } } }>(
      "select public.create_workspace_product($1,'Second Product','[]'::jsonb) as value",
      [workspaceId],
    );

    const archived = await db.query<{ value: { status: string } }>(
      "select public.archive_workspace_product($1,$2) as value",
      [workspaceId, defaults.rows[0]!.id],
    );
    const currentDefaults = await db.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 and is_default",
      [workspaceId],
    );
    const oldProduct = await db.query<{ status: string; is_default: boolean }>(
      "select status,is_default from public.workspace_products where id=$1",
      [defaults.rows[0]!.id],
    );

    expect(archived.rows[0]!.value.status).toBe("archived");
    expect(currentDefaults.rows).toEqual([{ id: successor.rows[0]!.value.product.id }]);
    expect(oldProduct.rows).toEqual([{ status: "archived", is_default: false }]);
  });

  it("makes an archived product ineligible for future Preflight claims", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "preflight-archive", "pro");
    const product = await db.query<{ id: string }>(
      "select id from public.workspace_products where workspace_id=$1 and is_default",
      [workspaceId],
    );
    const dependency = await db.query<{ value: { workspaceDependencyId: string } }>(
      "select public.add_onboarding_dependency_manually($1,'openai') as value",
      [workspaceId],
    );
    await db.query("update public.workspace_products set status='protected' where id=$1", [
      product.rows[0]!.id,
    ]);
    await db.query("update public.workspace_dependencies set monitoring_enabled=true where id=$1", [
      dependency.rows[0]!.value.workspaceDependencyId,
    ]);
    await expect(
      db.query("select private.preflight_dependency_is_active($1,$2) as active", [
        workspaceId,
        dependency.rows[0]!.value.workspaceDependencyId,
      ]),
    ).resolves.toMatchObject({ rows: [{ active: true }] });

    await db.query("select public.create_workspace_product($1,'Successor','[]'::jsonb)", [
      workspaceId,
    ]);
    await db.query("select public.archive_workspace_product($1,$2)", [
      workspaceId,
      product.rows[0]!.id,
    ]);
    await expect(
      db.query("select private.preflight_dependency_is_active($1,$2) as active", [
        workspaceId,
        dependency.rows[0]!.value.workspaceDependencyId,
      ]),
    ).resolves.toMatchObject({ rows: [{ active: false }] });
  });

  it("restricts product RPC mutations to workspace owners/admins and prevents cross-workspace writes", async () => {
    const db = await database();
    dbs.push(db);
    const { workspaceId } = await newWorkspace(db, "product-auth", "pro");
    await db.query("insert into auth.users(id) values ($1)", [outsiderId]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsiderId]);
    await expect(
      db.query("select public.create_workspace_product($1,'Unauthorized','[]'::jsonb)", [
        workspaceId,
      ]),
    ).rejects.toThrow("owner_or_admin_required");
    await expect(
      db.query("select public.archive_workspace_product($1,$2)", [
        workspaceId,
        "00000000-0000-4000-8000-000000000099",
      ]),
    ).rejects.toThrow("owner_or_admin_required");
  });

  it("limits authenticated product reads by membership and withholds direct writes", async () => {
    const db = await database();
    dbs.push(db);
    const first = await newWorkspace(db, "rls-first", "pro");
    const second = await newWorkspace(db, "rls-second", "pro");
    const firstOwner = await db.query<{ user_id: string }>(
      "select user_id from public.workspace_members where workspace_id=$1 and role='owner'",
      [first.workspaceId],
    );

    await db.query("set role authenticated");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      firstOwner.rows[0]!.user_id,
    ]);
    const memberProducts = await db.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_products order by workspace_id",
    );
    expect(memberProducts.rows).toEqual([{ workspace_id: first.workspaceId }]);
    await expect(
      db.query(
        "insert into public.workspace_products(workspace_id,name,slug) values ($1,'Forged','forged')",
        [first.workspaceId],
      ),
    ).rejects.toThrow();

    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [outsiderId]);
    const outsiderProducts = await db.query<{ workspace_id: string }>(
      "select workspace_id from public.workspace_products where workspace_id=$1",
      [second.workspaceId],
    );
    expect(outsiderProducts.rows).toEqual([]);
    await db.query("reset role");
  });
});
