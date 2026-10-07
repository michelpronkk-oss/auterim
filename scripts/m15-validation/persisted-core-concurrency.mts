import { randomUUID } from "node:crypto";
import {
  runIndependentPostgresRace,
  type IndependentRaceResult,
  type RaceOperation,
} from "./postgres-concurrency.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, code: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(code);
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function assertSymmetricRace(result: IndependentRaceResult, stage: string): void {
  if (
    !result.bothBlockedOnHolder ||
    !result.sameResult ||
    result.contenders.some((contender) => !contender.completed || contender.nonNullRows !== 1)
  ) {
    throw new Error(`${stage}_concurrency_not_idempotent`);
  }
}

function assertSingleWinnerRace(result: IndependentRaceResult, stage: string): void {
  const winnerCount = result.contenders.reduce(
    (total, contender) => total + contender.nonNullRows,
    0,
  );
  if (!result.bothBlockedOnHolder) throw new Error(`${stage}_claim_race_barrier_not_proven`);
  if (result.contenders.some((contender) => !contender.completed || contender.resultRows !== 1)) {
    throw new Error(`${stage}_claim_race_result_shape_invalid`);
  }
  if (winnerCount === 0) throw new Error(`${stage}_claim_race_zero_winners`);
  if (winnerCount > 1) throw new Error(`${stage}_claim_race_multiple_winners`);
  if (result.sameResult) throw new Error(`${stage}_claim_race_contender_results_identical`);
}

function claimOperation(name: string, sql: string): RaceOperation {
  return { name, session: { role: "service_role" }, sql };
}

function claimSql(functionName: string, args: string): string {
  return `select case when public.${functionName}(${args}) is null then null else 'claimed' end`;
}

function completeClaimSql(input: {
  claimFunction: string;
  claimArgs: string;
  completeSql: (token: string) => string;
}): string {
  const token = "claim_result.claim_token";
  return `select case when claim_result.claim_token is null then null when completion.completed is false then null else 'claimed' end from (select public.${input.claimFunction}(${input.claimArgs}) as claim_token) claim_result left join lateral (select ${input.completeSql(token)} as completed where claim_result.claim_token is not null) completion on true`;
}

async function runSingleWinnerClaim(input: {
  workspaceId: string;
  name: string;
  sql: string;
  timeoutMs?: number;
}): Promise<IndependentRaceResult> {
  const result = await runIndependentPostgresRace({
    workspaceId: input.workspaceId,
    barrier: { kind: "workspace_row", workspaceId: input.workspaceId },
    operations: [
      claimOperation(`${input.name}-a`, input.sql),
      claimOperation(`${input.name}-b`, input.sql),
    ],
    timeoutMs: input.timeoutMs,
  });
  assertSingleWinnerRace(result, input.name);
  return result;
}

