import {
  createHmac,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  X509Certificate,
  type KeyObject,
} from "node:crypto";
import {
  canonicalJson,
  sha256,
  VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
  VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH,
  VERIFICATION_RUNNER_IDENTITY_MAX_AGE_MS,
  VerificationRunnerIdentityAttestationBodySchema,
  type VerificationRunnerIdentityAttestationBody,
} from "../../../verification-runner/contracts";

export const EXPECTED_VERIFIER_INSTANCE = {
  accountId: "737759272471",
  region: "eu-west-1",
  instanceId: "i-0592719b99a518001",
} as const;

/** Exact Docker image ID independently confirmed on the live EC2 runner. */
export const EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS = [
  "sha256:408117eeeee5477f56eae8d8bb16cda12cf01ad0596b7ce3269bf2e2beaa56ee",
] as const;

// AWS's eu-west-1 RSA certificate for the IMDS /instance-identity/signature endpoint.
// Source: AWS EC2 User Guide, “AWS public certificates for instance identity document signatures”.
export const AWS_EU_WEST_1_RSA_CERTIFICATE_SHA256 =
  "7092993efe38800eedd69def9cf34b734ac828cce30ef94342388bc7a548827d";
const AWS_EU_WEST_1_RSA_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIDITCCAoqgAwIBAgIUakDaQ1Zqy87Hy9ESXA1pFC116HkwDQYJKoZIhvcNAQEL
BQAwXDELMAkGA1UEBhMCVVMxGTAXBgNVBAgTEFdhc2hpbmd0b24gU3RhdGUxEDAO
BgNVBAcTB1NlYXR0bGUxIDAeBgNVBAoTF0FtYXpvbiBXZWIgU2VydmljZXMgTExD
MB4XDTI0MDQyOTE2MTgxMFoXDTI5MDQyODE2MTgxMFowXDELMAkGA1UEBhMCVVMx
GTAXBgNVBAgTEFdhc2hpbmd0b24gU3RhdGUxEDAOBgNVBAcTB1NlYXR0bGUxIDAe
BgNVBAoTF0FtYXpvbiBXZWIgU2VydmljZXMgTExDMIGfMA0GCSqGSIb3DQEBAQUA
A4GNADCBiQKBgQCHvRjf/0kStpJ248khtIaN8qkDN3tkw4VjvA9nvPl2anJO+eIB
UqPfQG09kZlwpWpmyO8bGB2RWqWxCwuB/dcnIob6w420k9WY5C0IIGtDRNauN3ku
vGXkw3HEnF0EjYr0pcyWUvByWY4KswZV42X7Y7XSS13hOIcL6NLA+H94/QIDAQAB
o4HfMIHcMAsGA1UdDwQEAwIHgDAdBgNVHQ4EFgQUJdbMCBXKtvCcWdwUUizvtUF2
UTgwgZkGA1UdIwSBkTCBjoAUJdbMCBXKtvCcWdwUUizvtUF2UTihYKReMFwxCzAJ
BgNVBAYTAlVTMRkwFwYDVQQIExBXYXNoaW5ndG9uIFN0YXRlMRAwDgYDVQQHEwdT
ZWF0dGxlMSAwHgYDVQQKExdBbWF6b24gV2ViIFNlcnZpY2VzIExMQ4IUakDaQ1Zq
y87Hy9ESXA1pFC116HkwEgYDVR0TAQH/BAgwBgEB/wIBADANBgkqhkiG9w0BAQsF
AAOBgQADIkn/MqaLGPuK5+prZZ5Ox4bBZLPtreO2C7r0pqU2kPM2lVPyYYydkvP0
lgSmmsErGu/oL9JNztDe2oCA+kNy17ehcsf8cw0uP861czNFKCeU8b7FgBbL+sIm
qi33rAq6owWGi/5uEcfCR+JP7W+oSYVir5r/yDmWzx+BVH5S/g==
-----END CERTIFICATE-----`;

const AWS_EU_WEST_1_RSA_PUBLIC_KEY = createPublicKey(AWS_EU_WEST_1_RSA_CERTIFICATE);
const AWS_EU_WEST_1_RSA_SIGNATURE_BYTES = 128;
const certificateFingerprint = new X509Certificate(AWS_EU_WEST_1_RSA_CERTIFICATE).fingerprint256
  .replaceAll(":", "")
  .toLowerCase();

export function createIdentityAttestationRequestHeaders(input: {
  body: Buffer;
  secret: string;
  nonce?: string;
  issuedAt?: number;
}) {
  const method = "POST";
  const path = VERIFICATION_RUNNER_IDENTITY_ATTESTATION_PATH;
  const issuedAt = String(input.issuedAt ?? Date.now());
  const nonce = input.nonce ?? randomBytes(24).toString("hex");
  const signature = createHmac("sha256", input.secret)
    .update(`${method}\n${path}\n${issuedAt}\n${nonce}\n${sha256(input.body)}`, "utf8")
    .digest("hex");
  return {
    "x-auterim-issued-at": issuedAt,
    "x-auterim-nonce": nonce,
    "x-auterim-signature": signature,
    "content-type": "application/json",
  };
}

export function verifyRsaSha256DocumentSignature(
  document: string,
  signatureBase64: string,
  publicKey: KeyObject,
) {
  let canonicalBase64 = "";
  for (const character of signatureBase64) {
    const code = character.charCodeAt(0);
    if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) continue;
    if (code > 0x7f) return false;
    canonicalBase64 += character;
  }
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(canonicalBase64) ||
    publicKey.asymmetricKeyType !== "rsa" ||
    publicKey.asymmetricKeyDetails?.modulusLength !== 1024
  )
    return false;
  const signature = Buffer.from(canonicalBase64, "base64");
  if (
    signature.byteLength !== AWS_EU_WEST_1_RSA_SIGNATURE_BYTES ||
    signature.toString("base64") !== canonicalBase64
  )
    return false;
  try {
    return verifySignature("RSA-SHA256", Buffer.from(document, "utf8"), publicKey, signature);
  } catch {
    return false;
  }
}

function verifyRunnerResponseHmac(
  body: VerificationRunnerIdentityAttestationBody,
  signature: string,
  secret: string,
) {
  if (!/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(canonicalJson(body), "utf8").digest();
  const provided = Buffer.from(signature, "hex");
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
}

export function verifyRunnerIdentityAttestation(input: {
  body: unknown;
  responseSignature: string | null;
  requestNonce: string;
  authSecret: string;
  now?: number;
  /** Test seam for exercising RSA verification with a generated key pair. */
  signaturePublicKey?: KeyObject;
}) {
  const parsed = VerificationRunnerIdentityAttestationBodySchema.safeParse(input.body);
  if (!parsed.success) throw new Error("runner_identity_attestation_invalid");
  const body = parsed.data;
  if (
    body.nonce !== input.requestNonce ||
    !verifyRunnerResponseHmac(body, input.responseSignature ?? "", input.authSecret)
  )
    throw new Error("runner_identity_attestation_signature_invalid");
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(body.issuedAt) || Math.abs(now - body.issuedAt) > 60_000)
    throw new Error("runner_identity_attestation_expired");
  if (
    !Number.isSafeInteger(body.identityFetchedAt) ||
    body.identityFetchedAt > now + 5_000 ||
    now - body.identityFetchedAt > VERIFICATION_RUNNER_IDENTITY_MAX_AGE_MS
  )
    throw new Error("runner_identity_document_stale");
  if (
    !EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS.includes(
      body.containerImageId as (typeof EXPECTED_VERIFICATION_RUNNER_IMAGE_IDS)[number],
    )
  )
    throw new Error("runner_container_image_mismatch");
  if (
    certificateFingerprint !== AWS_EU_WEST_1_RSA_CERTIFICATE_SHA256 ||
    AWS_EU_WEST_1_RSA_PUBLIC_KEY.asymmetricKeyType !== "rsa"
  )
    throw new Error("runner_identity_trust_anchor_invalid");

  let document: unknown;
  try {
    document = JSON.parse(body.instanceIdentityDocument) as unknown;
  } catch {
    throw new Error("runner_identity_document_invalid");
  }
  if (!document || typeof document !== "object" || Array.isArray(document))
    throw new Error("runner_identity_document_invalid");
  const claims = document as Record<string, unknown>;
  if (
    claims.accountId !== EXPECTED_VERIFIER_INSTANCE.accountId ||
    claims.region !== EXPECTED_VERIFIER_INSTANCE.region ||
    claims.instanceId !== EXPECTED_VERIFIER_INSTANCE.instanceId ||
    typeof claims.imageId !== "string" ||
    !/^ami-[a-f0-9]+$/.test(claims.imageId)
  )
    throw new Error("runner_identity_claim_mismatch");
  if (
    !verifyRsaSha256DocumentSignature(
      body.instanceIdentityDocument,
      body.instanceIdentitySignature,
      input.signaturePublicKey ?? AWS_EU_WEST_1_RSA_PUBLIC_KEY,
    )
  )
    throw new Error("runner_identity_signature_invalid");

  return {
    accountId: EXPECTED_VERIFIER_INSTANCE.accountId,
    region: EXPECTED_VERIFIER_INSTANCE.region,
    instanceId: EXPECTED_VERIFIER_INSTANCE.instanceId,
    instanceImageId: claims.imageId,
    runnerContainerImageId: body.containerImageId,
    runnerContainerImageRef: VERIFICATION_RUNNER_DEPLOYMENT_IMAGE_REF,
  } as const;
}
