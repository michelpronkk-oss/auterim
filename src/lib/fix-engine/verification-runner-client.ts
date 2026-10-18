import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  canonicalJson,
  sha256,
  verificationJobIdentityFingerprint,
  verificationRequestFingerprint,
  verificationResultSignatureInput,
  VerificationJobIdentitySchema,
  VerificationJobRequestSchema,
  VerificationJobResultSchema,
  VERIFICATION_RUNNER_IMAGE,
  VERIFICATION_RUNNER_PROTOCOL_VERSION,
  type RunnerVerificationCommand,
  type VerificationJobIdentity,
  type VerificationJobRequest,
  type VerificationJobResult,
} from "../../../verification-runner/contracts";
import type { PrivateArtifactReference } from "@/lib/fix-engine/verification-artifacts";
import type { DependencyCacheManifestV2 } from "../../../verification-runner/contracts";
import {
  retryableRunnerFailure,
  terminalRunnerFailure,
  VERIFICATION_RUNNER_RESPONSE_CATEGORIES,
  VerificationRunnerFailure,
  type VerificationRunnerFailureDiagnostic,
  type VerificationRunnerResponseCategory,
} from "@/lib/fix-engine/verification-retry";

function requestSignatureInput(
  method: string,
  pathAndQuery: string,
  issuedAt: string,
  nonce: string,
  body: Buffer,
) {
  return `${method}\n${pathAndQuery}\n${issuedAt}\n${nonce}\n${sha256(body)}`;
}

function signedHeaders(method: string, pathAndQuery: string, body: Buffer, secret: string) {
  const issuedAt = String(Date.now());
  const nonce = randomBytes(24).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(requestSignatureInput(method, pathAndQuery, issuedAt, nonce, body), "utf8")
    .digest("hex");
  return {
    "x-auterim-issued-at": issuedAt,
    "x-auterim-nonce": nonce,
    "x-auterim-signature": signature,
  };
}

function responseFailure(value: unknown) {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string" &&
    /^[a-z0-9_]{1,100}$/.test(value.error)
  )
    return value.error;
  if (
    typeof value === "object" &&
    value !== null &&
    "category" in value &&
    typeof value.category === "string" &&
    /^[a-z0-9_]{1,100}$/.test(value.category)
  )
    return value.category;
  return null;
}

export async function parseBoundedJsonResponse(
  response: Response,
): Promise<{ value: unknown; bytes: Buffer }> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("verification_runner_response_invalid");
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > 64 * 1024) {
    await reader.cancel().catch(() => undefined);
    throw new Error("verification_runner_response_too_large");
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = Buffer.from(part.value);
      total += chunk.byteLength;
      if (total > 64 * 1024) {
        await reader.cancel().catch(() => undefined);
        throw new Error("verification_runner_response_too_large");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, total);
  try {
    return { value: JSON.parse(bytes.toString("utf8")) as unknown, bytes };
  } catch {
    throw new Error("verification_runner_response_invalid");
  }
}

function diagnostic(
  phase: VerificationRunnerFailureDiagnostic["phase"],
  httpStatus: number | null,
  value: unknown,
  reason: VerificationRunnerFailureDiagnostic["reason"],
  identityField?: VerificationRunnerFailureDiagnostic["identityField"],
): VerificationRunnerFailureDiagnostic {
  const category = responseFailure(value);
  const approvedCategories = new Set<string>(VERIFICATION_RUNNER_RESPONSE_CATEGORIES);
  const responseCategory: VerificationRunnerFailureDiagnostic["responseCategory"] = category
    ? approvedCategories.has(category)
      ? (category as VerificationRunnerResponseCategory)
      : "unrecognized"
    : null;
  return {
    phase,
    httpStatus:
      Number.isInteger(httpStatus) && httpStatus !== null && httpStatus >= 100 && httpStatus <= 599
        ? httpStatus
        : null,
    responseCategory,
    reason,
    ...(identityField ? { identityField } : {}),
  };
}

