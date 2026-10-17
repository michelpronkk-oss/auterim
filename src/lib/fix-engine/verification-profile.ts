import { resolveLockedPackageManager } from "@/lib/fix-engine/package-manager";

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

const VERIFICATION_TARGET = { os: "linux", cpu: "x64" } as const;

function excludesTargetPlatform(value: unknown, target: string): boolean {
  if (typeof value === "string") value = [value];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  )
    return false;
  const values = value.map((item: string) => item.toLowerCase());
  const denied = values.some((item: string) => item.startsWith("!") && item.slice(1) === target);
  const allowed = values.filter((item: string) => !item.startsWith("!"));
  return denied || (allowed.length > 0 && !allowed.includes(target));
}

export function npmLockRequiresInstallScripts(lockValue: unknown): boolean {
  let lock = lockValue;
  if (typeof lock === "string") {
    try {
      lock = JSON.parse(lock) as unknown;
    } catch {
      throw new Error("package_lock_invalid");
    }
  }
  if (!lock || typeof lock !== "object" || Array.isArray(lock))
    throw new Error("package_lock_invalid");
  const packages = (lock as { packages?: unknown }).packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages))
    throw new Error("package_lock_invalid");
  return Object.entries(packages).some(([name, entry]) => {
    // The root package's own scripts are never run by the builder (`npm ci
    // --ignore-scripts`) and are not third-party dependency preparation.
    if (name === "") return false;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const packageEntry = entry as {
      hasInstallScript?: unknown;
      optional?: unknown;
      os?: unknown;
      cpu?: unknown;
    };
    if (packageEntry.hasInstallScript !== true) return false;
    // Optional packages that npm will not install for the pinned Linux x64
    // verification runtime do not require lifecycle preparation in that cache.
    const optionalAndIncompatible =
      packageEntry.optional === true &&
      (excludesTargetPlatform(packageEntry.os, VERIFICATION_TARGET.os) ||
        excludesTargetPlatform(packageEntry.cpu, VERIFICATION_TARGET.cpu));
    return !optionalAndIncompatible;
  });
}

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
  packageLock?: unknown;
}): VerificationProfile {
  const manifest = input.packageJson as Manifest;
  const names = new Set(input.files);
  const packageManager = resolveLockedPackageManager(manifest, names) ?? "unsupported";
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
  // Only npm's flat node_modules layout is currently materialized by the
  // signed cache builder. pnpm symlink stores and Yarn Plug'n'Play need a
  // separately versioned cache adapter and are rejected until then.
  if (packageManager !== "npm")
    return {
      id: "javascript-typescript-v1",
      packageManager,
      monorepo,
      commands: [],
      state: "verification_unsupported",
      reason: "package_manager_layout_unsupported",
    };
  if (input.packageLock !== undefined) {
    try {
      if (npmLockRequiresInstallScripts(input.packageLock))
        return {
          id: "javascript-typescript-v1",
          packageManager,
          monorepo,
          commands: [],
          state: "verification_unsupported",
          reason: "dependency_install_scripts_required",
        };
    } catch {
      return {
        id: "javascript-typescript-v1",
        packageManager,
        monorepo,
        commands: [],
        state: "verification_unsupported",
        reason: "package_lock_invalid",
      };
    }
  }
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
      commandClass: testPaths.length ? "targeted_test" : "test",
      executable: "node",
      args: ["node_modules/jest/bin/jest.js", ...testPaths, "--runInBand"],
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
