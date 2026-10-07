import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
  resolveWorkspaceEntitlementsForService: vi.fn(),
  validatePatchInDocker: vi.fn(),
}));

vi.mock("@trigger.dev/sdk", () => ({
  AbortTaskRunError: class AbortTaskRunError extends Error {},
  schemaTask: (definition: unknown) => definition,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createSupabaseServerClient,
}));
vi.mock("@/lib/billing/server", () => ({
  resolveWorkspaceEntitlementsForService: mocks.resolveWorkspaceEntitlementsForService,
}));
vi.mock("@/lib/preflight/docker-validation", () => ({
  validatePatchInDocker: mocks.validatePatchInDocker,
}));

import { validateRemediationTask } from "@/trigger/validate-remediation";

const queueId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const proposalId = "33333333-3333-4333-8333-333333333333";
const repositoryId = "44444444-4444-4444-8444-444444444444";
const preflightCommit = "a".repeat(40);
const patch =
  "diff --git a/src/client.ts b/src/client.ts\n--- a/src/client.ts\n+++ b/src/client.ts\n";
const evidenceId = "55555555-5555-4555-8555-555555555555";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const patchFingerprint = hash(`${hash(`${preflightCommit}\n${patch}`)}\n${evidenceId}`);
const previousLocalQa = process.env.AUTERIM_M15_LOCAL_INTEGRATION;

afterEach(() => {
  if (previousLocalQa === undefined) delete process.env.AUTERIM_M15_LOCAL_INTEGRATION;
  else process.env.AUTERIM_M15_LOCAL_INTEGRATION = previousLocalQa;
});

function taskRun() {
  return (
    validateRemediationTask as unknown as {
      run: (payload: {
        queueId: string;
        workspaceId: string;
        proposalId: string;
        patchFingerprint: string;
        attempt: number;
      }) => Promise<unknown>;
    }
  ).run;
}

function configureClient(input: { queueFingerprint?: string; proposalFingerprint?: string } = {}) {
  const queue = {
    workspace_id: workspaceId,
    remediation_proposal_id: proposalId,
    patch_fingerprint: input.queueFingerprint ?? patchFingerprint,
    status: "dispatched",
    attempt_count: 1,
  };
  const proposal = {
    id: proposalId,
    workspace_id: workspaceId,
    patch,
    patch_fingerprint: input.proposalFingerprint ?? patchFingerprint,
    patch_validation_status: "validating",
    base_commit_sha: preflightCommit,
    workspace_dependency_id: "66666666-6666-4666-8666-666666666666",
    generation_metadata: {
      replacementEvidenceId: evidenceId,
      internalQaOnly: true,
      repository: {
        id: repositoryId,
        owner: "auterim-internal-qa",
        name: "m15-fixture",
        commitSha: preflightCommit,
      },
    },
  };
  const maybeSingle = vi.fn().mockResolvedValueOnce({ data: queue, error: null });
  const select = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ maybeSingle }),
  });
  const proposalSingle = vi.fn().mockResolvedValue({ data: proposal, error: null });
  const proposalSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: proposalSingle }) }),
  });
  const completionSelect = vi.fn().mockReturnValue({
    eq: vi.fn().mockReturnValue({
      maybeSingle: vi.fn().mockResolvedValue({
        data: { status: "validated", error_category: null },
        error: null,
      }),
    }),
  });
  const from = vi
    .fn()
    .mockReturnValueOnce({ select })
    .mockReturnValueOnce({ select: proposalSelect })
    .mockReturnValueOnce({ select: completionSelect });
  const rpc = vi
    .fn()
    .mockResolvedValueOnce({ data: "claim-token", error: null })
    .mockResolvedValueOnce({ data: true, error: null });
  const client = { from, rpc };
  mocks.createSupabaseServerClient.mockReturnValue(client);
  return { client, queue, proposal };
}

describe("validate-remediation Trigger worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.AUTERIM_M15_LOCAL_INTEGRATION = "1";
    mocks.resolveWorkspaceEntitlementsForService.mockResolvedValue({
      capabilities: { generateFix: true },
      usage: { remediationRuns: 1 },
      limits: { remediationRuns: 30 },
    });
    mocks.validatePatchInDocker.mockResolvedValue({
      state: "VALIDATED",
      commands: ["node --test test/*.mjs", "tsc --noEmit -p tsconfig.json"],
      output: "fixture passed",
      durationMs: 42,
    });
  });

  it("validates only the persisted patch identity and stores the bounded result", async () => {
    const { client } = configureClient();
    const result = await taskRun()({
      queueId,
      workspaceId,
      proposalId,
      patchFingerprint,
      attempt: 1,
    });

    expect(result).toEqual({ status: "validated" });
    expect(mocks.validatePatchInDocker).toHaveBeenCalledWith({
      repositoryDirectory: expect.stringMatching(/tests[\\/]fixtures[\\/]m15-money-path/),
      patch,
      timeoutMs: 120_000,
    });
    expect(client.rpc).toHaveBeenLastCalledWith("complete_remediation_validation", {
      p_queue_id: queueId,
      p_claim_token: "claim-token",
      p_outcome: "validated",
      p_error_category: null,
      p_commands: ["node --test test/*.mjs", "tsc --noEmit -p tsconfig.json"],
      p_diagnostics: "fixture passed",
      p_duration_ms: 42,
    });
  });

  it("denies a queued patch whose stored text no longer matches its fingerprint", async () => {
    const { client } = configureClient({ proposalFingerprint: "f".repeat(64) });
    const result = await taskRun()({
      queueId,
      workspaceId,
      proposalId,
      patchFingerprint,
      attempt: 1,
    });

    expect(result).toEqual({ status: "denied" });
    expect(mocks.validatePatchInDocker).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenLastCalledWith("complete_remediation_validation", {
      p_queue_id: queueId,
      p_claim_token: "claim-token",
      p_outcome: "denied",
      p_error_category: "patch_identity_mismatch",
      p_commands: [],
      p_diagnostics: "The persisted patch no longer matches its queued identity.",
      p_duration_ms: 0,
    });
  });

  it("denies validation when remediation usage has reached its current limit", async () => {
    const { client } = configureClient();
    mocks.resolveWorkspaceEntitlementsForService.mockResolvedValue({
      capabilities: { generateFix: true },
      usage: { remediationRuns: 30 },
      limits: { remediationRuns: 30 },
    });

    const result = await taskRun()({
      queueId,
      workspaceId,
      proposalId,
      patchFingerprint,
      attempt: 1,
    });

    expect(result).toEqual({ status: "denied" });
    expect(mocks.validatePatchInDocker).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenLastCalledWith("complete_remediation_validation", {
      p_queue_id: queueId,
      p_claim_token: "claim-token",
      p_outcome: "denied",
      p_error_category: "generate_fix_not_entitled",
      p_commands: [],
      p_diagnostics:
        "Validation was denied because current workspace entitlements do not allow it.",
      p_duration_ms: 0,
    });
  });
});
