import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("M15.78R host-side EC2 identity handoff", () => {
  it("passes helper and deployment-preflight regression suites", () => {
    const python = process.platform === "win32" ? "python" : "python3";
    const result = spawnSync(python, ["verification-runner/host/test_fetch_ec2_identity.py"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error?.message).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);

    const deploymentTests = spawnSync(
      python,
      ["verification-runner/host/test_deploy_identity_handoff.py"],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    expect(deploymentTests.error?.message).toBeUndefined();
    expect(deploymentTests.status, deploymentTests.stderr).toBe(0);
  });
});
