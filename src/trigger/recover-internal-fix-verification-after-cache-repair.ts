import { createPublicKey, randomBytes } from "node:crypto";
import { schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSignedDependencyCacheReference } from "@/lib/fix-engine/verification-artifacts";
import { parseBoundedJsonResponse } from "@/lib/fix-engine/verification-runner-client";
import {
  createIdentityAttestationRequestHeaders,
  EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS,
  verifyRunnerIdentityAttestation,
} from "@/lib/fix-engine/runner-identity-attestation";
import {
  dependencyCacheIdentityKey,
  FIX_VERIFICATION_RUNTIME_PROFILE,
  type DependencyCacheIdentity,
} from "@/lib/fix-engine/dependency-cache";
import {
  dependencyCacheManifestFingerprint,
  canonicalJson,
  sha256,
  VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
  VerificationRunnerIdentityAttestationRequestSchema,
  VERIFICATION_RUNNER_PROTOCOL_VERSION,
} from "../../verification-runner/contracts";

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
const EXPECTED_CACHE_PUBLIC_KEY_FINGERPRINT =
  "071a6d11f634731fb4c1673278cd69cb70607725455dcdac46dff8eb78a7180f";
const G3_AUTHORIZATION_REFERENCE =
  "M15.78R user-authorized generation 3 after diagnostic readback preparation" as const;

export async function attestExpectedRunner(baseUrl: string, authSecret: string) {
  try {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" ||
      url.origin !== "https://verify.auterim.com" ||
      (url.pathname !== "/" && url.pathname !== "") ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== ""
    )
      return null;
    const nonce = randomBytes(32).toString("hex");
    const requestBody = VerificationRunnerIdentityAttestationRequestSchema.parse({ nonce });
    const body = Buffer.from(canonicalJson(requestBody), "utf8");
    const response = await fetch(new URL(VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH, url), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
      headers: createIdentityAttestationRequestHeaders({ body, secret: authSecret, nonce }),
      body,
    });
    const parsed = await parseBoundedJsonResponse(response);
    if (!response.ok) return null;
    return verifyRunnerIdentityAttestation({
      body: parsed.value,
      responseSignature: response.headers.get("x-auterim-identity-signature"),
      requestNonce: nonce,
      authSecret,
    });
  } catch {
    return null;
  }
}

