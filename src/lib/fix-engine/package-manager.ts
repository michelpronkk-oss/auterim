export type SupportedPackageManager = "npm" | "pnpm" | "yarn";

type PackageManifest = { packageManager?: unknown };

/** Resolve one exact lockfile family and reject ambiguous or inconsistent metadata. */
export function resolveLockedPackageManager(
  packageJson: unknown,
  files: Iterable<string>,
): SupportedPackageManager | null {
  const manifest =
    packageJson && typeof packageJson === "object" ? (packageJson as PackageManifest) : {};
  const names = new Set(files);
  const lockfiles = [
    names.has("package-lock.json") || names.has("npm-shrinkwrap.json") ? "npm" : null,
    names.has("pnpm-lock.yaml") ? "pnpm" : null,
    names.has("yarn.lock") ? "yarn" : null,
  ].filter((value): value is SupportedPackageManager => value !== null);

  if (lockfiles.length !== 1) return null;
  const lockedManager = lockfiles[0];
  if (typeof manifest.packageManager !== "string") return lockedManager;

  const match = /^(npm|pnpm|yarn)@[^\s]+$/.exec(manifest.packageManager);
  if (!match || match[1] !== lockedManager) return null;
  return lockedManager;
}
