import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Trigger production and local M15 manifests", () => {
  it("keeps the local acceptance task outside the default production task directory", async () => {
    const [productionConfig, localConfig, qaTask] = await Promise.all([
      readFile(path.join(root, "trigger.config.ts"), "utf8"),
      readFile(path.join(root, "trigger.m15-local.config.ts"), "utf8"),
      readFile(path.join(root, "src/trigger-m15-local/m15-local-acceptance-round-trip.ts"), "utf8"),
    ]);

    expect(productionConfig).toContain('project: "proj_hwqtxtyrvwykjirkrdoh"');
    expect(productionConfig).toContain('dirs: ["./src/trigger"]');
    expect(productionConfig).not.toContain("trigger-m15-local");
    expect(productionConfig).not.toContain("m15-local-acceptance-round-trip");

    expect(localConfig).toContain('project: "proj_hwqtxtyrvwykjirkrdoh"');
    expect(localConfig).toContain('dirs: ["./src/trigger", "./src/trigger-m15-local"]');
    expect(qaTask).toContain('id: "m15-local-acceptance-round-trip"');
    expect(qaTask).toContain('process.env.AUTERIM_M15_LOCAL_INTEGRATION !== "1"');
  });

  it("selects the local manifest only in the guarded M15 Development launcher", async () => {
    const [launcher, packageJson] = await Promise.all([
      readFile(path.join(root, "scripts/m15-validation/trigger-dev-roundtrip.mts"), "utf8"),
      readFile(path.join(root, "package.json"), "utf8"),
    ]);

    expect(launcher.match(/"--config",\s*"trigger\.m15-local\.config\.ts"/g)).toHaveLength(2);
    expect(launcher).toContain('const triggerCliVersion = "4.7.2"');
    expect(packageJson).toContain('"acceptance:m15:entitlements"');
  });
});
