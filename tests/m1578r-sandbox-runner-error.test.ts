import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withExactBaseGitHubSnapshot } from "@/lib/fix-engine/sandbox";
import {
  terminalRunnerFailure,
  withVerificationRunnerCorrelation,
} from "@/lib/fix-engine/verification-retry";

const diff = [
  "diff --git a/endpoint.txt b/endpoint.txt",
  "--- a/endpoint.txt",
  "+++ b/endpoint.txt",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

function sandboxInput<T>(run: (checkoutPath: string) => Promise<T>) {
  return {
    expectedBaseSha: "a".repeat(40),
    materialize: async (destination: string) => {
      await writeFile(path.join(destination, "endpoint.txt"), "old\n");
      return { skippedLinks: 0 };
    },
    unifiedDiff: diff,
    run,
  };
}

describe("M15.78R sandbox error propagation", () => {
  it("preserves a typed runner failure with its diagnostic and job correlation", async () => {
    const failure = withVerificationRunnerCorrelation(
      terminalRunnerFailure("runner_result_invalid", {
        phase: "result_validation",
        httpStatus: 200,
        responseCategory: null,
        reason: "result_identity_mismatch",
        identityField: "patchFingerprint",
      }),
      {
        jobId: "a".repeat(64),
        requestFingerprint: "b".repeat(64),
        admissionState: "accepted",
      },
    );

    await expect(
      withExactBaseGitHubSnapshot(
        sandboxInput(async () => {
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
  });

  it("continues sanitizing unrelated errors without exposing arbitrary content", async () => {
    await expect(
      withExactBaseGitHubSnapshot(
        sandboxInput(async () => {
          throw new Error("private secret: do not expose");
        }),
      ),
    ).rejects.toThrow("sandbox_setup_failed");
  });
});