export async function verificationRunnerProtocolMatches(baseUrl: string) {
  try {
    const origin = new URL(baseUrl);
    if (origin.protocol !== "https:") return false;
    const response = await fetch(new URL("/healthz", origin), {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > 2_048) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = await response.text();
    if (Buffer.byteLength(body, "utf8") > 2_048) return false;
    const value: unknown = JSON.parse(body);
    return (
      typeof value === "object" &&
      value !== null &&
      "status" in value &&
      value.status === "ok" &&
      "protocolVersion" in value &&
      value.protocolVersion === VERIFICATION_RUNNER_PROTOCOL_VERSION
    );
  } catch {
    return false;
  }
}

export function isExpectedRunnerEndpoint(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      url.origin === "https://verify.auterim.com" &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

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
    z.object({ action: z.literal("recover_generation_two"), fixRunId: z.string().uuid() }).strict(),
    z
      .object({
        action: z.literal("recover_generation_three"),
        fixRunId: z.string().uuid(),
        authorizationReference: z.literal(G3_AUTHORIZATION_REFERENCE),
      })
      .strict(),
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
    const recoveryGeneration =
      input.action === "recover_generation_three"
        ? 3
        : input.action === "recover_generation_two"
          ? 2
          : 1;
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
    let runnerIdentity: ReturnType<typeof verifyRunnerIdentityAttestation> | null = null;
    if (recoveryGeneration >= 2) {
      try {
        const actualFingerprint = sha256(
          Buffer.from(
            createPublicKey(environment.FIX_DEPENDENCY_CACHE_PUBLIC_KEY).export({
              type: "spki",
              format: "der",
            }),
          ),
        );
        if (actualFingerprint !== EXPECTED_CACHE_PUBLIC_KEY_FINGERPRINT) {
          return { status: "blocked", category: "verification_cache_key_mismatch" } as const;
        }
      } catch {
        return { status: "blocked", category: "verification_cache_key_invalid" } as const;
      }
      if (environment.FIX_GITHUB_DRAFT_PR_WRITES !== "0") {
        return { status: "blocked", category: "draft_pr_writes_must_remain_disabled" } as const;
      }
      if (
        environment.FIX_VERIFICATION_RUNNER_PROTOCOL !== VERIFICATION_RUNNER_PROTOCOL_VERSION ||
        !environment.FIX_VERIFICATION_RUNNER_URL ||
        (recoveryGeneration === 3 &&
          !isExpectedRunnerEndpoint(environment.FIX_VERIFICATION_RUNNER_URL)) ||
        !(await verificationRunnerProtocolMatches(environment.FIX_VERIFICATION_RUNNER_URL))
      ) {
        return { status: "blocked", category: "verification_runner_protocol_unverified" } as const;
      }
      if (recoveryGeneration === 3) {
        if (!environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET) {
          return { status: "blocked", category: "verification_runner_auth_unavailable" } as const;
        }
        runnerIdentity = await attestExpectedRunner(
          environment.FIX_VERIFICATION_RUNNER_URL,
          environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET,
        );
        if (
          !runnerIdentity ||
          !EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS.includes(
            runnerIdentity.runnerContainerImageId as (typeof EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS)[number],
          )
        ) {
          return {
            status: "blocked",
            category: "verification_runner_identity_unverified",
          } as const;
        }
      }
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

    const rpcArgs = {
      p_fix_run_id: fixRunId,
      p_authorization_reference:
        recoveryGeneration === 2
          ? "M15.78R user-authorized generation 2 after AWS runner public-key correction"
          : "M15.78R user-authorized single bounded verification recovery",
      p_trigger_run_id: ctx.run.id,
      p_cache_identity_key: cache.manifest.identityKey,
      p_cache_manifest_fingerprint: cache.manifest.manifestFingerprint,
      p_cache_archive_sha256: cache.manifest.archiveSha256,
      p_cache_tree_sha256: cache.manifest.treeSha256,
    };
    const { data, error } =
      recoveryGeneration === 3 && runnerIdentity
        ? await client.rpc("authorize_internal_fix_verification_recovery_generation_three", {
            ...rpcArgs,
            p_authorization_reference: G3_AUTHORIZATION_REFERENCE,
            p_runner_attestation_account: runnerIdentity.accountId,
            p_runner_attestation_region: runnerIdentity.region,
            p_runner_attestation_instance_id: runnerIdentity.instanceId,
            p_runner_image_id: runnerIdentity.runnerContainerImageId,
            p_runner_protocol: environment.FIX_VERIFICATION_RUNNER_PROTOCOL,
          })
        : recoveryGeneration === 2
          ? await client.rpc("authorize_internal_fix_verification_recovery_generation_two", rpcArgs)
          : await client.rpc("authorize_internal_fix_verification_recovery", rpcArgs);
    if (
      !error &&
      data?.status === "already_consumed" &&
      data.fixRunId === fixRunId &&
      data.stageId === VERIFY_STAGE_ID &&
      typeof data.recoveryId === "string" &&
      data.recoveryGeneration === 3
    ) {
      return {
        status: "recovery_already_consumed",
        fixRunId,
        recoveryId: data.recoveryId,
        recoveryGeneration: 3,
        stageId: VERIFY_STAGE_ID,
        stageStatus: data.stageStatus,
      } as const;
    }
    if (
      error ||
      !data ||
      data.fixRunId !== fixRunId ||
      data.stageId !== VERIFY_STAGE_ID ||
      typeof data.recoveryId !== "string" ||
      data.recoveryGeneration !== recoveryGeneration ||
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
      recoveryGeneration,
      stageId: VERIFY_STAGE_ID,
      cacheIdentityKey: cache.manifest.identityKey,
      cacheManifestFingerprint: cache.manifest.manifestFingerprint,
      cacheArchiveSha256: cache.manifest.archiveSha256,
      cacheTreeSha256: cache.manifest.treeSha256,
      triggerRunId: run.id,
    } as const;
  },
});
