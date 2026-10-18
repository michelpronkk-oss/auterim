import { schemaTask } from "@trigger.dev/sdk";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getEnvironment } from "@/lib/env/schema";
import {
  canonicalJson,
  VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
  VerificationRunnerIdentityAttestationRequestSchema,
} from "../../verification-runner/contracts";
import { parseBoundedJsonResponse } from "@/lib/fix-engine/verification-runner-client";
import {
  createIdentityAttestationRequestHeaders,
  verifyRunnerIdentityAttestation,
} from "@/lib/fix-engine/runner-identity-attestation";

const SAFE_FAILURES = new Set([
  "runner_authentication_failed",
  "runner_identity_attestation_invalid",
  "runner_identity_metadata_unavailable",
  "runner_container_identity_unavailable",
  "runner_identity_attestation_unavailable",
]);

export const attestVerificationRunnerIdentityTask = schemaTask({
  id: "attest-verification-runner-identity",
  schema: z.object({}).strict(),
  retry: { maxAttempts: 1 },
  maxDuration: 30,
  run: async () => {
    const environment = getEnvironment();
    if (
      !environment.FIX_VERIFICATION_RUNNER_URL ||
      !environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET ||
      environment.FIX_VERIFICATION_RUNNER_PROTOCOL !== "m1578-verification-runner-v1" ||
      environment.FIX_GITHUB_DRAFT_PR_WRITES !== "0"
    )
      return { status: "blocked", category: "runner_identity_configuration_unavailable" } as const;

    const url = new URL(environment.FIX_VERIFICATION_RUNNER_URL);
    if (url.protocol !== "https:")
      return { status: "blocked", category: "runner_identity_endpoint_invalid" } as const;

    const nonce = randomBytes(32).toString("hex");
    const requestBody = VerificationRunnerIdentityAttestationRequestSchema.parse({ nonce });
    const body = Buffer.from(canonicalJson(requestBody), "utf8");
    let response: Response;
    try {
      response = await fetch(new URL(VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH, url), {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
        headers: createIdentityAttestationRequestHeaders({
          body,
          secret: environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET,
        }),
        body,
      });
    } catch {
      return { status: "blocked", category: "runner_identity_endpoint_unavailable" } as const;
    }

    let parsed: Awaited<ReturnType<typeof parseBoundedJsonResponse>>;
    try {
      parsed = await parseBoundedJsonResponse(response);
    } catch {
      return {
        status: "blocked",
        httpStatus: response.status,
        category: "runner_identity_response_invalid",
      } as const;
    }
    if (!response.ok) {
      const value = parsed.value;
      const error =
        typeof value === "object" &&
        value !== null &&
        "error" in value &&
        typeof value.error === "string" &&
        SAFE_FAILURES.has(value.error)
          ? value.error
          : "runner_identity_response_invalid";
      return { status: "blocked", httpStatus: response.status, category: error } as const;
    }

    try {
      const identity = verifyRunnerIdentityAttestation({
        body: parsed.value,
        responseSignature: response.headers.get("x-auterim-identity-signature"),
        requestNonce: nonce,
        authSecret: environment.FIX_VERIFICATION_RUNNER_AUTH_SECRET,
      });
      return {
        status: "verified",
        protocolVersion: environment.FIX_VERIFICATION_RUNNER_PROTOCOL,
        ...identity,
      } as const;
    } catch (error) {
      const category =
        error instanceof Error &&
        [
          "runner_identity_attestation_invalid",
          "runner_identity_attestation_signature_invalid",
          "runner_identity_attestation_expired",
          "runner_identity_trust_anchor_invalid",
          "runner_identity_document_invalid",
          "runner_identity_claim_mismatch",
          "runner_identity_signature_invalid",
        ].includes(error.message)
          ? error.message
          : "runner_identity_attestation_invalid";
      return { status: "blocked", httpStatus: response.status, category } as const;
    }
  },
});
