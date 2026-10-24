import { createPublicKey } from "node:crypto";
import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSignedDependencyCacheReference } from "@/lib/fix-engine/verification-artifacts";
import {
  dependencyCacheIdentityKey,
  FIX_VERIFICATION_RUNTIME_PROFILE,
  type DependencyCacheIdentity,
} from "@/lib/fix-engine/dependency-cache";
import {
  dependencyCacheManifestFingerprint,
  sha256,
  VERIFICATION_RUNNER_PROTOCOL_VERSION,
} from "../../verification-runner/contracts";
import {
  attestExpectedRunner,
  isExpectedRunnerEndpoint,
  verificationRunnerProtocolMatches,
} from "./recover-internal-fix-verification-after-cache-repair";

const FIX_RUN_ID = "8d38263a-8c0c-41cc-aaf0-e85770c1bfdb";
const VERIFY_STAGE_ID = "731cab44-66df-4fe4-9794-b55ecabd1b3f";
const AUTHORIZATION_REFERENCE =
  "M15.78R user-authorized fresh V4 verification recovery after snapshot extraction repair" as const;
/** Image-store ID attested in run_06gmmt15a34ptruvhru1r0a3a2 for the snapshot-extraction runner. */
const EXPECTED_RUNNER_IMAGE_ID =
  "sha256:6b5bcfbade5f2a8293918884cf6225ce24e705e7328529aee2772f264b4a32c4";
const CACHE_IDENTITY: DependencyCacheIdentity = {
  repositoryId: "b2abf377-2dbc-4b9c-b546-b0604f3ee4fe",
  repositoryIdentity: "michelpronkk-oss/auterim-m15-github-qa",
  commitSha: "94135df6f85bfb34ac83c046e5541e1ad8d73a86",
  packageManager: "npm",
  packageManifestSha256: "fc250c3608525b9d117563bea13532e66cda475074ff509d9e416720db071ed7",
  lockfileSha256: "4f917004087dc01a6f38bd405fc6bd340bd57048f0b63f6245efbf83d547063a",
  runtimeProfile: FIX_VERIFICATION_RUNTIME_PROFILE,
};
const EXPECTED_CACHE_IDENTITY_KEY =
  "86ab5d3a45b9e1a5218418e7856cb48b1c8fadf242c0b5ffb18ffb517463832c";
const EXPECTED_CACHE_PUBLIC_KEY_FINGERPRINT =
  "071a6d11f634731fb4c1673278cd69cb70607725455dcdac46dff8eb78a7180f";

/**
 * Operator-only, single-use recovery of the fresh V4 acceptance verify stage after the
 * snapshot-extraction runner repair. Reuses the run's stored diagnosis, plan and patch;
 * the database RPC pins every identity and requeues only the failed verify stage once.
 */
