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
const onboardingMigration = await readFile(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20261004030000_onboarding_activation_backend.sql",
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
    create table auth.users (id uuid primary key);
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
  await db.exec(onboardingMigration);
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
        '[{"provider_slug":"stripe","confidence":0.72,"confidence_label":"medium","evidence_summary":[{"signatureKey":"stripe-js-v3"}]}]'::jsonb
      )`,
      [run.rows[0]!.id, workspaceId, companyId],
    );
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
});
