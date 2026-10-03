import "server-only";
import { createSign } from "node:crypto";
import type {
  CodeSearchHit,
  RepositoryFile,
  RepositoryProvider,
  RepositoryTarget,
} from "@/lib/preflight/preflight";

type GitHubResponse<T> = { data: T; response: Response };

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function createAppJwt(appId: string, privateKey: string, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000) - 30;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 8 * 60, iss: appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
}

async function githubJson<T>(
  url: string,
  token: string,
  init?: RequestInit,
): Promise<GitHubResponse<T>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "Auterim-Preflight/1.0",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`github_http_${response.status}`);
  return { data: (await response.json()) as T, response };
}

export async function exchangeGitHubAppOAuthCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
}) {
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "Auterim-Preflight/1.0",
    },
    body: JSON.stringify({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
    }),
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!tokenResponse.ok) throw new Error("github_oauth_exchange_failed");
  const token = (await tokenResponse.json()) as { access_token?: string; error?: string };
  if (!token.access_token || token.error) throw new Error("github_oauth_exchange_failed");
  const userResponse = await fetch("https://api.github.com/user", {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token.access_token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "Auterim-Preflight/1.0",
    },
    signal: AbortSignal.timeout(12_000),
    cache: "no-store",
  });
  if (!userResponse.ok) throw new Error("github_oauth_identity_failed");
  const user = (await userResponse.json()) as { login?: string };
  if (!user.login || user.login.length > 255) throw new Error("github_oauth_identity_failed");
  return user.login;
}

export class GitHubAppRepositoryProvider implements RepositoryProvider {
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly appId: string;
  private readonly privateKey: string;

  constructor(input: { appId?: string; privateKey?: string }) {
    if (!input.appId || !input.privateKey) throw new Error("github_app_not_configured");
    this.appId = input.appId;
    this.privateKey = input.privateKey.replaceAll("\\n", "\n");
  }

  private async installationToken(repository: RepositoryTarget) {
    const tokenKey = `${repository.installationId}:${repository.externalId}`;
    const cached = this.tokens.get(tokenKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;
    const appJwt = createAppJwt(this.appId, this.privateKey);
    const response = await fetch(
      `https://api.github.com/app/installations/${repository.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${appJwt}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Auterim-Preflight/1.0",
        },
        body: JSON.stringify({
          repository_ids: [repository.externalId],
          permissions: { contents: "read" },
        }),
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error(`github_installation_token_${response.status}`);
    const tokenResponse = (await response.json()) as { token: string; expires_at: string };
    const expiresAt = Date.parse(tokenResponse.expires_at);
    if (!tokenResponse.token || !Number.isFinite(expiresAt))
      throw new Error("github_invalid_installation_token");
    this.tokens.set(tokenKey, { value: tokenResponse.token, expiresAt });
    return tokenResponse.token;
  }

  private async installationMetadata(installationId: number) {
    const response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${createAppJwt(this.appId, this.privateKey)}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "Auterim-Preflight/1.0",
      },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`github_installation_${response.status}`);
    return (await response.json()) as {
      id: number;
      account?: { login?: string } | null;
      suspended_at?: string | null;
    };
  }

  async getInstallationAccount(installationId: number) {
    const installation = await this.installationMetadata(installationId);
    if (installation.suspended_at || !installation.account?.login)
      throw new Error("github_installation_unavailable");
    return installation.account.login;
  }

  async listInstallationRepositories(installationId: number) {
    const response = await fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${createAppJwt(this.appId, this.privateKey)}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "Auterim-Preflight/1.0",
        },
        body: JSON.stringify({ permissions: { contents: "read" } }),
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      },
    );
    if (!response.ok) throw new Error(`github_installation_token_${response.status}`);
    const token = (await response.json()) as { token: string; expires_at: string };
    if (!token.token || !Number.isFinite(Date.parse(token.expires_at)))
      throw new Error("github_invalid_installation_token");
    type InstallationRepository = {
      id: number;
      name: string;
      full_name: string;
      owner: { login: string };
      default_branch: string;
      private: boolean;
      archived: boolean;
    };
    const repositories: InstallationRepository[] = [];
    let totalCount = 0;
    for (let page = 1; page <= 5; page++) {
      const result = await githubJson<{
        total_count: number;
        repositories: InstallationRepository[];
      }>(`https://api.github.com/installation/repositories?per_page=100&page=${page}`, token.token);
      if (page === 1) totalCount = result.data.total_count;
      if (totalCount > 500) throw new Error("github_repository_limit_exceeded");
      repositories.push(...result.data.repositories);
      if (repositories.length >= totalCount || result.data.repositories.length === 0) break;
    }
    if (repositories.length < totalCount) throw new Error("github_repository_list_truncated");
    return repositories;
  }

  async getHead(repository: RepositoryTarget) {
    const token = await this.installationToken(repository);
    const branch = await githubJson<{ commit: { sha: string } }>(
      `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/branches/${encodeURIComponent(repository.defaultBranch)}`,
      token,
    );
    if (!/^[a-f0-9]{40,64}$/.test(branch.data.commit.sha))
      throw new Error("github_invalid_head_sha");
    return branch.data.commit.sha;
  }

  async searchCode(repository: RepositoryTarget, query: string): Promise<CodeSearchHit[]> {
    const token = await this.installationToken(repository);
    const search = new URL("https://api.github.com/search/code");
    const safeQuery = query.replace(/[^A-Za-z0-9_.:/@+-]/g, "").slice(0, 80);
    if (!safeQuery) return [];
    search.searchParams.set("q", `repo:${repository.owner}/${repository.name} "${safeQuery}"`);
    search.searchParams.set("per_page", "20");
    const response = await githubJson<{
      total_count?: number;
      items: Array<{ path: string }>;
      incomplete_results?: boolean;
    }>(search.toString(), token);
    if (response.data.incomplete_results) throw new Error("github_search_incomplete");
    const truncated =
      (response.data.total_count ?? response.data.items.length) > response.data.items.length;
    return response.data.items.map((item) => ({ path: item.path, line: 1, text: "", truncated }));
  }

  async getFile(
    repository: RepositoryTarget,
    path: string,
    ref: string,
  ): Promise<RepositoryFile | null> {
    const token = await this.installationToken(repository);
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github.raw+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "Auterim-Preflight/1.0",
      },
      signal: AbortSignal.timeout(12_000),
      cache: "no-store",
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`github_file_${response.status}`);
    if (!response.body) return { path, text: "", size: 0 };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 256_000) {
          await reader.cancel("file_too_large");
          return { path, text: "", size };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      size,
    );
    const text = bytes.toString("utf8");
    if (text.includes("\u0000")) return { path, text: "", size: bytes.byteLength };
    return { path, text, size: bytes.byteLength };
  }
}
