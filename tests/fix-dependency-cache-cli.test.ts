import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

function runBuilder(args: string[]) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/build-fix-dependency-cache.mts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT ?? "" } : {}),
        NODE_ENV: "test",
      },
    },
  );
}

describe("dependency cache CLI native Node entrypoint", () => {
  it("loads without a bundler and rejects missing arguments", () => {
    const result = runBuilder([]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dependency_cache_builder_arguments_invalid");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  });

  it("rejects absent configuration before reading or building a source cache", () => {
    const result = runBuilder([
      "c4c0d571-8610-4d0c-9a71-4be0a7d6a176",
      "fixture.invalid/cache-cli",
      "a".repeat(40),
      path.resolve("nonexistent-cache-cli-source"),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("dependency_cache_builder_not_configured");
  });
});
