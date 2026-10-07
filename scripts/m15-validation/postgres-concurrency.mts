import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local-only independent PostgreSQL session race helper for M15 acceptance.
 *
 * This module intentionally accepts only repository-owned, reviewed scalar SELECT
 * statements. Never pass SQL assembled from user input. It uses two separate
 * `docker exec ... psql` backends and never reads, accepts, or prints a password.
 *
 * Authenticated-session example (replace placeholders with UUIDs returned by the
 * canonical local QA fixture setup; this comment is illustrative, not executable):
 *
 * ```ts
 * await runIndependentPostgresRace({
 *   workspaceId: "<fixture-workspace-uuid>",
 *   barrier: { kind: "workspace_row", workspaceId: "<fixture-workspace-uuid>" },
 *   operations: [
 *     {
 *       name: "product-request-a",
 *       session: { role: "authenticated", userId: "<owner-user-uuid>" },
 *       sql: "select public.create_workspace_product_idempotent('<workspace-uuid>', 'QA product', '[]'::jsonb, null, '<shared-key>')::text",
 *     },
 *     {
 *       name: "product-request-b",
 *       session: { role: "authenticated", userId: "<owner-user-uuid>" },
 *       sql: "select public.create_workspace_product_idempotent('<workspace-uuid>', 'QA product', '[]'::jsonb, null, '<shared-key>')::text",
 *     },
 *   ],
 * });
 * ```
 *
 * Fixture creation and assertions remain the caller's responsibility. Use the
 * same authenticated owner and idempotency key in both sessions for that race.
 */

const LOCAL_CONTAINER = "supabase_db_auterim-m15-acceptance";
const ALLOWED_LOCAL_ORIGINS = new Set([
  "http://127.0.0.1:65431",
  "http://localhost:65431",
  "http://[::1]:65431",
]);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LABEL_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 64 * 1024;

type SessionIdentity = { role: "service_role" } | { role: "authenticated"; userId: string };

export type RaceOperation = {
  name: string;
  session: SessionIdentity;
  /** One repository-owned scalar SELECT expression, without a trailing semicolon. */
  sql: string;
};

export type RaceBarrier =
  | { kind: "workspace_row"; workspaceId: string }
  | {
      kind: "row";
      table: "preflight_runs" | "remediation_preparation_queue" | "remediation_validation_queue";
      rowId: string;
    }
  | { kind: "advisory"; lockText: string; seed?: number };

export type IndependentRaceResult = {
  localTarget: "supabase_db_auterim-m15-acceptance/postgres";
  workspaceId: string;
  barrier: RaceBarrier["kind"];
  contenders: [
    {
      name: string;
      backendPid: number;
      completed: boolean;
      resultRows: number;
      nonNullRows: number;
    },
    {
      name: string;
      backendPid: number;
      completed: boolean;
      resultRows: number;
      nonNullRows: number;
    },
  ];
  bothBlockedOnHolder: true;
  sameResult: boolean;
  observedAt: string;
};

type LineWaiter = {
  marker: string;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
};

class PsqlSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pidMarker = `M15_BACKEND_PID:${randomUUID()}:`;
  private readonly waiters: LineWaiter[] = [];
  private readonly lines: string[] = [];
  private buffered = "";
  private capturedBytes = 0;
  private capturedStderr = "";
  private timedOut = false;
  private exited = false;
  private exitCode: number | null = null;
  private spawnFailure: Error | null = null;
  private readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    private readonly timeoutMs: number,
    private readonly lifetimeMs = MAX_TIMEOUT_MS,
  ) {
    const command = process.platform === "win32" ? "docker.exe" : "docker";
    this.child = spawn(
      command,
      [
        "exec",
        "-i",
        LOCAL_CONTAINER,
        "sh",
        "-c",
        'test -n "${POSTGRES_PASSWORD:-}" || exit 76; export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -X -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate -Atq -U supabase_admin -d postgres',
      ],
      { cwd: REPOSITORY_ROOT, windowsHide: true, stdio: "pipe" },
    );

    this.exitPromise = new Promise((resolve) => {
      this.child.once("error", (error) => {
        this.spawnFailure = error;
        this.failWaiters(new Error("local_postgres_process_unavailable"));
        resolve({ code: null, signal: null });
      });
      this.child.once("close", (code, signal) => {
        this.exited = true;
        this.exitCode = code;
        this.failWaiters(new Error(this.safeExitFailure(code)));
        resolve({ code, signal });
      });
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    // Provider/SQL errors can contain untrusted or sensitive detail; consume but
    // never expose stderr. The caller receives only a safe process outcome.
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (this.capturedStderr.length < 4_096) {
        this.capturedStderr += chunk.toString("utf8").slice(0, 4_096 - this.capturedStderr.length);
      }
    });
    const timeout = setTimeout(() => {
      if (!this.exited) {
        this.timedOut = true;
        this.child.kill();
      }
    }, lifetimeMs);
    timeout.unref();
    this.exitPromise.finally(() => clearTimeout(timeout));
  }

  get spawnError(): Error | null {
    return this.spawnFailure;
  }

  write(sql: string): void {
    if (this.exited || !this.child.stdin.writable) throw new Error("local_postgres_session_closed");
    this.child.stdin.write(`${sql}\n`);
  }

  async readMarker(marker: string): Promise<string> {
    const existingIndex = this.lines.findIndex((line) => line.startsWith(marker));
    if (existingIndex >= 0) return this.lines.splice(existingIndex, 1)[0]!;
    if (this.spawnFailure) throw new Error("local_postgres_process_unavailable");
    if (this.exited) throw new Error("local_postgres_session_closed");
    return await new Promise<string>((resolve, reject) => {
      const waiter: LineWaiter = { marker, resolve, reject };
      this.waiters.push(waiter);
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("local_postgres_marker_timeout"));
      }, this.timeoutMs);
      timeout.unref();
      const originalResolve = waiter.resolve;
      waiter.resolve = (line) => {
        clearTimeout(timeout);
        originalResolve(line);
      };
    });
  }

  endInput(): void {
    if (!this.child.stdin.destroyed) this.child.stdin.end();
  }

  takeLines(): string[] {
    return this.lines.splice(0);
  }

  hasPendingMarker(marker: string): boolean {
    return this.lines.some((line) => line.startsWith(marker));
  }

  safeDiagnosticState(): string {
    if (this.spawnFailure) return "process_unavailable";
    if (!this.exited) return "running";
    return this.safeExitFailure(this.exitCode).replace(/^local_postgres_/, "");
  }

  async close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.exited) {
      try {
        this.write("ROLLBACK;");
      } catch {
        // The process may have exited while cleanup was beginning.
      }
      this.endInput();
      const closed = await Promise.race([
        this.exitPromise.then(() => true),
        new Promise<false>((resolve) => {
          const timer = setTimeout(() => resolve(false), 750);
          timer.unref();
        }),
      ]);
      if (!closed && !this.exited) {
        this.child.kill();
        const forcedClose = await Promise.race([
          this.exitPromise,
          new Promise<null>((resolve) => {
            const timer = setTimeout(() => resolve(null), 1_000);
            timer.unref();
          }),
        ]);
        return forcedClose ?? { code: null, signal: null };
      }
    }
    return await this.exitPromise;
  }

  private onData(chunk: Buffer): void {
    this.capturedBytes += chunk.byteLength;
    if (this.capturedBytes > MAX_CAPTURE_BYTES) {
      this.child.kill();
      this.failWaiters(new Error("local_postgres_output_bound_exceeded"));
      return;
    }
    this.buffered += chunk.toString("utf8");
    const available = this.buffered.split(/\r?\n/);
    this.buffered = available.pop() ?? "";
    for (const line of available) this.acceptLine(line);
  }

  private acceptLine(line: string): void {
    const index = this.waiters.findIndex((waiter) => line.startsWith(waiter.marker));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      waiter!.resolve(line);
      return;
    }
    this.lines.push(line);
  }

  private failWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  private safeExitFailure(code: number | null): string {
    if (this.timedOut) return "local_postgres_session_timeout";
    if (this.capturedStderr.includes("ERROR:") || this.capturedStderr.includes("FATAL:")) {
      const sqlState = this.capturedStderr.match(/(?:ERROR|FATAL):\s*([0-9A-Z]{5})\b/)?.[1];
      return sqlState
        ? `local_postgres_sqlstate_${sqlState.toLowerCase()}`
        : "local_postgres_sql_error";
    }
    if (code === 0) return "local_postgres_session_closed";
    return "local_postgres_process_exit";
  }
}

