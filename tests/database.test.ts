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
      "select public.begin_source_change_classification($1,'classifier-run-1',1,'semantic-v1',1,'materiality-v1','ai-gateway') as value",
      [changeId],
    );
    const classificationPacket = classificationStart.rows[0]!.value;
    expect(classificationPacket).toMatchObject({ status: "processing", changeId });
    expect(classificationPacket).not.toHaveProperty("tenantContext");
    const evidenceFingerprint = classificationPacket.evidenceFingerprint;
    const classification = await db.query<{ value: Record<string, unknown> }>(
      `select public.record_source_change_classification(
        $1,'semantic-v1',$2,'classifier-run-1',1,'ai-gateway','fixture/model',1,'materiality-v1',true,
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
      "select public.begin_source_change_classification($1,'classifier-run-2',1,'semantic-v1',1,'materiality-v1','ai-gateway') as value",
      [changeId],
    );
    expect(replayedClassification.rows[0]!.value).toMatchObject({
      status: "classified",
      classification: { material: true, category: "api_change" },
      replayed: true,
    });

    const v2 = await db.query<{ value: Record<string, unknown> }>(
      `select public.begin_source_change_classification($1,'classifier-run-v2',1,'semantic-v2',2,'materiality-v2','ai-gateway') as value`,
      [changeId],
    );
    expect(v2.rows[0]!.value).toMatchObject({
      status: "processing",
      classifierVersion: "semantic-v2",
    });
    await db.query(
      `select public.record_source_change_classification(
        $1,'semantic-v2',$2,'classifier-run-v2',1,'ai-gateway','fixture/model-v2',2,'materiality-v2',true,
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
});
