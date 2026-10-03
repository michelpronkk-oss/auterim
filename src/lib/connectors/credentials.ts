import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnvironment } from "@/lib/env/schema";

export type EncryptedCredential = {
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  authenticationTag: string;
};

function keyRing() {
  const environment = getEnvironment();
  const raw = environment.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS;
  const activeVersion = environment.CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION;
  if (!raw || !activeVersion) throw new Error("connector_credential_encryption_not_configured");
  let parsed: Record<string, string>;
  try {
    parsed = JSON.parse(raw) as Record<string, string>;
  } catch {
    throw new Error("connector_credential_encryption_not_configured");
  }
  const keys = new Map<number, Buffer>();
  for (const [version, value] of Object.entries(parsed)) {
    if (!/^\d{1,6}$/.test(version) || typeof value !== "string") continue;
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32 && decoded.toString("base64") === value)
      keys.set(Number(version), decoded);
  }
  if (!keys.has(activeVersion)) throw new Error("connector_credential_encryption_not_configured");
  return { activeVersion, keys };
}

export function encryptConnectorCredential(
  plaintext: string,
  associatedData: string,
): EncryptedCredential {
  const { activeVersion, keys } = keyRing();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keys.get(activeVersion)!, nonce);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    keyVersion: activeVersion,
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authenticationTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptConnectorCredential(
  encrypted: EncryptedCredential,
  associatedData: string,
): string {
  const { keys } = keyRing();
  const key = keys.get(encrypted.keyVersion);
  if (!key) throw new Error("connector_credential_key_version_unavailable");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "base64"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.authenticationTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("connector_credential_decryption_failed");
  }
}

export function connectorCredentialAad(
  workspaceId: string,
  provider: string,
  externalAccountId: string,
) {
  return `auterim-connector:v1:${workspaceId}:${provider}:${externalAccountId}`;
}