function assertUuid(value: string, code: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(code);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeErrorCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return /^[a-z0-9_]{1,100}$/.test(error.message) ? error.message : "unknown";
}

function assertOperation(operation: RaceOperation): void {
  if (!LABEL_PATTERN.test(operation.name)) throw new Error("invalid_race_operation_name");
  const sql = operation.sql.trim();
  if (
    sql.length === 0 ||
    sql.length > 8_192 ||
    !/^select\b/i.test(sql) ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(sql) ||
    /--|\/\*|\*\//.test(sql) ||
    /;/.test(sql)
  ) {
    throw new Error("race_operation_must_be_one_vetted_select");
  }
  if (operation.session.role === "authenticated")
    assertUuid(operation.session.userId, "invalid_race_user_id");
}

function sessionSetupSql(session: SessionIdentity, timeoutMs: number): string {
  const statements = [
    "BEGIN",
    `SET LOCAL statement_timeout = ${Math.ceil(timeoutMs * 1.8)}`,
    `SET LOCAL lock_timeout = ${Math.ceil(timeoutMs * 1.5)}`,
    `SET LOCAL ROLE ${session.role}`,
    `SELECT set_config('request.jwt.claim.role', ${sqlLiteral(session.role)}, true)`,
  ];
  if (session.role === "authenticated") {
    const claims = JSON.stringify({ sub: session.userId, role: "authenticated" });
    statements.push(
      `SELECT set_config('request.jwt.claim.sub', ${sqlLiteral(session.userId)}, true)`,
      `SELECT set_config('request.jwt.claims', ${sqlLiteral(claims)}, true)`,
    );
  }
  return `${statements.join(";\n")};`;
}

function barrierSql(workspaceId: string, barrier: RaceBarrier, timeoutMs: number): string {
  const prefix = `BEGIN; SET LOCAL statement_timeout = ${Math.ceil(timeoutMs * 1.8)};`;
  if (barrier.kind === "workspace_row") {
    assertUuid(barrier.workspaceId, "invalid_barrier_workspace_id");
    if (barrier.workspaceId !== workspaceId) throw new Error("race_barrier_workspace_mismatch");
    return `${prefix} SELECT id FROM public.workspaces WHERE id = '${workspaceId}' FOR UPDATE; SELECT 'M15_HOLDER_READY';`;
  }
  if (barrier.kind === "row") {
    assertUuid(barrier.rowId, "invalid_barrier_row_id");
    const allowedTables = new Set([
      "preflight_runs",
      "remediation_preparation_queue",
      "remediation_validation_queue",
    ]);
    if (!allowedTables.has(barrier.table)) throw new Error("unsupported_race_barrier_table");
    return `${prefix} SELECT id FROM public.${barrier.table} WHERE id = '${barrier.rowId}' FOR UPDATE; SELECT 'M15_HOLDER_READY';`;
  }
  if (!Number.isSafeInteger(barrier.seed ?? 0)) throw new Error("invalid_advisory_barrier_seed");
  if (barrier.lockText.length === 0 || barrier.lockText.length > 512)
    throw new Error("invalid_advisory_barrier_text");
  return `${prefix} SELECT pg_advisory_xact_lock(hashtextextended(${sqlLiteral(barrier.lockText)}, ${barrier.seed ?? 0})); SELECT 'M15_HOLDER_READY';`;
}

async function dockerRead(args: string[], timeoutMs: number): Promise<string> {
  return await new Promise((resolve, reject) => {
    const command = process.platform === "win32" ? "docker.exe" : "docker";
    const child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_CAPTURE_BYTES) child.kill();
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("local_docker_unavailable"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > MAX_CAPTURE_BYTES)
        reject(new Error("local_target_guard_failed"));
      else resolve(output.trim());
    });
  });
}

