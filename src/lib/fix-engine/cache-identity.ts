import { createHash } from "node:crypto";
import { resolveLockedPackageManager } from "./package-manager";

export const FIX_VERIFICATION_RUNTIME_PROFILE =
  "node24-linux-x64-alpine3.22-sha256-3e843c608bb5232f39ecb2b25e41214b958b0795914707374c8acc28487dea17";

export type DependencyCacheIdentity = {
  repositoryId: string;
  repositoryIdentity: string;
  commitSha: string;
  packageManager: "npm" | "pnpm" | "yarn";
  packageManifestSha256: string;
  lockfileSha256: string;
  runtimeProfile: string;
};

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown) {
  return JSON.stringify(value);
}

export function createDependencyCacheIdentity(input: {
  repositoryId: string;
  repositoryIdentity: string;
  commitSha: string;
  packageJson: string;
  lockfiles: Record<string, string>;
  runtimeProfile?: string;
}): DependencyCacheIdentity | null {
  const lockNames = Object.keys(input.lockfiles).sort();
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(input.packageJson);
  } catch {
    return null;
  }
  const manager = resolveLockedPackageManager(packageJson, ["package.json", ...lockNames]);
  if (!manager || !/^[a-f0-9]{40,64}$/i.test(input.commitSha)) return null;
  const lockPayload = lockNames.map((name) => `${name}\0${input.lockfiles[name] ?? ""}`).join("\0");
  return {
    repositoryId: input.repositoryId,
    repositoryIdentity: input.repositoryIdentity.toLowerCase(),
    commitSha: input.commitSha.toLowerCase(),
    packageManager: manager,
    packageManifestSha256: sha256(input.packageJson),
    lockfileSha256: sha256(lockPayload),
    runtimeProfile: input.runtimeProfile ?? FIX_VERIFICATION_RUNTIME_PROFILE,
  };
}

export function dependencyCacheIdentityKey(identity: DependencyCacheIdentity) {
  return sha256(canonical(identity));
}
