import "server-only";
import { createSign } from "node:crypto";
import { parseGitHubAppPrivateKey } from "@/lib/preflight/github-app-crypto";

type GitHubWritePermissions = {
  contents: "write";
  pull_requests: "write";
};

export type ScopedGitHubWriteToken = {
  token: string;
  repositoryIdentity: string;
  permissions: GitHubWritePermissions;
};

function createAppJwt(appId: string, privateKey: string): string {
  if (!/^\d{1,20}$/.test(appId)) throw new Error("github_write_app_identity_invalid");
  const parsed = parseGitHubAppPrivateKey(privateKey);
  if (!parsed.ok) throw new Error("github_write_app_key_unavailable");
  const now = Math.floor(Date.now() / 1000);
  const base64url = (value: string) => Buffer.from(value, "utf8").toString("base64url");
  const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
    JSON.stringify({ iat: now - 30, exp: now + 8 * 60, iss: appId }),
  )}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(parsed.key).toString("base64url")}`;
}

async function request(fetcher: typeof fetch, url: string, token: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(12_000),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "Auterim-Fix-Engine/1.0",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new Error("github_write_token_transport_failed");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 404)
      throw new Error("github_write_token_scope_rejected");
    if (response.status === 429 || response.status >= 500)
      throw new Error("github_write_token_provider_unavailable");
    throw new Error("github_write_token_request_rejected");
  }
  const text = await response.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > 64 * 1024)
    throw new Error("github_write_token_response_invalid");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("github_write_token_response_invalid");
  }
}

/**
 * Mints a token restricted to one canonical repository and the two V1 write
 * permissions. Call only after the Draft PR policy gate; never return or log
 * this token outside the in-memory provider closure.
 */
export async function createScopedGitHubWriteToken(input: {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryId: number;
  owner: string;
  repository: string;
  fetcher?: typeof fetch;
}): Promise<ScopedGitHubWriteToken> {
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    !Number.isSafeInteger(input.repositoryId) ||
    input.repositoryId <= 0 ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.repository)
  ) {
    throw new Error("github_write_repository_identity_invalid");
  }
  const fetcher = input.fetcher ?? fetch;
  const jwt = createAppJwt(input.appId, input.privateKey);
  const app = await request(fetcher, "https://api.github.com/app", jwt);
  if (app.id !== Number(input.appId)) throw new Error("github_write_app_identity_mismatch");

  const tokenResponse = await request(
    fetcher,
    `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: JSON.stringify({
        repository_ids: [input.repositoryId],
        permissions: { contents: "write", pull_requests: "write" },
      }),
    },
  );
  const token = tokenResponse.token;
  const permissions = tokenResponse.permissions;
  const expiresAt = Date.parse(String(tokenResponse.expires_at ?? ""));
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !permissions ||
    typeof permissions !== "object" ||
    Array.isArray(permissions)
  ) {
    throw new Error("github_write_token_response_invalid");
  }
  const granted = permissions as Record<string, unknown>;
  if (
    granted.contents !== "write" ||
    granted.pull_requests !== "write" ||
    Object.entries(granted).some(
      ([name, value]) =>
        !["contents", "pull_requests", "metadata"].includes(name) ||
        (name === "metadata" ? value !== "read" : value !== "write"),
    )
  ) {
    throw new Error("github_write_token_grant_unexpected");
  }

  const repositoryInfo = await request(
    fetcher,
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}`,
    token,
  );
  if (
    repositoryInfo.id !== input.repositoryId ||
    typeof repositoryInfo.full_name !== "string" ||
    repositoryInfo.full_name.toLowerCase() !== `${input.owner}/${input.repository}`.toLowerCase()
  ) {
    throw new Error("github_write_repository_identity_mismatch");
  }
  return {
    token,
    repositoryIdentity: `${input.owner}/${input.repository}`,
    permissions: { contents: "write", pull_requests: "write" },
  };
}
