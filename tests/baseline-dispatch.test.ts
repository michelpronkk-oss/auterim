import { describe, expect, it, vi } from "vitest";
import {
  baselineClaimResult,
  dispatchBaselineClaims,
  type BaselineDispatchClaim,
  type BaselineDispatchEvent,
} from "@/lib/onboarding/baseline-dispatch";

const claim: BaselineDispatchClaim = {
  queue_id: "00000000-0000-4000-8000-000000000001",
  source_id: "00000000-0000-4000-8000-000000000002",
  dispatch_attempt: 2,
  lease_recovery_count: 1,
  recovered: true,
};

describe("baseline dispatch reliability", () => {
  it("distinguishes a claim RPC error from a successful empty claim", () => {
    expect(baselineClaimResult({ code: "XX000" }, 0)).toBe("error");
    expect(baselineClaimResult(null, 0)).toBe("empty");
    expect(baselineClaimResult(null, 1)).toBe("claimed");
  });

  it("keeps ambiguous Trigger dispatch failures recoverable without blocking activation", async () => {
    const events: BaselineDispatchEvent[] = [];
    const release = vi.fn(async () => ({ error: null }));
    const result = await dispatchBaselineClaims([claim], "workspace-safe-id", {
      createIdempotencyKey: async (item) => `${item.queue_id}:${item.dispatch_attempt}`,
      trigger: async () => {
        throw new Error("provider response must not be logged");
      },
      markDispatched: async () => ({ error: null }),
      release,
      log: (event) => events.push(event),
    });

    expect(result).toEqual({ dispatched: 0, failed: 1 });
    expect(release).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      stage: "dispatch",
      outcome: "error",
      errorCategory: "trigger_dispatch_failed",
      attemptCount: 2,
      leaseRecoveryCount: 1,
      leaseRecoveryState: "lease_retained",
    });
    expect(JSON.stringify(events)).not.toContain("provider response");
  });

  it("releases a reservation when key creation fails before any provider request", async () => {
    const events: BaselineDispatchEvent[] = [];
    const release = vi.fn(async () => ({ error: null }));
    const trigger = vi.fn(async () => ({ id: "must-not-run" }));
    const result = await dispatchBaselineClaims([claim], "workspace-safe-id", {
      createIdempotencyKey: async () => {
        throw new Error("local idempotency key failure");
      },
      trigger,
      markDispatched: async () => ({ error: null }),
      release,
      log: (event) => events.push(event),
    });

    expect(result).toEqual({ dispatched: 0, failed: 1 });
    expect(trigger).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(claim);
    expect(events[0]!.leaseRecoveryState).toBe("released");
  });

  it("retains the claim lease after accepted dispatch if marking the run fails", async () => {
    const events: BaselineDispatchEvent[] = [];
    const release = vi.fn(async () => ({ error: null }));
    const trigger = vi.fn(async () => ({ id: "run-safe-id" }));
    const markDispatched = vi.fn(async () => ({ error: { code: "40001" } }));
    const result = await dispatchBaselineClaims([claim], null, {
      createIdempotencyKey: async (item) => `${item.queue_id}:${item.dispatch_attempt}`,
      trigger,
      markDispatched,
      release,
      log: (event) => events.push(event),
    });

    expect(result).toEqual({ dispatched: 0, failed: 1 });
    expect(trigger).toHaveBeenCalledOnce();
    expect(markDispatched).toHaveBeenCalledWith(claim, "run-safe-id");
    expect(release).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      stage: "mark_dispatched",
      errorCategory: "mark_dispatch_failed",
      leaseRecoveryState: "lease_retained",
      triggerRunId: "run-safe-id",
    });
  });

  it("dispatches a recovered claim using its existing queue/attempt idempotency identity", async () => {
    const keys: string[] = [];
    const runKeys: string[] = [];
    const events: BaselineDispatchEvent[] = [];
    const result = await dispatchBaselineClaims([claim], null, {
      createIdempotencyKey: async (item) => {
        const key = `baseline-source:${item.queue_id}:${item.dispatch_attempt}`;
        keys.push(key);
        return key;
      },
      trigger: async (_sourceId, key) => {
        runKeys.push(key);
        return { id: "run-reused" };
      },
      markDispatched: async () => ({ error: null }),
      release: async () => ({ error: null }),
      log: (event) => events.push(event),
    });

    expect(result).toEqual({ dispatched: 1, failed: 0 });
    expect(runKeys).toEqual(keys);
    expect(events[0]).toMatchObject({
      outcome: "success",
      attemptCount: 2,
      leaseRecoveryCount: 1,
      leaseRecoveryState: "recovered_claim",
      triggerRunId: "run-reused",
    });
  });
});