async function assertLocalTarget(workspaceId: string): Promise<void> {
  const cwd = path.resolve(process.cwd());
  if (cwd !== REPOSITORY_ROOT) throw new Error("auterim_repository_root_required");
  const manifest = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, "package.json"), "utf8"),
  ) as {
    name?: unknown;
  };
  if (manifest.name !== "auterim") throw new Error("auterim_repository_identity_required");
  assertUuid(workspaceId, "invalid_fixture_workspace_id");
  if (process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1")
    throw new Error("m15_local_integration_guard_required");
  const localUrl = process.env.AUTERIM_M15_LOCAL_SUPABASE_URL;
  if (!localUrl || !ALLOWED_LOCAL_ORIGINS.has(localUrl))
    throw new Error("m15_local_supabase_url_required");
  const dockerContext = await dockerRead(["context", "show"], 3_000);
  if (dockerContext !== "desktop-linux") throw new Error("local_docker_context_required");

  const inspect = await dockerRead(
    [
      "inspect",
      "--format",
      '{{.Name}}|{{.State.Running}}|{{index .Config.Labels "com.supabase.cli.project"}}',
      LOCAL_CONTAINER,
    ],
    3_000,
  );
  if (inspect !== `/supabase_db_auterim-m15-acceptance|true|auterim-m15-acceptance`)
    throw new Error("exact_m15_local_supabase_container_required");

  const localConfig = await readFile(
    path.join(REPOSITORY_ROOT, "node_modules", ".cache", "m15-local", "supabase", "config.toml"),
    "utf8",
  );
  if (
    !localConfig.includes('project_id = "auterim-m15-acceptance"') ||
    !/^port = 65431$/m.test(localConfig.slice(0, localConfig.indexOf("[db]"))) ||
    !/^port = 65432$/m.test(localConfig.slice(localConfig.indexOf("[db]")))
  ) {
    throw new Error("exact_m15_local_supabase_config_required");
  }

  const probe = new PsqlSession(3_000);
  try {
    probe.write("SELECT 'M15_LOCAL_DB_GUARD:' || current_database() || ':' || current_user;");
    const line = await probe.readMarker("M15_LOCAL_DB_GUARD:");
    if (line !== "M15_LOCAL_DB_GUARD:postgres:supabase_admin")
      throw new Error("exact_m15_local_database_required");
  } finally {
    await probe.close();
  }
}

function contenderSetupSql(operation: RaceOperation, marker: string, timeoutMs: number): string {
  const setup = sessionSetupSql(operation.session, timeoutMs);
  return `${setup}\nSELECT '${marker}' || pg_backend_pid();`;
}

