export type VerificationCommandClass = "targeted_test" | "test" | "typecheck" | "lint" | "build";
export type VerificationCommand = {
  commandClass: VerificationCommandClass;
  executable: "node";
  args: string[];
};
export type VerificationProfile = {
  id: string;
  packageManager: "npm" | "pnpm" | "yarn" | "unsupported";
  monorepo: boolean;
  commands: VerificationCommand[];
  state: "supported" | "verification_unsupported";
  reason: string | null;
};

type Manifest = {
  packageManager?: string;
  workspaces?: unknown;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};

export function resolveVerificationProfile(input: {
  packageJson: unknown;
  files: string[];
  targetedTestPaths?: string[];
  dependencyCacheAvailable?: boolean;
}): VerificationProfile {
  const manifest = input.packageJson as Manifest;
  const names = new Set(input.files);
  const packageManager =
    manifest.packageManager?.startsWith("pnpm@") || names.has("pnpm-lock.yaml")
      ? "pnpm"
      : manifest.packageManager?.startsWith("yarn@") || names.has("yarn.lock")
        ? "yarn"
        : names.has("package-lock.json") || names.has("npm-shrinkwrap.json")
          ? "npm"
          : "unsupported";
  const monorepo = Boolean(manifest.workspaces) || names.has("pnpm-workspace.yaml");
  if (packageManager === "unsupported")
    return {
      id: "javascript-typescript-v1",
      packageManager,
      monorepo,
      commands: [],
      state: "verification_unsupported",
      reason: "lockfile_not_recognized",
    };
  if (input.dependencyCacheAvailable !== true)
    return {
      id: "javascript-typescript-v1",
      packageManager,
      monorepo,
      commands: [],
      state: "verification_unsupported",
      reason: "trusted_dependency_cache_unavailable",
    };
  if (monorepo)
    return {
      id: "javascript-typescript-v1",
      packageManager,
      monorepo,
      commands: [],
      state: "verification_unsupported",
      reason: "monorepo_profile_not_supported",
    };
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const commands: VerificationCommand[] = [];
  const testPaths = (input.targetedTestPaths ?? [])
    .filter(
      (path) =>
        isSafeRepoPath(path) &&
        (path.startsWith("test/") || path.startsWith("tests/")) &&
        names.has(path),
    )
    .slice(0, 20);
  if (testPaths.length && dependencies.vitest)
    commands.push({
      commandClass: "targeted_test",
      executable: "node",
      args: ["node_modules/vitest/vitest.mjs", "run", ...testPaths],
    });
  else if (dependencies.vitest)
    commands.push({
      commandClass: "test",
      executable: "node",
      args: ["node_modules/vitest/vitest.mjs", "run"],
    });
  else if (dependencies["jest"] && names.has("jest.config.js"))
    commands.push({
      commandClass: "test",
      executable: "node",
      args: ["node_modules/jest/bin/jest.js", "--runInBand"],
    });
  else
    return {
      id: "javascript-typescript-v1",
      packageManager,
      monorepo,
      commands: [],
      state: "verification_unsupported",
      reason: "known_test_runner_not_found",
    };
  if (dependencies.typescript)
    commands.push({
      commandClass: "typecheck",
      executable: "node",
      args: ["node_modules/typescript/bin/tsc", "--noEmit"],
    });
  if (dependencies.eslint)
    commands.push({
      commandClass: "lint",
      executable: "node",
      args: ["node_modules/eslint/bin/eslint.js", "."],
    });
  if (dependencies.next)
    commands.push({
      commandClass: "build",
      executable: "node",
      args: ["node_modules/next/dist/bin/next", "build"],
    });
  if (
    !commands.some(
      (command) => command.commandClass === "typecheck" || command.commandClass === "build",
    )
  ) {
    return {
      id: "javascript-typescript-v1",
      packageManager,
      monorepo,
      commands: [],
      state: "verification_unsupported",
      reason: "no_supported_static_verification",
    };
  }
  return {
    id: "javascript-typescript-v1",
    packageManager,
    monorepo,
    commands,
    state: "supported",
    reason: null,
  };
}

export function assertStructuredCommand(command: VerificationCommand): void {
  if (command.executable !== "node" || command.args.some((arg) => /[;&|<>`$\n\r]/.test(arg)))
    throw new Error("unsafe_verification_command");
  const allowedEntryPoints = new Set([
    "node_modules/vitest/vitest.mjs",
    "node_modules/jest/bin/jest.js",
    "node_modules/typescript/bin/tsc",
    "node_modules/eslint/bin/eslint.js",
    "node_modules/next/dist/bin/next",
  ]);
  if (!allowedEntryPoints.has(command.args[0] ?? ""))
    throw new Error("verification_entrypoint_not_allowlisted");
}
import { isSafeRepoPath } from "@/lib/fix-engine/contracts";
