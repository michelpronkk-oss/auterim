import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";

// Public trust anchor from Supabase Studio's HTTPS certificate download source.
// Provenance and rotation procedure: docs/runbooks/m1579-migration-tls.md.
export const CA_SHA256 = "807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa";

function fail(code) {
  throw Object.assign(new Error("migration_tls_preflight_failed"), { code });
}

export function validatePinnedCa(pem, now = Date.now()) {
  let certificate;
  try {
    if (
      !/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(pem)
    )
      fail("CA_INVALID");
    certificate = new X509Certificate(pem);
  } catch {
    fail("CA_INVALID");
  }
  if (createHash("sha256").update(certificate.raw).digest("hex") !== CA_SHA256)
    fail("CA_PIN_MISMATCH");
  if (!certificate.ca || !certificate.verify(certificate.publicKey)) fail("CA_INVALID");
  if (
    !Number.isFinite(now) ||
    now < Date.parse(certificate.validFrom) ||
    now >= Date.parse(certificate.validTo)
  )
    fail("CA_NOT_CURRENT");
  return pem;
}

/** @returns {import("node:tls").ConnectionOptions} */
export function migrationTls(hostname) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") fail("INSECURE_TLS_ENVIRONMENT");
  const ca = validatePinnedCa(
    readFileSync(new URL("./certs/supabase-prod-ca-2021.crt", import.meta.url), "utf8"),
  );
  return {
    ca,
    servername: hostname,
    rejectUnauthorized: true,
    checkServerIdentity,
    minVersion: "TLSv1.2",
  };
}

export function verifiedTlsProtocol(socket) {
  const protocol = socket?.getProtocol?.();
  if (socket?.authorized !== true || !["TLSv1.2", "TLSv1.3"].includes(protocol))
    fail("TLS_PEER_UNAUTHORIZED");
  return protocol;
}

const SAFE_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_SIGNATURE_FAILURE",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENOENT",
  "28P01",
  "28000",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "08P01",
  "53300",
  "57P03",
  "CA_INVALID",
  "CA_PIN_MISMATCH",
  "CA_NOT_CURRENT",
  "INSECURE_TLS_ENVIRONMENT",
  "TLS_PEER_UNAUTHORIZED",
]);

// Never log a driver message, stack, URL, parameters, or arbitrary error.code value.
export function connectionFailure(error) {
  const code = SAFE_CODES.has(error?.code) ? error.code : "UNKNOWN_CONNECTION_OR_PREFLIGHT";
  return `bounded_migration_failed:preflight_or_connection;code=${code}`;
}
