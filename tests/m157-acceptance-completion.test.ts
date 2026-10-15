import { describe, expect, it } from "vitest";
import {
  isM157AcceptanceComplete,
  withM157AcceptanceStage,
} from "../src/lib/m15/acceptance-completion.ts";
import { ProductProtectionReadError } from "../src/lib/protection/read-stage.ts";

const sha = "2c74b8bab5f2f5d7579c663233d6e548d7c895ef";
const baselineObservedAt = "2026-10-15T10:00:00.000Z";
const repositoryId = "11111111-1111-4111-8111-111111111111";
const surfaceId = "22222222-2222-4222-8222-222222222222";
const observationId = "33333333-3333-4333-8333-333333333333";
const baselineId = "44444444-4444-4444-8444-444444444444";

const completeState = {
  currentSha: sha,
  currentDeploymentId: "dpl_current_production",
  baseline: {
    id: baselineId,
    commitSha: sha,
    verificationState: "verified",
    observedAt: baselineObservedAt,
    preflightRunId: "55555555-5555-4555-8555-555555555555",
  },
  baselineRun: {
    id: "55555555-5555-4555-8555-555555555555",
    mode: "baseline",
    status: "completed",
  },
  surface: {
    id: surfaceId,
    currentProductionDeploymentId: "dpl_current_production",
    lastAttemptStatus: "succeeded",
  },
  mapping: {
    id: "66666666-6666-4666-8666-666666666666",
    repositoryId,
    provenance: "protected_repository_identity",
  },
  repositoryId,
  observation: {
    id: observationId,
    deploymentId: "dpl_current_production",
    environment: "production",
    state: "ready",
    commitSha: sha,
    repositoryOwner: "michelpronkk-oss",
    repositoryName: "auterim",
  },
  evidence: {
    id: "77777777-7777-4777-8777-777777777777",
    baselineEvidenceId: baselineId,
    preflightFindingId: null,
    verificationState: "production_verified",
    verifiedCommitSha: sha,
    exactCommitMatch: true,
    deploymentObservationId: observationId,
    repositoryId,
  },
  attempts: [
    {
      id: "88888888-8888-4888-8888-888888888888",
      status: "succeeded",
      started_at: "2026-10-15T10:01:00.000Z",
      completed_at: "2026-10-15T10:01:05.000Z",
    },
    {
      id: "99999999-9999-4999-8999-999999999999",
      status: "succeeded",
      started_at: "2026-10-15T10:02:00.000Z",
      completed_at: "2026-10-15T10:02:05.000Z",
    },
  ],
  expectedRepositoryOwner: "michelpronkk-oss",
  expectedRepositoryName: "auterim",
};

describe("M15.7 acceptance completion self-lock", () => {
  it("keeps the live partial state incomplete when the second sync is absent", () => {
    const partial = {
      ...completeState,
      attempts: [completeState.attempts[0]!],
    };

    expect(isM157AcceptanceComplete(partial)).toBe(false);
  });

  it("marks completion only after two distinct successful syncs preserve current evidence", () => {
    expect(isM157AcceptanceComplete(completeState)).toBe(true);
  });

  it("does not complete when the second sync precedes the first completion", () => {
    const invalidOrder = {
      ...completeState,
      attempts: [
        completeState.attempts[0]!,
        { ...completeState.attempts[1]!, started_at: "2026-10-15T10:01:04.000Z" },
      ],
    };

    expect(isM157AcceptanceComplete(invalidOrder)).toBe(false);
  });

  it("does not complete when exact production evidence no longer matches the baseline", () => {
    expect(
      isM157AcceptanceComplete({
        ...completeState,
        evidence: { ...completeState.evidence, baselineEvidenceId: "stale-baseline" },
      }),
    ).toBe(false);
  });

  it("normalizes a raw post-sync failure to its safe acceptance stage", async () => {
    await expect(
      withM157AcceptanceStage("first_protection_graph_unavailable", async () => {
        throw new Error("provider payload with private details");
      }),
    ).rejects.toThrow("m157_acceptance_first_protection_graph_unavailable");
  });

  it("preserves an already safe acceptance category", async () => {
    await expect(
      withM157AcceptanceStage("first_protection_graph_unavailable", async () => {
        throw new Error("m157_acceptance_first_protection_graph_mismatch");
      }),
    ).rejects.toThrow("m157_acceptance_first_protection_graph_mismatch");
  });

  it.each(["classifications", "deployment_evidence"] as const)(
    "preserves only the allowlisted Product Graph substage: %s",
    async (substage) => {
      await expect(
        withM157AcceptanceStage("first_protection_graph_unavailable", async () => {
          throw new ProductProtectionReadError(substage);
        }),
      ).rejects.toThrow(`m157_acceptance_first_protection_graph_${substage}`);
    },
  );

  it("does not expose raw Product Graph provider details", async () => {
    const error = new ProductProtectionReadError("classifications");
    Object.defineProperty(error, "cause", { value: new Error("private provider response") });
    await expect(
      withM157AcceptanceStage("first_protection_graph_unavailable", async () => {
        throw error;
      }),
    ).rejects.toThrow("m157_acceptance_first_protection_graph_classifications");
  });
});