function combineDiagnostics(
  error: VerificationRunnerFailure,
  prior: readonly VerificationRunnerFailureDiagnostic[],
) {
  if (!prior.length) return error;
  return new VerificationRunnerFailure(
    error.category,
    error.retryable,
    [...prior, ...error.diagnostics].slice(-4),
  );
}

function responseDecodeReason(error: unknown): VerificationRunnerFailureDiagnostic["reason"] {
  if (error instanceof Error && error.message === "verification_runner_response_too_large")
    return "response_body_too_large";
  if (error instanceof Error && error.message === "verification_runner_response_invalid")
    return "response_body_invalid";
  return "response_body_unavailable";
}

function assertSignedResult(
  response: Response,
  bytes: Buffer,
  result: VerificationJobResult,
  secret: string,
) {
  const providedText = response.headers.get("x-auterim-result-signature") ?? "";
  if (!/^[a-f0-9]{64}$/.test(providedText))
    throw terminalRunnerFailure("runner_result_invalid", [
      diagnostic("result_signature", response.status, null, "result_signature_missing"),
    ]);
  const expected = createHmac("sha256", secret)
    .update(verificationResultSignatureInput(result.jobId, sha256(bytes)), "utf8")
    .digest();
  const provided = Buffer.from(providedText, "hex");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw terminalRunnerFailure("runner_result_invalid", [
      diagnostic("result_signature", response.status, null, "result_signature_mismatch"),
    ]);
}

function validateResult(
  value: unknown,
  expected: VerificationJobRequest,
  httpStatus: number,
): VerificationJobResult {
  const parsed = VerificationJobResultSchema.safeParse(value);
  if (!parsed.success)
    throw terminalRunnerFailure("runner_result_invalid", [
      diagnostic("result_validation", httpStatus, value, "result_schema_invalid"),
    ]);
  const result = parsed.data;
  const { resultFingerprint, ...base } = result;
  const identityChecks: Array<{
    field: NonNullable<VerificationRunnerFailureDiagnostic["identityField"]>;
    matches: boolean;
  }> = [
    { field: "jobId", matches: result.jobId === expected.jobId },
    {
      field: "requestFingerprint",
      matches: result.requestFingerprint === expected.requestFingerprint,
    },
    { field: "workspaceId", matches: result.workspaceId === expected.identity.workspaceId },
    { field: "productId", matches: result.productId === expected.identity.productId },
    { field: "repositoryId", matches: result.repositoryId === expected.identity.repositoryId },
    {
      field: "repositoryIdentity",
      matches:
        result.repositoryIdentity.toLowerCase() ===
        expected.identity.repositoryIdentity.toLowerCase(),
    },
    {
      field: "baseCommitSha",
      matches: result.baseCommitSha.toLowerCase() === expected.identity.baseCommitSha.toLowerCase(),
    },
    { field: "patchId", matches: result.patchId === expected.identity.patchId },
    {
      field: "snapshotFingerprint",
      matches: result.snapshotFingerprint === expected.identity.snapshotFingerprint,
    },
    {
      field: "patchFingerprint",
      matches: result.patchFingerprint === expected.identity.patchFingerprint,
    },
    {
      field: "cacheIdentityKey",
      matches: result.cacheIdentityKey === expected.identity.cacheIdentityKey,
    },
    {
      field: "cacheTreeSha256",
      matches: result.cacheTreeSha256 === expected.identity.cacheTreeSha256,
    },
    { field: "runtimeImage", matches: result.runtimeImage === expected.identity.image },
    { field: "profileId", matches: result.profileId === expected.identity.profileId },
    {
      field: "profileVersion",
      matches: result.profileVersion === expected.identity.profileVersion,
    },
  ];
  const mismatch = identityChecks.find((check) => !check.matches);
  if (mismatch)
    throw terminalRunnerFailure("runner_result_invalid", [
      diagnostic(
        "result_validation",
        httpStatus,
        value,
        "result_identity_mismatch",
        mismatch.field,
      ),
    ]);
  if (sha256(canonicalJson(base)) !== resultFingerprint)
    throw terminalRunnerFailure("runner_result_invalid", [
      diagnostic("result_validation", httpStatus, null, "result_fingerprint_mismatch"),
    ]);
  return result;
}

