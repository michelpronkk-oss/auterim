import "server-only";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getEnvironment } from "@/lib/env/schema";

export function cliPepper() {
  const secret = getEnvironment().AUTERIM_CLI_CONNECT_HMAC_SECRET;
  if (!secret) throw new Error("cli_connect_unavailable");
  return secret;
}

export function cliSecretHash(value: string, purpose: "user-code" | "poll-secret" | "ingestion") {
  return createHmac("sha256", cliPepper())
    .update(`auterim:m156:${purpose}:`)
    .update(value)
    .digest("hex");
}

export function deriveCliCredential(sessionId: string, pollSecret: string) {
  const value = createHmac("sha256", cliPepper())
    .update(`auterim:m156:product-discovery:${sessionId}:`)
    .update(pollSecret)
    .digest("base64url");
  return `acli_${value}`;
}

export function equalHexDigest(left: string, right: string) {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function newPollSecret() {
  return randomBytes(32).toString("base64url");
}

export function newUserCode() {
  return randomBytes(5).toString("hex").toUpperCase();
}