function summarizeRows(lines: string[]): {
  resultRows: number;
  nonNullRows: number;
  digest: string;
} {
  const meaningful = lines.filter((line) => line.length > 0);
  return {
    resultRows: lines.length,
    nonNullRows: meaningful.length,
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
}

async function waitForBothBlocked(
  observer: PsqlSession,
  pids: [number, number],
  holderPid: number,
  timeoutMs: number,
  contenders: [PsqlSession, PsqlSession],
  operationDoneMarkers: [string, string],
): Promise<void> {
  const marker = `M15_WAITERS:${randomUUID()}:`;
  const deadline = Date.now() + timeoutMs;
  let lastDiagnostic = "unknown";
  while (Date.now() < deadline) {
    // PostgreSQL may queue contender B behind contender A when both contend
    // for a row lock held by the barrier session. Count a contender once its
    // blocker chain reaches that exact holder; requiring a direct blocker
    // incorrectly times out valid serialized races.
    const sql = `WITH RECURSIVE blocker_chain(waiter_pid, blocker_pid, path) AS (
      SELECT activity.pid, blockers.pid, ARRAY[activity.pid,blockers.pid]
      FROM pg_stat_activity activity
      CROSS JOIN LATERAL unnest(pg_blocking_pids(activity.pid)) AS blockers(pid)
      WHERE activity.pid IN (${pids[0]},${pids[1]})
      UNION ALL
      SELECT chain.waiter_pid, blockers.pid, chain.path || blockers.pid
      FROM blocker_chain chain
      CROSS JOIN LATERAL unnest(pg_blocking_pids(chain.blocker_pid)) AS blockers(pid)
      WHERE chain.blocker_pid <> ${holderPid}
        AND NOT blockers.pid = ANY(chain.path)
    ), observed_pids(pid) AS (
      SELECT unnest(ARRAY[${pids[0]},${pids[1]}]::integer[])
    ), states AS (
      SELECT observed.pid,
        CASE WHEN activity.pid IS NULL THEN 'A'
          WHEN activity.wait_event_type = 'Lock' THEN 'L' ELSE 'P' END AS process_state,
        CASE WHEN EXISTS (
          SELECT 1 FROM blocker_chain chain
          WHERE chain.waiter_pid=observed.pid AND chain.blocker_pid=${holderPid}
        ) THEN 'H' ELSE 'X' END AS holder_chain
      FROM observed_pids observed
      LEFT JOIN pg_stat_activity activity ON activity.pid=observed.pid
    )
    SELECT '${marker}' || (SELECT count(DISTINCT waiter_pid)::text
      FROM blocker_chain WHERE blocker_pid=${holderPid}) || '|' ||
      (SELECT string_agg(process_state || holder_chain, '' ORDER BY pid) FROM states);`;
    observer.write(sql);
    const line = await observer.readMarker(marker);
    const [count, processSummary = "unknown"] = line.slice(marker.length).split("|");
    lastDiagnostic = `${count ?? "?"}_${processSummary.toLowerCase()}_a${contenders[0].safeDiagnosticState()}_b${contenders[1].safeDiagnosticState()}_${contenders[0].hasPendingMarker(operationDoneMarkers[0]) ? "d" : "w"}${contenders[1].hasPendingMarker(operationDoneMarkers[1]) ? "d" : "w"}`;
    if (count === "2") return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`race_contenders_not_both_blocked_on_holder_${lastDiagnostic}`);
}

/**
 * Runs two reviewed scalar SELECT operations on distinct local Postgres sessions.
 * The holder barrier proves both session PIDs are concurrently waiting at the
 * contested lock before releasing them. Results contain no SQL values or errors.
 */
export async function runIndependentPostgresRace(input: {
  workspaceId: string;
  barrier: RaceBarrier;
  operations: readonly [RaceOperation, RaceOperation];
  timeoutMs?: number;
}): Promise<IndependentRaceResult> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS)
    throw new Error("race_timeout_out_of_bounds");
  assertUuid(input.workspaceId, "invalid_fixture_workspace_id");
  if (input.operations.length !== 2) throw new Error("exactly_two_race_operations_required");
  assertOperation(input.operations[0]);
  assertOperation(input.operations[1]);
  await assertLocalTarget(input.workspaceId);

  const holder = new PsqlSession(timeoutMs);
  const contenderA = new PsqlSession(timeoutMs);
  const contenderB = new PsqlSession(timeoutMs);
  const observer = new PsqlSession(timeoutMs);
  let holderPid: number | null = null;
  let barrierReleased = false;
  try {
    const holderPidMarker = `M15_HOLDER_PID:${randomUUID()}:`;
    holder.write(`SELECT '${holderPidMarker}' || pg_backend_pid();`);
    const holderPidLine = await holder.readMarker(holderPidMarker);
    holderPid = Number(holderPidLine.slice(holderPidMarker.length));
    if (!Number.isInteger(holderPid) || holderPid <= 0)
      throw new Error("holder_backend_pid_unavailable");

    const holderReadyMarker = "M15_HOLDER_READY";
    holder.write(barrierSql(input.workspaceId, input.barrier, timeoutMs));
    try {
      await holder.readMarker(holderReadyMarker);
      if (input.barrier.kind !== "advisory") {
        const expectedRowId =
          input.barrier.kind === "workspace_row" ? input.workspaceId : input.barrier.rowId;
        if (!holder.takeLines().some((line) => line === expectedRowId)) {
          throw new Error("race_barrier_target_row_not_locked");
        }
      }
    } catch (error) {
      throw new Error(`race_barrier_setup_${safeErrorCode(error)}`);
    }

    const pidMarkers = [contenderA.pidMarker, contenderB.pidMarker] as const;
    const operationDoneMarkers = pidMarkers.map((marker) =>
      marker.replace("M15_BACKEND_PID", "M15_OPERATION_DONE"),
    ) as [string, string];
    const operationStartMarkers = [
      `M15_OPERATION_START:${randomUUID()}:`,
      `M15_OPERATION_START:${randomUUID()}:`,
    ] as const;
    contenderA.write(contenderSetupSql(input.operations[0], pidMarkers[0], timeoutMs));
    contenderB.write(contenderSetupSql(input.operations[1], pidMarkers[1], timeoutMs));
    let pidLines: string[];
    try {
      pidLines = await Promise.all([
        contenderA.readMarker(pidMarkers[0]),
        contenderB.readMarker(pidMarkers[1]),
      ]);
    } catch (error) {
      throw new Error(`race_contender_setup_${safeErrorCode(error)}`);
    }
    const pids = pidLines.map((line, index) => Number(line.slice(pidMarkers[index]!.length))) as [
      number,
      number,
    ];
    if (
      !pids.every((pid) => Number.isInteger(pid) && pid > 0) ||
      pids[0] === pids[1] ||
      pids.includes(holderPid)
    )
      throw new Error("independent_backend_sessions_required");
    contenderA.takeLines();
    contenderB.takeLines();
    contenderA.write(`SELECT '${operationStartMarkers[0]}';`);
    contenderB.write(`SELECT '${operationStartMarkers[1]}';`);
    try {
      await Promise.all([
        contenderA.readMarker(operationStartMarkers[0]),
        contenderB.readMarker(operationStartMarkers[1]),
      ]);
    } catch (error) {
      throw new Error(`race_operation_start_${safeErrorCode(error)}`);
    }
    contenderA.write(
      `${input.operations[0].sql.trim()}; SELECT '${operationDoneMarkers[0]}'; COMMIT;`,
    );
    contenderB.write(
      `${input.operations[1].sql.trim()}; SELECT '${operationDoneMarkers[1]}'; COMMIT;`,
    );

    try {
      await waitForBothBlocked(
        observer,
        pids,
        holderPid,
        timeoutMs,
        [contenderA, contenderB],
        operationDoneMarkers,
      );
    } catch (error) {
      throw new Error(`race_barrier_observation_${safeErrorCode(error)}`);
    }
    holder.write("COMMIT;");
    barrierReleased = true;

    let doneA: string;
    let doneB: string;
    try {
      [doneA, doneB] = await Promise.all([
        contenderA.readMarker(operationDoneMarkers[0]),
        contenderB.readMarker(operationDoneMarkers[1]),
      ]);
    } catch (error) {
      throw new Error(`race_operation_completion_${safeErrorCode(error)}`);
    }
    if (!doneA || !doneB) throw new Error("race_operation_completion_missing");
    const [exitA, exitB] = await Promise.all([contenderA.close(), contenderB.close()]);
    if (exitA.code !== 0 || exitB.code !== 0) throw new Error("race_operation_failed");

    const [rowsA, rowsB] = [
      summarizeRows(contenderA.takeLines()),
      summarizeRows(contenderB.takeLines()),
    ];
    return {
      localTarget: `${LOCAL_CONTAINER}/postgres`,
      workspaceId: input.workspaceId,
      barrier: input.barrier.kind,
      contenders: [
        {
          name: input.operations[0].name,
          backendPid: pids[0],
          completed: true,
          resultRows: rowsA.resultRows,
          nonNullRows: rowsA.nonNullRows,
        },
        {
          name: input.operations[1].name,
          backendPid: pids[1],
          completed: true,
          resultRows: rowsB.resultRows,
          nonNullRows: rowsB.nonNullRows,
        },
      ],
      bothBlockedOnHolder: true,
      sameResult: rowsA.digest === rowsB.digest,
      observedAt: new Date().toISOString(),
    };
  } finally {
    if (!barrierReleased) {
      try {
        holder.write("ROLLBACK;");
      } catch {
        // Keep cleanup best-effort while closing every exact local session.
      }
    }
    await Promise.all([holder.close(), contenderA.close(), contenderB.close(), observer.close()]);
  }
}