function failureForResponse(
  value: unknown,
  status: number,
  phase: VerificationRunnerFailureDiagnostic["phase"],
) {
  const category = responseFailure(value);
  const details = [diagnostic(phase, status, value, "http_error")];
  if (status === 401 || category === "runner_authentication_failed")
    return terminalRunnerFailure("runner_auth_failed", details);
  if (category === "runner_protocol_unsupported")
    return terminalRunnerFailure("runner_protocol_unsupported", details);
  if (status === 503 && category === "verification_runner_queue_full")
    return retryableRunnerFailure("runner_queue_full", details);
  if (
    status === 503 &&
    ["verification_runner_state_unavailable", "verification_runner_state_corrupt"].includes(
      category ?? "",
    )
  )
    return retryableRunnerFailure("runner_state_temporarily_unavailable", details);
  if (status >= 500) return retryableRunnerFailure("runner_unavailable", details);
  if (category?.includes("snapshot"))
    return terminalRunnerFailure("snapshot_identity_mismatch", details);
  if (category?.includes("patch")) return terminalRunnerFailure("patch_identity_mismatch", details);
  if (category?.includes("cache_signature"))
    return terminalRunnerFailure("cache_signature_invalid", details);
  if (category?.includes("cache_tree")) return terminalRunnerFailure("cache_tree_invalid", details);
  if (category?.includes("cache")) return terminalRunnerFailure("cache_identity_mismatch", details);
  if (category === "verification_command_unsupported")
    return terminalRunnerFailure("verification_unsupported", details);
  if (category === "verification_command_failed")
    return terminalRunnerFailure("verification_failed", details);
  return terminalRunnerFailure("runner_result_invalid", details);
}

export function createVerificationJobRequest(input: {
  identity: Omit<
    VerificationJobIdentity,
    "protocolVersion" | "image" | "commandClasses" | "snapshotFingerprint" | "patchArtifactPath"
  >;
  snapshot: PrivateArtifactReference;
  patch: PrivateArtifactReference;
  cacheArchive: PrivateArtifactReference;
  cacheManifest: DependencyCacheManifestV2;
  cacheSignature: string;
  commands: RunnerVerificationCommand[];
  issuedAt?: number;
  expiresAt?: number;
}): VerificationJobRequest {
  const identity = VerificationJobIdentitySchema.parse({
    ...input.identity,
    protocolVersion: VERIFICATION_RUNNER_PROTOCOL_VERSION,
    image: VERIFICATION_RUNNER_IMAGE,
    commandClasses: input.commands.map((command) => command.commandClass),
    snapshotFingerprint: input.snapshot.sha256,
    patchArtifactPath: input.patch.path,
  });
  const issuedAt = input.issuedAt ?? Date.now();
  const expiresAt = input.expiresAt ?? issuedAt + 5 * 60_000;
  const requestFingerprint = verificationRequestFingerprint({
    identity,
    commands: input.commands,
    snapshot: { sha256: input.snapshot.sha256, byteCount: input.snapshot.byteCount },
    patch: { sha256: input.patch.sha256, byteCount: input.patch.byteCount },
    cacheArchive: { sha256: input.cacheArchive.sha256, byteCount: input.cacheArchive.byteCount },
    cacheManifest: input.cacheManifest,
    cacheSignature: input.cacheSignature,
  });
  return VerificationJobRequestSchema.parse({
    jobId: verificationJobIdentityFingerprint(identity),
    requestFingerprint,
    issuedAt,
    expiresAt,
    identity,
    commands: input.commands,
    snapshot: {
      url: input.snapshot.signedUrl,
      sha256: input.snapshot.sha256,
      byteCount: input.snapshot.byteCount,
    },
    patch: {
      url: input.patch.signedUrl,
      sha256: input.patch.sha256,
      byteCount: input.patch.byteCount,
    },
    cacheArchive: {
      url: input.cacheArchive.signedUrl,
      sha256: input.cacheArchive.sha256,
      byteCount: input.cacheArchive.byteCount,
    },
    cacheManifest: input.cacheManifest,
    cacheSignature: input.cacheSignature,
  });
}

