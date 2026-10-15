import "server-only";
import { createPrivateKey, createPublicKey, createSign, createVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

export const GITHUB_APP_KEY_FORMAT_CLASSES = [
  "pem_pkcs1",
  "pem_pkcs8",
  "pem_literal_newlines",
  "pem_crlf",
  "quoted_pem",
  "encrypted_pem",
  "base64_wrapped_candidate",
  "unknown",
] as const;

export type GitHubAppKeyFormatClass = (typeof GITHUB_APP_KEY_FORMAT_CLASSES)[number];
export type GitHubAppKeyFailureCategory =
  | "github_private_key_unparseable"
  | "github_private_key_not_rsa"
  | "github_private_key_encrypted_unsupported"
  | "github_private_key_format_unsupported"
  | "github_local_sign_failed"
  | "github_local_verify_failed";

export type GitHubAppCryptoDiagnostics = {
  configured: boolean;
  formatClass: GitHubAppKeyFormatClass;
  parseable: boolean;
  keyType:
    "rsa" | "rsa-pss" | "dsa" | "ec" | "ed25519" | "ed448" | "x25519" | "x448" | "dh" | "unknown";
  localSignVerify: boolean;
  failureCategory?: GitHubAppKeyFailureCategory;
};

type ParsedKeyResult =
  | { ok: true; key: KeyObject; formatClass: GitHubAppKeyFormatClass }
  | {
      ok: false;
      formatClass: GitHubAppKeyFormatClass;
      failureCategory: GitHubAppKeyFailureCategory;
    };

const LOCAL_CHALLENGE = "auterim-github-app-key-self-check-v1";
const MAX_KEY_TEXT_LENGTH = 32_768;
const SAFE_KEY_TYPES = new Set([
  "rsa",
  "rsa-pss",
  "dsa",
  "ec",
  "ed25519",
  "ed448",
  "x25519",
  "x448",
  "dh",
]);

function safeKeyType(key: KeyObject): GitHubAppCryptoDiagnostics["keyType"] {
  const type = key.asymmetricKeyType;
  return type && SAFE_KEY_TYPES.has(type)
    ? (type as GitHubAppCryptoDiagnostics["keyType"])
    : "unknown";
}

function normalizedKeyText(value: string) {
  return value.trim().replaceAll("\\n", "\n");
}

function classifyFormat(rawValue: string, normalized: string): GitHubAppKeyFormatClass {
  if (/^("|')[\s\S]*\1$/.test(rawValue.trim())) return "quoted_pem";
  if (
    normalized.includes("-----BEGIN ENCRYPTED PRIVATE KEY-----") ||
    (/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(normalized) &&
      /(?:^|\r?\n)Proc-Type:\s*4,ENCRYPTED(?:\r?\n|$)/i.test(normalized) &&
      /(?:^|\r?\n)DEK-Info:/i.test(normalized))
  )
    return "encrypted_pem";
  if (rawValue.includes("\\n")) return "pem_literal_newlines";
  if (rawValue.includes("\r\n")) return "pem_crlf";
  if (
    /^-----BEGIN RSA PRIVATE KEY-----\s+[\s\S]+\s+-----END RSA PRIVATE KEY-----$/.test(normalized)
  )
    return "pem_pkcs1";
  if (/^-----BEGIN PRIVATE KEY-----\s+[\s\S]+\s+-----END PRIVATE KEY-----$/.test(normalized))
    return "pem_pkcs8";
  if (
    normalized.length >= 256 &&
    normalized.length <= MAX_KEY_TEXT_LENGTH &&
    /^[A-Za-z0-9+/=\r\n]+$/.test(normalized)
  )
    return "base64_wrapped_candidate";
  return "unknown";
}

function parseKey(value: string | undefined): ParsedKeyResult {
  if (!value || value.length > MAX_KEY_TEXT_LENGTH) {
    return {
      ok: false,
      formatClass: "unknown",
      failureCategory: value
        ? "github_private_key_format_unsupported"
        : "github_private_key_unparseable",
    };
  }
  const normalized = normalizedKeyText(value);
  const formatClass = classifyFormat(value, normalized);
  if (formatClass === "quoted_pem" || formatClass === "base64_wrapped_candidate") {
    return { ok: false, formatClass, failureCategory: "github_private_key_format_unsupported" };
  }
  if (formatClass === "encrypted_pem") {
    return { ok: false, formatClass, failureCategory: "github_private_key_encrypted_unsupported" };
  }
  try {
    return { ok: true, key: createPrivateKey({ key: normalized, format: "pem" }), formatClass };
  } catch {
    return { ok: false, formatClass, failureCategory: "github_private_key_unparseable" };
  }
}

/** Safe diagnostics for a GitHub App RSA key. No key material or crypto errors are returned. */
export function inspectGitHubAppPrivateKey(value: string | undefined): GitHubAppCryptoDiagnostics {
  const parsed = parseKey(value);
  if (!parsed.ok) {
    return {
      configured: Boolean(value?.trim()),
      formatClass: parsed.formatClass,
      parseable: false,
      keyType: "unknown",
      localSignVerify: false,
      failureCategory: parsed.failureCategory,
    };
  }

  const keyType = safeKeyType(parsed.key);
  if (keyType !== "rsa") {
    return {
      configured: true,
      formatClass: parsed.formatClass,
      parseable: true,
      keyType,
      localSignVerify: false,
      failureCategory: "github_private_key_not_rsa",
    };
  }

  try {
    const signer = createSign("RSA-SHA256");
    signer.update(LOCAL_CHALLENGE);
    signer.end();
    const signature = signer.sign(parsed.key);
    const publicKey = createPublicKey(parsed.key);
    const verifier = createVerify("RSA-SHA256");
    verifier.update(LOCAL_CHALLENGE);
    verifier.end();
    const localSignVerify = verifier.verify(publicKey, signature);
    return {
      configured: true,
      formatClass: parsed.formatClass,
      parseable: true,
      keyType: "rsa",
      localSignVerify,
      ...(localSignVerify ? {} : { failureCategory: "github_local_verify_failed" as const }),
    };
  } catch {
    return {
      configured: true,
      formatClass: parsed.formatClass,
      parseable: true,
      keyType: "rsa",
      localSignVerify: false,
      failureCategory: "github_local_sign_failed",
    };
  }
}

/** Returns the parsed key for server-side signing; callers must never serialize or log it. */
export function parseGitHubAppPrivateKey(
  value: string | undefined,
):
  | { ok: true; key: KeyObject; diagnostics: GitHubAppCryptoDiagnostics }
  | { ok: false; diagnostics: GitHubAppCryptoDiagnostics } {
  const diagnostics = inspectGitHubAppPrivateKey(value);
  if (!diagnostics.parseable || diagnostics.keyType !== "rsa" || !diagnostics.localSignVerify)
    return { ok: false, diagnostics };
  const parsed = parseKey(value);
  if (!parsed.ok) return { ok: false, diagnostics };
  return { ok: true, key: parsed.key, diagnostics };
}
