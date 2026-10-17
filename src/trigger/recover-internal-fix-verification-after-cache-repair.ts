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
import { dependencyCacheManifestFingerprint, sha256 } from "../../verification-runner/contracts";

const FIX_RUN_ID = "7de04a75-aefa-43a6-ba64-9fa4a70e0ec1";
const VERIFY_STAGE_ID = "bd3238d9-79a9-46ca-88d1-e67f346ecc0a";
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

export const recoverInternalFixVerificationAfterCacheRepairTask = schemaTask({
  id: "recover-internal-fix-verification-after-cache-repair",
  schema: z.discriminatedUnion("action", [
    z
      .object({
        action: z.literal("verify_signing_key"),
        publicKeyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    z.object({ action: z.literal("recover"), fixRunId: z.string().uuid() }).strict(),
  ]),
  retry: { maxAttempts: 1 },
  maxDuration: 180,
  queue: { concurrencyLimit: 1 },
  run: async (input, { ctx }) => {
    if (input.action === "verify_signing_key") {
      const publicKey = getEnvironment().FIX_DEPENDENCY_CACHE_PUBLIC_KEY;
      if (!publicKey) {
        return { status: "blocked", category: "verification_cache_key_unavailable" } as const;
      }
      try {
        const configuredFingerprint = sha256(
          Buffer.from(createPublicKey(publicKey).export({ type: "spki", format: "der" })),
        );
        return {
          status: "checked",
          publicKeyMatches: configuredFingerprint === input.publicKeyFingerprint,
        } as const;
      } catch {
        return { status: "blocked", category: "verification_cache_key_invalid" } as const;
      }
    }

    const { fixRunId } = input;
    if (
      fixRunId !== FIX_RUN_ID ||
      dependencyCacheIdentityKey(CACHE_IDENTITY) !== EXPECTED_CACHE_IDENTITY_KEY
    ) {
      return { status: "blocked", category: "verification_recovery_scope_invalid" } as const;
    }

    const environment = getEnvironment();
    if (!environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY) {
      return { status: "blocked", category: "verification_cache_key_unavailable" } as const;
    }

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
    if (archiveError || !archive) {
      return { status: "blocked", category: "verification_cache_archive_unavailable" } as const;
    }
    const archiveBytes = Buffer.from(await archive.arrayBuffer());
    if (
      archiveBytes.byteLength !== cache.manifest.archiveByteCount ||
      sha256(archiveBytes) !== cache.manifest.archiveSha256 ||
      cache.manifest.identityKey !== EXPECTED_CACHE_IDENTITY_KEY ||
      dependencyCacheManifestFingerprint(cache.manifest) !== cache.manifest.manifestFingerprint
    ) {
      return { status: "blocked", category: "verification_cache_archive_mismatch" } as const;
    }

    const { data, error } = await client.rpc("authorize_internal_fix_verification_recovery", {
      p_fix_run_id: fixRunId,
      p_authorization_reference: "M15.78R user-authorized single bounded verification recovery",
      p_trigger_run_id: ctx.run.id,
      p_cache_identity_key: cache.manifest.identityKey,
      p_cache_manifest_fingerprint: cache.manifest.manifestFingerprint,
      p_cache_archive_sha256: cache.manifest.archiveSha256,
      p_cache_tree_sha256: cache.manifest.treeSha256,
    });
    if (
      error ||
      !data ||
      data.fixRunId !== fixRunId ||
      data.stageId !== VERIFY_STAGE_ID ||
      typeof data.recoveryId !== "string" ||
      data.recoveryGeneration !== 1 ||
      !["retry_queued", "already_authorized"].includes(data.status)
    ) {
      return { status: "blocked", category: "verification_recovery_not_eligible" } as const;
    }

    const run = await tasks.trigger(
      "process-fix-engine-stage",
      { fixRunId, stage: "verify_patch" },
      {
        idempotencyKey: `fix-engine:authorized-recovery:${data.recoveryId}`,
        idempotencyKeyTTL: "30d",
      },
    );
    return {
      status: "recovery_dispatched",
      fixRunId,
      recoveryId: data.recoveryId,
      stageId: VERIFY_STAGE_ID,
      cacheIdentityKey: cache.manifest.identityKey,
      cacheManifestFingerprint: cache.manifest.manifestFingerprint,
      cacheArchiveSha256: cache.manifest.archiveSha256,
      cacheTreeSha256: cache.manifest.treeSha256,
      triggerRunId: run.id,
    } as const;
  },
});
