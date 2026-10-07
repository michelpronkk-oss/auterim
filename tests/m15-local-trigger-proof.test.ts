import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  isM15LocalAcceptanceEnabled,
  isM15PostCommitRetryFault,
  shouldInjectM15PostCommitRetry,
  waitForM15LocalAcceptancePreClaimGate,
} from "@/lib/m15/local-trigger-proof";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("M15 local duplicate-delivery gate", () => {
  it("requires the guarded acceptance flags, exact Auterim root, and isolated loopback database", () => {
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_SUPABASE_URL", "http://127.0.0.1:65431");
    vi.stubEnv("AUTERIM_M15_LOCAL_REPO_ROOT", "C:\\Users\\miche\\Desktop\\Auterim");

    expect(isM15LocalAcceptanceEnabled()).toBe(true);
  });

  it("stays off without the explicit duplicate-delivery flag", () => {
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_SUPABASE_URL", "http://127.0.0.1:65431");
    vi.stubEnv("AUTERIM_M15_LOCAL_REPO_ROOT", "C:\\Users\\miche\\Desktop\\Auterim");

    expect(isM15LocalAcceptanceEnabled()).toBe(false);
  });

  it.each([
    ["hosted persistence", "https://project.supabase.co", "C:\\Users\\miche\\Desktop\\Auterim"],
    ["another repository", "http://127.0.0.1:65431", "C:\\Users\\miche\\Desktop\\Other"],
  ])("stays off for %s", (_name, supabaseUrl, repoRoot) => {
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_SUPABASE_URL", supabaseUrl);
    vi.stubEnv("AUTERIM_M15_LOCAL_REPO_ROOT", repoRoot);

    expect(isM15LocalAcceptanceEnabled()).toBe(false);
  });
});

describe("M15 local post-commit retry fault gate", () => {
  const queueId = "33333333-3333-4333-8333-333333333333";

  function enableGuardedFault() {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_ACCEPTANCE_DUPLICATE_DELIVERIES", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_ACCEPTANCE_POST_COMMIT_RETRY", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_SUPABASE_URL", "http://127.0.0.1:65431");
    vi.stubEnv("AUTERIM_M15_LOCAL_REPO_ROOT", "C:\\Users\\miche\\Desktop\\Auterim");
  }

  it("injects only on the first actual attempt under the isolated local guard", () => {
    enableGuardedFault();
    expect(
      shouldInjectM15PostCommitRetry({
        taskId: "prepare-remediation",
        queueId,
        triggerAttempt: 1,
      }),
    ).toBe(true);
    expect(
      shouldInjectM15PostCommitRetry({
        taskId: "validate-remediation",
        queueId,
        triggerAttempt: 2,
      }),
    ).toBe(false);
    expect(
      shouldInjectM15PostCommitRetry({
        taskId: "validate-remediation",
        queueId: "not-a-queue",
        triggerAttempt: 1,
      }),
    ).toBe(false);
  });

  it("recognizes only the matching guarded injected fault", () => {
    enableGuardedFault();
    expect(
      isM15PostCommitRetryFault(
        new Error("m15_local_acceptance_post_commit_retry:prepare-remediation"),
        "prepare-remediation",
      ),
    ).toBe(true);
    expect(
      isM15PostCommitRetryFault(
        new Error("m15_local_acceptance_post_commit_retry:prepare-remediation"),
        "validate-remediation",
      ),
    ).toBe(false);
    vi.stubEnv("NODE_ENV", "production");
    expect(
      isM15PostCommitRetryFault(
        new Error("m15_local_acceptance_post_commit_retry:prepare-remediation"),
        "prepare-remediation",
      ),
    ).toBe(false);
  });
});

describe("M15 local pre-claim acceptance gate", () => {
  it("waits for the matching local release signal and stays unavailable outside acceptance", async () => {
    const queueId = randomUUID();
    const root = path.join(process.cwd(), "node_modules", ".cache", "m15-local", "preclaim-gates");
    const hold = path.join(root, `prepare-remediation-${queueId}.hold`);
    const started = path.join(root, `prepare-remediation-${queueId}.started`);
    const release = path.join(root, `prepare-remediation-${queueId}.release`);
    await mkdir(root, { recursive: true });
    await writeFile(hold, "hold", { mode: 0o600 });
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTERIM_M15_LOCAL_ACCEPTANCE_PRECLAIM_GATE", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_INTEGRATION", "1");
    vi.stubEnv("AUTERIM_M15_LOCAL_SUPABASE_URL", "http://127.0.0.1:65431");
    vi.stubEnv("AUTERIM_M15_LOCAL_REPO_ROOT", "C:\\Users\\miche\\Desktop\\Auterim");
    try {
      const waiting = waitForM15LocalAcceptancePreClaimGate({
        taskId: "prepare-remediation",
        queueId,
        timeoutMs: 3_000,
      });
      const deadline = Date.now() + 1_000;
      let observed = false;
      while (Date.now() < deadline) {
        try {
          await access(started);
          observed = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(observed).toBe(true);
      vi.stubEnv("NODE_ENV", "production");
      await waitForM15LocalAcceptancePreClaimGate({
        taskId: "prepare-remediation",
        queueId: randomUUID(),
      });
      vi.stubEnv("NODE_ENV", "test");
      await writeFile(release, "release", { mode: 0o600 });
      await waiting;
    } finally {
      await Promise.all([hold, started, release].map((file) => rm(file, { force: true })));
    }
  });
});
