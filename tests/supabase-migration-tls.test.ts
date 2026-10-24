import { readFileSync } from "node:fs";
import { connect, createServer, checkServerIdentity } from "node:tls";
import type { TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import { connectionConfig } from "../scripts/supabase-bounded-migration.mjs";
import {
  CA_SHA256,
  connectionFailure,
  migrationTls,
  validatePinnedCa,
  verifiedTlsProtocol,
} from "../scripts/supabase-migration-tls.mjs";

const ref = "lnljaacbptrubppoypaz";
const pooler = `postgresql://postgres.${ref}:placeholder@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
const options = connectionConfig(pooler, "fixture-only-password", ref).ssl;
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/migration-tls/${name}`, import.meta.url), "utf8");
const pinnedCa = readFileSync(
  new URL("../scripts/certs/supabase-prod-ca-2021.crt", import.meta.url),
  "utf8",
);

async function handshake(
  ca = fixture("ca.crt"),
  servername = "localhost",
  certificate = "server.crt",
) {
  // Only the test trust anchor/hostname change; the production verification options are reused.
  const server = createServer(
    { key: fixture("server.key"), cert: fixture(certificate) + fixture("ca.crt") },
    (socket) => socket.end(),
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("local_fixture_listener_missing");
  let socket: TLSSocket | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      socket = connect(
        { ...options, host: "127.0.0.1", port: address.port, ca, servername },
        () => {
          try {
            resolve(verifiedTlsProtocol(socket));
          } catch (error) {
            reject(error);
          }
        },
      );
      socket.once("error", reject);
      socket.setTimeout(3000, () => socket?.destroy(Error("local_tls_fixture_timeout")));
    });
  } finally {
    socket?.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

describe("pinned migration TLS", () => {
  it("pins the vendor CA and preserves full hostname/certificate verification", () => {
    expect(validatePinnedCa(pinnedCa)).toBe(pinnedCa);
    expect(CA_SHA256).toBe("807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa");
    expect(options).toMatchObject({
      ca: pinnedCa,
      servername: "aws-0-eu-west-1.pooler.supabase.com",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    expect(options.checkServerIdentity).toBe(checkServerIdentity);
    expect(migrationTls("aws-0-eu-west-1.pooler.supabase.com").ca).toBe(pinnedCa);
  });
  it("rejects malformed, replaced, bundled, expired and not-yet-valid trust anchors", () => {
    expect(() => validatePinnedCa("not a certificate")).toThrow();
    expect(() => validatePinnedCa(fixture("ca.crt"))).toThrowError(
      expect.objectContaining({ code: "CA_PIN_MISMATCH" }),
    );
    expect(() => validatePinnedCa(pinnedCa + pinnedCa)).toThrowError(
      expect.objectContaining({ code: "CA_INVALID" }),
    );
    for (const date of [Date.UTC(2020, 0, 1), Date.UTC(2032, 0, 1), NaN])
      expect(() => validatePinnedCa(pinnedCa, date)).toThrowError(
        expect.objectContaining({ code: "CA_NOT_CURRENT" }),
      );
  });
  it("accepts a trusted localhost certificate over a real TLS socket", async () => {
    expect(await handshake()).toMatch(/^TLSv1\.[23]$/);
  });
  it("rejects an untrusted certificate without fallback", async () => {
    await expect(handshake(pinnedCa)).rejects.toMatchObject({ code: "SELF_SIGNED_CERT_IN_CHAIN" });
  });
  it("rejects a trusted certificate for the wrong hostname", async () => {
    await expect(handshake(fixture("ca.crt"), "wrong.example.invalid")).rejects.toMatchObject({
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });
  it("rejects an expired certificate signed by the trusted test CA", async () => {
    await expect(handshake(fixture("ca.crt"), "localhost", "expired.crt")).rejects.toMatchObject({
      code: "CERT_HAS_EXPIRED",
    });
  });
  it("refuses a successful-looking connection that lacks verified TLS", () => {
    for (const socket of [
      undefined,
      { authorized: false, getProtocol: () => "TLSv1.3" },
      { authorized: true, getProtocol: () => null },
      { authorized: true, getProtocol: () => "TLSv1" },
    ])
      expect(() => verifiedTlsProtocol(socket)).toThrowError(
        expect.objectContaining({ code: "TLS_PEER_UNAUTHORIZED" }),
      );
  });
  it.each([
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "CERT_HAS_EXPIRED",
    "ECONNREFUSED",
    "ECONNRESET",
    "ENOTFOUND",
    "ETIMEDOUT",
    "28P01",
    "CA_PIN_MISMATCH",
  ])("reports only the sanitized connection code %s", (code) => {
    const error = Object.assign(Error("secret password in postgresql://user:private@host"), {
      code,
      detail: "private",
      stack: "private",
    });
    expect(connectionFailure(error)).toBe(
      `bounded_migration_failed:preflight_or_connection;code=${code}`,
    );
  });
  it("never logs unknown codes, nested driver errors, messages or stacks", () => {
    for (const error of [
      undefined,
      Error("private password"),
      { code: "postgresql://user:private@host", cause: { code: "private" } },
    ])
      expect(connectionFailure(error)).toBe(
        "bounded_migration_failed:preflight_or_connection;code=UNKNOWN_CONNECTION_OR_PREFLIGHT",
      );
  });
});
