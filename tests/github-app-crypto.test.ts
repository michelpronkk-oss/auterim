import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { inspectGitHubAppPrivateKey } from "@/lib/preflight/github-app-crypto";

function rsaPem(type: "pkcs1" | "pkcs8" = "pkcs8") {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return privateKey.export({ type, format: "pem" }).toString();
}

describe("safe GitHub App key diagnostics", () => {
  const pkcs1 = rsaPem("pkcs1");
  const pkcs8 = rsaPem();
  const encrypted = (() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return privateKey
      .export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase: "fixture-passphrase",
      })
      .toString();
  })();

  it.each([
    ["valid PKCS#1 RSA PEM", pkcs1, "pem_pkcs1"],
    ["valid PKCS#8 RSA PEM", pkcs8, "pem_pkcs8"],
    ["literal newline PEM", pkcs8.replaceAll("\n", "\\n"), "pem_literal_newlines"],
    ["CRLF PEM", pkcs8.replaceAll("\n", "\r\n"), "pem_crlf"],
    ["outer whitespace", `  ${pkcs8} \t`, "pem_pkcs8"],
  ] as const)("parses and locally verifies %s", (_name, value, formatClass) => {
    const result = inspectGitHubAppPrivateKey(value);
    expect(result).toMatchObject({
      configured: true,
      formatClass,
      parseable: true,
      keyType: "rsa",
      localSignVerify: true,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it.each([
    ["quoted PEM", `\"${pkcs8}\"`, "quoted_pem", "github_private_key_format_unsupported"],
    ["malformed PEM", "not-a-private-key", "unknown", "github_private_key_unparseable"],
    [
      "truncated PEM",
      pkcs8.split("\n").slice(0, 4).join("\n"),
      "unknown",
      "github_private_key_unparseable",
    ],
    ["encrypted PEM", encrypted, "encrypted_pem", "github_private_key_encrypted_unsupported"],
    [
      "legacy encrypted PKCS#1 envelope",
      "-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-256-CBC,0000000000000000\n\nAAAA\n-----END RSA PRIVATE KEY-----",
      "encrypted_pem",
      "github_private_key_encrypted_unsupported",
    ],
    [
      "base64-wrapped candidate",
      Buffer.from(pkcs8).toString("base64"),
      "base64_wrapped_candidate",
      "github_private_key_format_unsupported",
    ],
    ["oversized key text", "x".repeat(32_769), "unknown", "github_private_key_format_unsupported"],
  ] as const)("rejects %s with safe diagnostics", (_name, value, formatClass, failureCategory) => {
    const result = inspectGitHubAppPrivateKey(value);
    expect(result).toMatchObject({
      configured: true,
      formatClass,
      parseable: false,
      keyType: "unknown",
      localSignVerify: false,
      failureCategory,
    });
    expect(JSON.stringify(result)).not.toContain(value);
  });

  it("rejects a parseable non-RSA key without signing", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const result = inspectGitHubAppPrivateKey(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    );
    expect(result).toMatchObject({
      configured: true,
      parseable: true,
      keyType: "ec",
      localSignVerify: false,
      failureCategory: "github_private_key_not_rsa",
    });
  });

  it("reports an absent key without throwing", () => {
    expect(inspectGitHubAppPrivateKey(undefined)).toEqual({
      configured: false,
      formatClass: "unknown",
      parseable: false,
      keyType: "unknown",
      localSignVerify: false,
      failureCategory: "github_private_key_unparseable",
    });
  });
});
