import "server-only";
import { getEnvironment } from "@/lib/env/schema";
import { runVerificationInDocker, FIX_VERIFICATION_IMAGE } from "@/lib/fix-engine/sandbox";
import type { TrustedDependencyCache } from "@/lib/fix-engine/dependency-cache";
import type { VerificationProfile } from "@/lib/fix-engine/verification-profile";
import {
  createVerificationJobRequest,
  RemoteVerificationRunnerClient,
} from "@/lib/fix-engine/verification-runner-client";
import type {
  PrivateArtifactReference,
  SignedDependencyCacheReference,
} from "@/lib/fix-engine/verification-artifacts";
import type { DependencyCacheIdentity } from "@/lib/fix-engine/cache-identity";
import type { VerificationJobResult } from "../../../verification-runner/contracts";

export type RemoteVerificationInput = {
  workspaceId: string;
  productId: string | null;
  fixRunId: string;
  planId: string;
  planFingerprint: string;
  evidenceFingerprint: string;
  patchId: string;
  patchFingerprint: string;
  allowedPaths: string[];
  repositoryId: string;
  repositoryIdentity: string;
  baseCommitSha: string;
  dependencyCacheIdentity: DependencyCacheIdentity;
  cache: SignedDependencyCacheReference;
  snapshot: PrivateArtifactReference;
  patch: PrivateArtifactReference;
};

export type VerificationExecutorInput = {
  checkoutPath: string;
  profile: VerificationProfile;
  commands: VerificationProfile["commands"];
  localDependencyCache: TrustedDependencyCache | null;
  remote?: RemoteVerificationInput;
};

export type VerificationExecutorResult = {
  status: "passed" | "failed" | "verification_unsupported";
  checks: Array<{
    commandClass: string;
    status: "passed" | "failed";
    durationMs: number;
    outputBytes: number;
    diagnosticCategory: string | null;
  }>;
  durationMs: number;
  remoteResult?: VerificationJobResult;
};

export interface VerificationExecutor {
  readonly kind: "local_docker" | "remote";
  execute(input: VerificationExecutorInput): Promise<VerificationExecutorResult>;
}

export class LocalDockerVerificationExecutor implements VerificationExecutor {
  readonly kind = "local_docker" as const;

  async execute(input: VerificationExecutorInput): Promise<VerificationExecutorResult> {
    if (!input.localDependencyCache || input.localDependencyCache.status !== "available")
      throw new Error("trusted_dependency_cache_unavailable");
    const started = Date.now();
    const checks: VerificationExecutorResult["checks"] = [];
    for (const command of input.commands) {
      const result = await runVerificationInDocker({
        checkoutPath: input.checkoutPath,
        image: FIX_VERIFICATION_IMAGE,
        command,
        dependencyCache: input.localDependencyCache,
      });
      checks.push({ commandClass: command.commandClass, ...result });
      if (result.status !== "passed") break;
    }
    return {
      status:
        checks.length === input.commands.length &&
        checks.every((check) => check.status === "passed")
          ? "passed"
          : "failed",
      checks,
      durationMs: Date.now() - started,
    };
  }
}

export class RemoteVerificationExecutor implements VerificationExecutor {
  readonly kind = "remote" as const;

  constructor(private readonly client: RemoteVerificationRunnerClient) {}

  async execute(input: VerificationExecutorInput): Promise<VerificationExecutorResult> {
    const remote = input.remote;
    if (!remote) throw new Error("verification_runner_request_missing");
    const request = createVerificationJobRequest({
      identity: {
        workspaceId: remote.workspaceId,
        productId: remote.productId,
        fixRunId: remote.fixRunId,
        planId: remote.planId,
        planFingerprint: remote.planFingerprint,
        evidenceFingerprint: remote.evidenceFingerprint,
        patchId: remote.patchId,
        patchFingerprint: remote.patchFingerprint,
        allowedPaths: remote.allowedPaths,
        repositoryId: remote.repositoryId,
        repositoryIdentity: remote.repositoryIdentity,
        baseCommitSha: remote.baseCommitSha,
        packageManager: remote.dependencyCacheIdentity.packageManager as "npm",
        packageManifestSha256: remote.dependencyCacheIdentity.packageManifestSha256,
        lockfileSha256: remote.dependencyCacheIdentity.lockfileSha256,
        runtimeProfile: remote.dependencyCacheIdentity.runtimeProfile,
        profileId: input.profile.id as "javascript-typescript-v1",
        profileVersion: "javascript-typescript-v1",
        cacheIdentityKey: remote.cache.manifest.identityKey,
        cacheTreeSha256: remote.cache.manifest.treeSha256,
      },
      snapshot: remote.snapshot,
      patch: remote.patch,
      cacheArchive: remote.cache.archive,
      cacheManifest: remote.cache.manifest,
      cacheSignature: remote.cache.signature,
      commands: input.commands,
    });
    const result = await this.client.execute(request);
    return {
      status: result.status,
      checks: result.checks,
      durationMs: result.durationMs,
      remoteResult: result,
    };
  }
}

/** Production is always remote; callers cannot select an executor. */
export function createServerAuthoritativeVerificationExecutor(): VerificationExecutor {
  if (process.env.NODE_ENV !== "production") return new LocalDockerVerificationExecutor();
  const environment = getEnvironment();
  if (
    !environment.FIX_VERIFICATION_RUNNER_URL ||
    !environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET ||
    environment.FIX_VERIFICATION_RUNNER_PROTOCOL !== "m1578-verification-runner-v1"
  )
    throw new Error("verification_runner_not_configured");
  return new RemoteVerificationExecutor(
    new RemoteVerificationRunnerClient({
      url: environment.FIX_VERIFICATION_RUNNER_URL,
      authSecret: environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET,
    }),
  );
}