export class RemoteVerificationRunnerClient {
  private readonly baseUrl: URL;

  constructor(private readonly config: { url: string; authSecret: string; maxWaitMs?: number }) {
    this.baseUrl = new URL(config.url);
    if (
      this.baseUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1"].includes(this.baseUrl.hostname)
    )
      throw new Error("verification_runner_url_requires_https");
    if (config.authSecret.length < 32) throw new Error("verification_runner_auth_not_configured");
  }

  async execute(request: VerificationJobRequest) {
    const validated = VerificationJobRequestSchema.parse(request);
    if (validated.expiresAt <= Date.now() || validated.expiresAt > validated.issuedAt + 10 * 60_000)
      throw new Error("verification_runner_capability_expired");
    const postPath = "/v1/verification-jobs";
    const body = Buffer.from(canonicalJson(validated), "utf8");
    let response: Response | null = null;
    let value: unknown = null;
    let responseBytes: Buffer | null = null;
    let lastTransportFailure:
      "runner_transport_ambiguous" | "runner_timeout_when_execution_may_continue" | null = null;
    let responsePhase: VerificationRunnerFailureDiagnostic["phase"] = "admission";
    const observedDiagnostics: VerificationRunnerFailureDiagnostic[] = [];
    try {
      response = await fetch(new URL(postPath, this.baseUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...signedHeaders("POST", postPath, body, this.config.authSecret),
          "content-type": "application/json",
        },
        body,
      });
      const parsed = await parseBoundedJsonResponse(response);
      value = parsed.value;
      responseBytes = parsed.bytes;
    } catch (error) {
      // The POST may have reached the runner. Reconcile by immutable job ID before failing.
      observedDiagnostics.push(
        diagnostic(
          response ? "response_decode" : "admission",
          response?.status ?? null,
          null,
          response ? responseDecodeReason(error) : "transport_ambiguous",
        ),
      );
      response = null;
      lastTransportFailure = isTimeout(error)
        ? "runner_timeout_when_execution_may_continue"
        : "runner_transport_ambiguous";
    }