export const recoverFreshV4VerificationTask = schemaTask({
  id: "recover-fresh-v4-verification",
  schema: z
    .object({
      fixRunId: z.literal(FIX_RUN_ID),
      authorizationReference: z.literal(AUTHORIZATION_REFERENCE),
    })
    .strict(),
  retry: { maxAttempts: 1 },
  maxDuration: 180,
  queue: { concurrencyLimit: 1 },
  run: async ({ fixRunId }, { ctx }) => {
    if (dependencyCacheIdentityKey(CACHE_IDENTITY) !== EXPECTED_CACHE_IDENTITY_KEY)
      return { status: "blocked", category: "verification_recovery_scope_invalid" } as const;

    const environment = getEnvironment();
    if (environment.FIX_GITHUB_DRAFT_PR_WRITES !== "0")
      return { status: "blocked", category: "draft_pr_writes_must_remain_disabled" } as const;
    if (!environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY)
      return { status: "blocked", category: "verification_cache_key_unavailable" } as const;
    try {
      const fingerprint = sha256(
        Buffer.from(
          createPublicKey(environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY).export({
            type: "spki",
            format: "der",
          }),
        ),
      );
      if (fingerprint !== EXPECTED_CACHE_PUBLIC_KEY_FINGERPRINT)
        return { status: "blocked", category: "verification_cache_key_mismatch" } as const;
    } catch {
      return { status: "blocked", category: "verification_cache_key_invalid" } as const;
    }
    if (
      environment.FIX_VERIFICATION_RUNNER_PROTOCOL !== VERIFICATION_RUNNER_PROTOCOL_VERSION ||
      !environment.FIX_VERIFICATION_RUNNER_URL ||
      !isExpectedRunnerEndpoint(environment.FIX_VERIFICATION_RUNNER_URL) ||
      !(await verificationRunnerProtocolMatches(environment.FIX_VERIFICATION_RUNNER_URL))
    )
      return { status: "blocked", category: "verification_runner_protocol_unverified" } as const;
    if (!environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET)
      return { status: "blocked", category: "verification_runner_auth_unavailable" } as const;
    const runnerIdentity = await attestExpectedRunner(
      environment.FIX_VERIFICATION_RUNNER_URL,
      environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET,
    );
    if (!runnerIdentity || runnerIdentity.runnerContainerImageId !== EXPECTED_RUNNER_IMAGE_ID)
      return { status: "blocked", category: "verification_runner_identity_unverified" } as const;

    let cache: Awaited<ReturnType<typeof createSignedDependencyCacheReference>>;
    try {
      cache = await createSignedDependencyCacheReference({
        identity: CACHE_IDENTITY,
        publicKey: environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY,
      });
    } catch {
      return { status: "blocked", category: "verification_cache_not_verified" } as const;
    }
    const client = createSupabaseServerClient();
    const { data: archive, error: archiveError } = await client.storage
      .from(cache.archive.bucket)
      .download(cache.archive.path);
    if (archiveError || !archive)
      return { status: "blocked", category: "verification_cache_archive_unavailable" } as const;
    const archiveBytes = Buffer.from(await archive.arrayBuffer());
    if (
      archiveBytes.byteLength !== cache.manifest.archiveByteCount ||
      sha256(archiveBytes) !== cache.manifest.archiveSha256 ||
      cache.manifest.identityKey !== EXPECTED_CACHE_IDENTITY_KEY ||
      dependencyCacheManifestFingerprint(cache.manifest) !== cache.manifest.manifestFingerprint
    )
      return { status: "blocked", category: "verification_cache_archive_mismatch" } as const;

    const { data, error } = await client.rpc("authorize_fresh_v4_fix_verification_recovery", {
      p_fix_run_id: fixRunId,
      p_authorization_reference: AUTHORIZATION_REFERENCE,
      p_trigger_run_id: ctx.run.id,
      p_cache_identity_key: cache.manifest.identityKey,
      p_cache_manifest_fingerprint: cache.manifest.manifestFingerprint,
      p_cache_archive_sha256: cache.manifest.archiveSha256,
      p_cache_tree_sha256: cache.manifest.treeSha256,
      p_runner_attestation_account: runnerIdentity.accountId,
      p_runner_attestation_region: runnerIdentity.region,
      p_runner_attestation_instance_id: runnerIdentity.instanceId,
      p_runner_image_id: runnerIdentity.runnerContainerImageId,
      p_runner_protocol: environment.FIX_VERIFICATION_RUNNER_PROTOCOL,
    });
    if (
      !error &&
      data?.status === "already_consumed" &&
      data.fixRunId === fixRunId &&
      data.stageId === VERIFY_STAGE_ID &&
      typeof data.recoveryId === "string"
    )
      return {
        status: "recovery_already_consumed",
        fixRunId,
        recoveryId: data.recoveryId,
        stageId: VERIFY_STAGE_ID,
        stageStatus: data.stageStatus,
      } as const;
    if (
      error ||
      !data ||
      data.fixRunId !== fixRunId ||
      data.stageId !== VERIFY_STAGE_ID ||
      typeof data.recoveryId !== "string" ||
      !["retry_queued", "already_authorized"].includes(data.status)
    )
      return { status: "blocked", category: "verification_recovery_not_eligible" } as const;

    // The original verify delivery key is still within its 30d TTL, so the recovery uses
    // its own key derived from the immutable authorization row.
    const run = await tasks.trigger(
      "process-fix-engine-stage",
      { fixRunId, stage: "verify_patch" },
      {
        idempotencyKey: `fix-engine:fresh-v4-verification-recovery:${data.recoveryId}`,
        idempotencyKeyTTL: "30d",
      },
    );
    return {
      status: "recovery_dispatched",
      fixRunId,
      recoveryId: data.recoveryId,
      stageId: VERIFY_STAGE_ID,
      runnerImageId: runnerIdentity.runnerContainerImageId,
      cacheIdentityKey: cache.manifest.identityKey,
      cacheManifestFingerprint: cache.manifest.manifestFingerprint,
      triggerRunId: run.id,
    } as const;
  },
});
