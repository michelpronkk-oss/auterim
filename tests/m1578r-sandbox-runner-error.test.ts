import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withExactBaseFixCheckout, withExactBaseGitHubSnapshot } from "@/lib/fix-engine/sandbox";
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

  it("preserves typed runner failures in the local exact-base checkout wrapper", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "auterim-sandbox-runner-error-"));
    const sourceRepositoryPath = path.join(root, "source");
    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    };
    try {
      await mkdir(sourceRepositoryPath, { recursive: true });
      await writeFile(path.join(sourceRepositoryPath, "endpoint.txt"), "old\n");
      execFileSync("git", ["init", "--quiet", sourceRepositoryPath], { env: gitEnv });
      execFileSync("git", ["-C", sourceRepositoryPath, "add", "--all"], { env: gitEnv });
      execFileSync(
        "git",
        [
          "-C",
          sourceRepositoryPath,
          "-c",
          "user.name=Auterim Test",
          "-c",
          "user.email=test@auterim.invalid",
          "commit",
          "--quiet",
          "-m",
          "fixture",
        ],
        { env: gitEnv },
      );
      const expectedBaseSha = execFileSync(
        "git",
        ["-C", sourceRepositoryPath, "rev-parse", "HEAD"],
        { encoding: "utf8", env: gitEnv },
      ).trim();
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
        withExactBaseFixCheckout({
          sourceRepositoryPath,
          expectedBaseSha,
          unifiedDiff: diff,
          run: async () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