    const started = Date.now();
    const maxWait = Math.min(Math.max(this.config.maxWaitMs ?? 240_000, 1_000), 240_000);
    let shouldPoll = !response || response.status === 202;
    let safelyResubmitted = false;
    if (response?.status === 202) {
      const accepted = value as { jobId?: unknown; requestFingerprint?: unknown };
      if (
        accepted.jobId !== validated.jobId ||
        accepted.requestFingerprint !== validated.requestFingerprint
      )
        throw terminalRunnerFailure("runner_result_invalid", [
          diagnostic(
            "admission",
            response.status,
            null,
            "accepted_identity_mismatch",
            accepted.jobId !== validated.jobId ? "jobId" : "requestFingerprint",
          ),
        ]);
    }
    while (true) {
      if (response && response.status !== 202 && response.status !== 200) {
        throw combineDiagnostics(
          failureForResponse(value, response.status, responsePhase),
          observedDiagnostics,
        );
      }
      if (response?.status === 200) {
        const failed = responseFailure(value);
        if (failed)
          throw combineDiagnostics(
            failureForResponse(value, response.status, "result_validation"),
            observedDiagnostics,
          );
        if (!responseBytes)
          throw terminalRunnerFailure("runner_result_invalid", [
            ...observedDiagnostics,
            diagnostic("response_decode", response.status, null, "response_body_unavailable"),
          ]);
        let result: VerificationJobResult;
        try {
          result = validateResult(value, validated, response.status);
          assertSignedResult(response, responseBytes, result, this.config.authSecret);
        } catch (error) {
          if (error instanceof VerificationRunnerFailure)
            throw combineDiagnostics(error, observedDiagnostics);
          throw error;
        }
        return result;
      }
      if (!shouldPoll && response) throw new Error("verification_runner_response_invalid");
      if (Date.now() - started >= maxWait)
        throw retryableRunnerFailure(lastTransportFailure ?? "runner_poll_timeout", [
          ...observedDiagnostics,
          diagnostic("poll", null, null, "transport_ambiguous"),
        ]);
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const statusPath = `/v1/verification-jobs/${validated.jobId}`;
      responsePhase = "poll";
      try {
        response = await fetch(new URL(statusPath, this.baseUrl), {
          method: "GET",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: signedHeaders("GET", statusPath, Buffer.alloc(0), this.config.authSecret),
        });
        const parsed = await parseBoundedJsonResponse(response);
        value = parsed.value;
        responseBytes = parsed.bytes;
        lastTransportFailure = null;
        if (response.status === 404 && !safelyResubmitted) {
          // A lost POST can leave no job to poll. Resubmit the same immutable job once;
          // the durable job ID makes this safe if the original POST was only delayed.
          safelyResubmitted = true;
          responsePhase = "resubmission";
          try {
            response = await fetch(new URL(postPath, this.baseUrl), {
              method: "POST",
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
              headers: {
                ...signedHeaders("POST", postPath, body, this.config.authSecret),
                "content-type": "application/json",
              },
              body,
            });
            const accepted = await parseBoundedJsonResponse(response);
            value = accepted.value;
            responseBytes = accepted.bytes;
            if (response.status === 202) {
              const acceptedBody = accepted.value as {
                jobId?: unknown;
                requestFingerprint?: unknown;
              };
              if (
                acceptedBody.jobId !== validated.jobId ||
                acceptedBody.requestFingerprint !== validated.requestFingerprint
              )
                throw terminalRunnerFailure("runner_result_invalid", [
                  diagnostic(
                    "resubmission",
                    response.status,
                    null,
                    "accepted_identity_mismatch",
                    acceptedBody.jobId !== validated.jobId ? "jobId" : "requestFingerprint",
                  ),
                ]);
            }
          } catch (error) {
            if (error instanceof VerificationRunnerFailure) {
              throw combineDiagnostics(error, observedDiagnostics);
            }
            observedDiagnostics.push(
              diagnostic(
                response ? "response_decode" : "resubmission",
                response?.status ?? null,
                null,
                response ? responseDecodeReason(error) : "transport_ambiguous",
              ),
            );
            response = null;
            value = null;
            responseBytes = null;
            lastTransportFailure = isTimeout(error)
              ? "runner_timeout_when_execution_may_continue"
              : "runner_transport_ambiguous";
          }
        } else if (response.status === 202) {
          const bodyValue = parsed.value as { jobId?: unknown; requestFingerprint?: unknown };
          if (
            bodyValue.jobId !== validated.jobId ||
            bodyValue.requestFingerprint !== validated.requestFingerprint
          )
            throw terminalRunnerFailure("runner_result_invalid", [
              diagnostic(
                "poll",
                response.status,
                null,
                "accepted_identity_mismatch",
                bodyValue.jobId !== validated.jobId ? "jobId" : "requestFingerprint",
              ),
            ]);
        }
        shouldPoll = response === null || response.status === 202;
      } catch (error) {
        if (error instanceof VerificationRunnerFailure)
          throw combineDiagnostics(error, observedDiagnostics);
        observedDiagnostics.push(
          diagnostic(
            response ? "response_decode" : "poll",
            response?.status ?? null,
            null,
            response ? responseDecodeReason(error) : "transport_ambiguous",
          ),
        );
        response = null;
        value = null;
        responseBytes = null;
        shouldPoll = true;
        lastTransportFailure = isTimeout(error)
          ? "runner_timeout_when_execution_may_continue"
          : "runner_transport_ambiguous";
      }
    }
  }
}

function isTimeout(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      /timed out/i.test(error.message))
  );
}
