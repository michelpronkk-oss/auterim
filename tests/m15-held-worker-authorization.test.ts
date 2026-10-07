import { afterEach, describe, expect, it, vi } from "vitest";
import { runHeldWorkerAuthorizationCase } from "../scripts/m15-validation/held-worker-entitlement-case.mts";

const environmentKeys = [
  "AUTERIM_M15_LOCAL_INTEGRATION",
  "AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES",
  "AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE",
  "AUTERIM_M15_LOCAL_SUPABASE_URL",
  "AUTERIM_M15_LOCAL_REPO_ROOT",
] as const;
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  vi.unstubAllEnvs();
  for (const key of environmentKeys) {
    const original = originalEnvironment.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("M15 held-worker authorization fixture", () => {
  it("fails closed without the exact local integration and pre-claim gates", async () => {
    vi.stubEnv("NODE_ENV", "test");
    delete process.env.AUTERIM_M15_LOCAL_INTEGRATION;
    delete process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES;
    delete process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE;

    const dispatchEligibleWork = async () => {
      throw new Error("dispatch_must_not_run");
    };

    await expect(
      runHeldWorkerAuthorizationCase({
        taskId: "prepare-remediation",
        queueId: "afe97c58-9a53-4b09-88f8-e6c7418c16c8",
        expectedOutcome: "denied",
        dispatchEligibleWork,
        mutateCanonicalState: async () => undefined,
        verifyTriggerRunCompleted: async () => true,
        verifyPersistedOutcome: async () => true,
      }),
    ).rejects.toThrow("m15_held_worker_local_acceptance_guard_rejected");
  });

  it("rejects unknown task IDs before any worker or callback can run", async () => {
    vi.stubEnv("NODE_ENV", "test");
    process.env.AUTERIM_M15_LOCAL_INTEGRATION = "1";
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES = "1";
    process.env.AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE = "1";
    process.env.AUTERIM_M15_LOCAL_SUPABASE_URL = "http://127.0.0.1:65431";
    process.env.AUTERIM_M15_LOCAL_REPO_ROOT = process.cwd();
    const dispatchEligibleWork = async () => {
      throw new Error("dispatch_must_not_run");
    };

    await expect(
      runHeldWorkerAuthorizationCase({
        taskId: "untrusted-task-id",
        queueId: "afe97c58-9a53-4b09-88f8-e6c7418c16c8",
        expectedOutcome: "denied",
        dispatchEligibleWork,
        mutateCanonicalState: async () => undefined,
        verifyTriggerRunCompleted: async () => true,
        verifyPersistedOutcome: async () => true,
      }),
    ).rejects.toThrow("m15_held_worker_local_acceptance_guard_rejected");
  });
});