export async function provePreflightClaimRace(input: {
  workspaceId: string;
  preflightRunId: string;
  timeoutMs?: number;
}): Promise<IndependentRaceResult> {
  assertUuid(input.workspaceId, "invalid_fixture_workspace_id");
  assertUuid(input.preflightRunId, "invalid_fixture_preflight_run_id");
  try {
    return await runSingleWinnerClaim({
      workspaceId: input.workspaceId,
      name: "preflight_claim",
      sql: claimSql("claim_preflight_run", `${literal(input.preflightRunId)}::uuid`),
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    throw new Error(`preflight_claim_${safeFailureCode(error)}`);
  }
}

export async function proveRemediationClaimRace(input: {
  workspaceId: string;
  queueId: string;
  attempt: number;
  timeoutMs?: number;
}): Promise<IndependentRaceResult> {
  assertUuid(input.workspaceId, "invalid_fixture_workspace_id");
  assertUuid(input.queueId, "invalid_fixture_preparation_queue_id");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new Error("invalid_fixture_queue_attempt");
  const queue = literal(input.queueId);
  const sql = completeClaimSql({
    claimFunction: "claim_remediation_preparation",
    claimArgs: `${queue}::uuid,${input.attempt}`,
    completeSql: (token) =>
      `(public.complete_remediation_preparation(${queue}::uuid,${token},'failed',null,'m15_concurrency_race')->>'status')='failed'`,
  });
  try {
    return await runSingleWinnerClaim({
      workspaceId: input.workspaceId,
      name: "remediation_claim",
      sql,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    throw new Error(`remediation_claim_${safeFailureCode(error)}`);
  }
}

export async function proveValidationClaimRace(input: {
  workspaceId: string;
  queueId: string;
  attempt: number;
  timeoutMs?: number;
}): Promise<IndependentRaceResult> {
  assertUuid(input.workspaceId, "invalid_fixture_workspace_id");
  assertUuid(input.queueId, "invalid_fixture_validation_queue_id");
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 1)
    throw new Error("invalid_fixture_queue_attempt");
  const queue = literal(input.queueId);
  const sql = completeClaimSql({
    claimFunction: "claim_remediation_validation",
    claimArgs: `${queue}::uuid,${input.attempt}`,
    completeSql: (token) =>
      `format('completed%s', public.complete_remediation_validation(${queue}::uuid,${token},'validation_failed','m15_concurrency_race','[]'::jsonb,'Internal QA concurrency acceptance attempt.',0)) = 'completed'`,
  });
  try {
    return await runSingleWinnerClaim({
      workspaceId: input.workspaceId,
      name: "validation_claim",
      sql,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    throw new Error(`validation_claim_${safeFailureCode(error)}`);
  }
}

export type PersistedClaimRaceFixture = {
  workspaceId: string;
  preflightRunId: string;
  preparationQueueId: string;
  preparationAttempt: number;
  validationQueueId: string;
  validationAttempt: number;
  timeoutMs?: number;
};

export type PersistedClaimRaceResult = {
  preflightClaim: IndependentRaceResult;
  remediationClaim: IndependentRaceResult;
  validationClaim: IndependentRaceResult;
  proven: {
    independentPostgresBackends: true;
    onePreflightClaimWinner: true;
    oneRemediationClaimWinner: true;
    oneValidationClaimWinner: true;
  };
};

/**
 * Race the canonical service-role claim RPCs against eligible persisted rows.
 * Each operation emits only a constant `claimed` marker or NULL; claim tokens
 * never leave PostgreSQL. Call with disposable local acceptance fixtures so
 * the winning leases are removed by the normal QA workspace cleanup.
 */
export async function provePersistedClaimRaces(
  fixture: PersistedClaimRaceFixture,
): Promise<PersistedClaimRaceResult> {
  assertUuid(fixture.workspaceId, "invalid_fixture_workspace_id");
  assertUuid(fixture.preflightRunId, "invalid_fixture_preflight_run_id");
  assertUuid(fixture.preparationQueueId, "invalid_fixture_preparation_queue_id");
  assertUuid(fixture.validationQueueId, "invalid_fixture_validation_queue_id");
  if (
    !Number.isSafeInteger(fixture.preparationAttempt) ||
    fixture.preparationAttempt < 1 ||
    !Number.isSafeInteger(fixture.validationAttempt) ||
    fixture.validationAttempt < 1
  ) {
    throw new Error("invalid_fixture_queue_attempt");
  }

  const races = [
    {
      stage: "preflight_claim",
      barrier: { kind: "workspace_row" as const, workspaceId: fixture.workspaceId },
      sql: claimSql("claim_preflight_run", literal(fixture.preflightRunId) + "::uuid"),
    },
    {
      stage: "remediation_claim",
      barrier: {
        kind: "row" as const,
        table: "remediation_preparation_queue" as const,
        rowId: fixture.preparationQueueId,
      },
      sql: claimSql(
        "claim_remediation_preparation",
        `${literal(fixture.preparationQueueId)}::uuid,${fixture.preparationAttempt}`,
      ),
    },
    {
      stage: "validation_claim",
      barrier: {
        kind: "row" as const,
        table: "remediation_validation_queue" as const,
        rowId: fixture.validationQueueId,
      },
      sql: claimSql(
        "claim_remediation_validation",
        `${literal(fixture.validationQueueId)}::uuid,${fixture.validationAttempt}`,
      ),
    },
  ];
  const results: IndependentRaceResult[] = [];
  for (const race of races) {
    let result: IndependentRaceResult;
    try {
      result = await runIndependentPostgresRace({
        workspaceId: fixture.workspaceId,
        barrier: race.barrier,
        operations: [
          claimOperation(`${race.stage}-a`, race.sql),
          claimOperation(`${race.stage}-b`, race.sql),
        ],
        timeoutMs: fixture.timeoutMs,
      });
    } catch (error) {
      throw new Error(`${race.stage}_${safeFailureCode(error)}`);
    }
    assertSingleWinnerRace(result, race.stage);
    results.push(result);
  }

  return {
    preflightClaim: results[0]!,
    remediationClaim: results[1]!,
    validationClaim: results[2]!,
    proven: {
      independentPostgresBackends: true,
      onePreflightClaimWinner: true,
      oneRemediationClaimWinner: true,
      oneValidationClaimWinner: true,
    },
  };
}

export type PersistedCoreConcurrencyFixture = {
  workspaceId: string;
  ownerUserId: string;
  unresolvedImpactAssessmentId: string;
  timeoutMs?: number;
  productIdempotencyResult?: IndependentRaceResult;
};

export type ProductIdempotencyConcurrencyFixture = {
  workspaceId: string;
  ownerUserId: string;
  timeoutMs?: number;
};

export type PersistedCoreConcurrencyResult = {
  localTarget: "supabase_db_auterim-m15-acceptance/postgres";
  productIdempotency: IndependentRaceResult;
  riskResolution: IndependentRaceResult;
  proven: {
    independentPostgresBackends: true;
    sameProductRequestReturnsSamePersistedResult: true;
    resolutionRaceReturnsSameImmutableResolution: true;
  };
};

function safeFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  return /^[a-z0-9_]{1,160}$/.test(error.message) ? error.message : "unknown";
}

/**
 * Proves two persisted idempotency/lifecycle invariants using independent local
 * PostgreSQL sessions. Call only with an actual workspace owner and an assessed,
 * relevant, material impact that is still unresolved. The resolution race makes
 * that impact immutable, so run this before the normal resolution step.
 *
 * This helper intentionally does not claim Preflight/remediation/validation
 * queue-claim coverage: those require an eligible queued row and a runner result
 * mode that captures the expected single-winner/null-or-conflict outcome.
 */
export async function provePersistedCoreConcurrency(
  fixture: PersistedCoreConcurrencyFixture,
): Promise<PersistedCoreConcurrencyResult> {
  assertUuid(fixture.workspaceId, "invalid_fixture_workspace_id");
  assertUuid(fixture.ownerUserId, "invalid_fixture_owner_id");
  assertUuid(fixture.unresolvedImpactAssessmentId, "invalid_fixture_impact_id");

  const productIdempotency =
    fixture.productIdempotencyResult ??
    (await proveProductIdempotencyConcurrency({
      workspaceId: fixture.workspaceId,
      ownerUserId: fixture.ownerUserId,
      timeoutMs: fixture.timeoutMs,
    }));
  assertSymmetricRace(productIdempotency, "product_idempotency");

  const resolutionRace = await proveRiskResolutionConcurrency({
    workspaceId: fixture.workspaceId,
    ownerUserId: fixture.ownerUserId,
    unresolvedImpactAssessmentId: fixture.unresolvedImpactAssessmentId,
    timeoutMs: fixture.timeoutMs,
  });

  return {
    localTarget: "supabase_db_auterim-m15-acceptance/postgres",
    productIdempotency,
    riskResolution: resolutionRace,
    proven: {
      independentPostgresBackends: true,
      sameProductRequestReturnsSamePersistedResult: true,
      resolutionRaceReturnsSameImmutableResolution: true,
    },
  };
}

export async function proveProductIdempotencyConcurrency(
  fixture: ProductIdempotencyConcurrencyFixture,
): Promise<IndependentRaceResult> {
  assertUuid(fixture.workspaceId, "invalid_fixture_workspace_id");
  assertUuid(fixture.ownerUserId, "invalid_fixture_owner_id");

  const idempotencyKey = `m15-race-${randomUUID()}`;
  const productName = `M15 concurrency ${randomUUID()}`;
  const advisoryLock = `${fixture.workspaceId}:${fixture.ownerUserId}:${idempotencyKey}`;
  const productOperation: RaceOperation = {
    name: "product-idempotency-a",
    session: { role: "authenticated", userId: fixture.ownerUserId },
    sql: `select public.create_workspace_product_idempotent(${literal(fixture.workspaceId)}::uuid, ${literal(productName)}, '[]'::jsonb, null, ${literal(idempotencyKey)})::text`,
  };
  const productRetry: RaceOperation = {
    ...productOperation,
    name: "product-idempotency-b",
  };
  let productIdempotency: IndependentRaceResult;
  try {
    productIdempotency = await runIndependentPostgresRace({
      workspaceId: fixture.workspaceId,
      barrier: { kind: "advisory", lockText: advisoryLock, seed: 0 },
      operations: [productOperation, productRetry],
      timeoutMs: fixture.timeoutMs,
    });
  } catch (error) {
    throw new Error(`m15_product_idempotency_race_${safeFailureCode(error)}`);
  }
  assertSymmetricRace(productIdempotency, "product_idempotency");

  return productIdempotency;
}

export async function proveRiskResolutionConcurrency(fixture: {
  workspaceId: string;
  ownerUserId: string;
  unresolvedImpactAssessmentId: string;
  timeoutMs?: number;
}): Promise<IndependentRaceResult> {
  assertUuid(fixture.workspaceId, "invalid_fixture_workspace_id");
  assertUuid(fixture.ownerUserId, "invalid_fixture_owner_id");
  assertUuid(fixture.unresolvedImpactAssessmentId, "invalid_fixture_impact_id");
  const resolutionSql = `select public.resolve_customer_risk(${literal(fixture.workspaceId)}::uuid, ${literal(fixture.unresolvedImpactAssessmentId)}::uuid, 'reviewed')::text`;
  let resolutionRace: IndependentRaceResult;
  try {
    resolutionRace = await runIndependentPostgresRace({
      workspaceId: fixture.workspaceId,
      barrier: { kind: "workspace_row", workspaceId: fixture.workspaceId },
      operations: [
        {
          name: "risk-resolution-a",
          session: { role: "authenticated", userId: fixture.ownerUserId },
          sql: resolutionSql,
        },
        {
          name: "risk-resolution-b",
          session: { role: "authenticated", userId: fixture.ownerUserId },
          sql: resolutionSql,
        },
      ],
      timeoutMs: fixture.timeoutMs,
    });
  } catch (error) {
    throw new Error(`m15_risk_resolution_race_${safeFailureCode(error)}`);
  }
  assertSymmetricRace(resolutionRace, "risk_resolution");
  return resolutionRace;
}
