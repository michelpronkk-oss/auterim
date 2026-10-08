import "server-only";
import { createSign } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type {
  CodeSearchHit,
  RepositoryFile,
  RepositoryProvider,
  RepositoryTarget,
} from "@/lib/preflight/preflight";

type GitHubResponse<T> = { data: T; response: Response };

export type GitHubAppInstallationFailureStage =
  | "app_jwt"
  | "user_installations"
  | "user_installation_authorization"
  | "installation_metadata"
  | "installation_token"
  | "repository_list";

export type GitHubAppInstallationFailureCategory =
  | "signing_failed"
  | "app_jwt_rejected"
  | "installation_token_rejected"
  | "installation_not_found"
  | "permission_denied"
  | "rate_limited"
  | "provider_unavailable"
  | "invalid_response"
  | "installation_unavailable"
  | "http_error"
  | "repository_limit_exceeded"
  | "repository_list_truncated";

/** Safe provider-stage metadata; never includes an upstream response body or credential. */
export class GitHubAppInstallationError extends Error {
  readonly stage: GitHubAppInstallationFailureStage;
  readonly category: GitHubAppInstallationFailureCategory;
  readonly upstreamStatus?: number;

  constructor(input: {
    stage: GitHubAppInstallationFailureStage;
    category: GitHubAppInstallationFailureCategory;
    upstreamStatus?: number;
  }) {
    const suffix = input.upstreamStatus ? `_${input.upstreamStatus}` : "";
    const message =
      input.category === "repository_limit_exceeded"
        ? "github_repository_limit_exceeded"
        : input.category === "repository_list_truncated"
          ? "github_repository_list_truncated"
          : `github_installation_${input.stage}_${input.category}${suffix}`;
    super(message);
    this.name = "GitHubAppInstallationError";
    this.stage = input.stage;
    this.category = input.category;
    this.upstreamStatus = input.upstreamStatus;
  }
}

function installationHttpCategory(
  stage: GitHubAppInstallationFailureStage,
  status: number,
): GitHubAppInstallationFailureCategory {
  if (status === 401)
    return stage === "repository_list" ? "installation_token_rejected" : "app_jwt_rejected";
  if (status === 403) return "permission_denied";
  if (status === 404) return "installation_not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_unavailable";
  return "http_error";
}

function safeInstallationError(
  stage: GitHubAppInstallationFailureStage,
  error: unknown,
): GitHubAppInstallationError {
  if (error instanceof GitHubAppInstallationError) return error;
  const message = error instanceof Error ? error.message : "";
  const statusMatch = /^github_(?:installation|http)_(\d{3})$/.exec(message);
  if (statusMatch) {
    const upstreamStatus = Number(statusMatch[1]);
    return new GitHubAppInstallationError({
      stage,
      category: installationHttpCategory(stage, upstreamStatus),
      upstreamStatus,
    });
  }
  if (message === "github_repository_limit_exceeded") {
    return new GitHubAppInstallationError({
      stage,
      category: "repository_limit_exceeded",
    });
  }
  if (message === "github_repository_list_truncated") {
    return new GitHubAppInstallationError({
      stage,
      category: "repository_list_truncated",
    });
  }
  if (message === "github_invalid_installation_token") {
    return new GitHubAppInstallationError({ stage, category: "invalid_response" });
  }
  return new GitHubAppInstallationError({ stage, category: "provider_unavailable" });
}

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

const MAX_ARCHIVE_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 28 * 1024 * 1024;
const MAX_ARCHIVE_FILES = 1_000;
const MAX_ARCHIVE_FILE_BYTES = 1_000_000;

function safeArchivePath(root: string, name: string) {
  if (!name || name.includes("\\") || name.includes("\0") || name.startsWith("/")) return null;
  const parts = name.split("/");
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) return null;
  const relative = parts.slice(1).join("/");
  if (
    !relative ||
    relative.split("/").some((part) => [".git", "node_modules"].includes(part.toLowerCase())) ||
    relative
      .split("/")
      .some((part) => part.toLowerCase() === ".env" || part.toLowerCase().startsWith(".env."))
  )
    return null;
  const target = path.resolve(root, ...relative.split("/"));
  return target.startsWith(`${path.resolve(root)}${path.sep}`) ? { target, relative } : null;
}

async function boundedBody(response: Response, maximum: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new Error("github_repository_archive_too_large");
  }
  if (!response.body) throw new Error("github_repository_archive_unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) {
        await reader.cancel("archive_bound_exceeded");
        throw new Error("github_repository_archive_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    length,
  );
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
  return { login: user.login, accessToken: token.access_token };
}

export type GitHubUserInstallation = {
  id: number;
  appId: number;
  accountLogin: string;
  targetType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  permissions: Record<string, string>;
  suspendedAt: string | null;
};

type GitHubUserInstallationResponse = {
  total_count: number;
  installations: Array<{
    id: number;
    app_id: number;
    account?: { login?: string } | null;
    target_type: "User" | "Organization";
    repository_selection: "all" | "selected";
    permissions?: Record<string, string>;
    suspended_at?: string | null;
  }>;
};

/**
 * Lists only the current GitHub App's installations visible to this ephemeral
 * user access token. The token must remain in server memory and must never be
 * persisted, logged, or returned to a browser.
 */
export async function listUserAccessibleGitHubAppInstallations(input: {
  accessToken: string;
  appId: string;
}): Promise<GitHubUserInstallation[]> {
  const numericAppId = Number(input.appId);
  if (!Number.isSafeInteger(numericAppId) || numericAppId <= 0)
    throw new Error("github_app_identity_invalid");
  const installations: GitHubUserInstallation[] = [];
  let totalCount: number | undefined;
  for (let page = 1; page <= 10; page++) {
    let result: GitHubResponse<GitHubUserInstallationResponse>;
    try {
      result = await githubJson<GitHubUserInstallationResponse>(
        `https://api.github.com/user/installations?per_page=100&page=${page}`,
        input.accessToken,
      );
    } catch {
      throw new Error("github_user_installations_unavailable");
    }
    const data = result.data;
    if (
      !Number.isSafeInteger(data?.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data.installations) ||
      data.installations.some(
        (installation) =>
          !Number.isSafeInteger(installation?.id) ||
          !Number.isSafeInteger(installation?.app_id) ||
          typeof installation?.account?.login !== "string" ||
          !["User", "Organization"].includes(installation.target_type) ||
          !["all", "selected"].includes(installation.repository_selection) ||
          !installation.permissions ||
          typeof installation.permissions !== "object",
      )
    ) {
      throw new Error("github_user_installations_invalid_response");
    }
    totalCount ??= data.total_count;
    if (data.total_count !== totalCount)
      throw new Error("github_user_installations_invalid_response");
    installations.push(
      ...data.installations
        .filter((installation) => installation.app_id === numericAppId)
        .map((installation) => ({
          id: installation.id,
          appId: installation.app_id,
          accountLogin: installation.account!.login!,
          targetType: installation.target_type,
          repositorySelection: installation.repository_selection,
          permissions: installation.permissions!,
          suspendedAt: installation.suspended_at ?? null,
        })),
    );
    if (page * 100 >= totalCount) return installations;
  }
  if ((totalCount ?? 0) > 1_000) throw new Error("github_user_installations_limit_exceeded");
  return installations;
}

export type GitHubUserAccessibleRepository = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  default_branch: string;
  private: boolean;
  archived: boolean;
};

/** Bounded user-side proof that the OAuth user can enumerate this installation. */
export async function listUserAccessibleInstallationRepositories(input: {
  accessToken: string;
  installationId: number;
}): Promise<GitHubUserAccessibleRepository[]> {
  if (!Number.isSafeInteger(input.installationId) || input.installationId <= 0)
    throw new Error("github_installation_not_authorized");
  const repositories: GitHubUserAccessibleRepository[] = [];
  let totalCount: number | undefined;
  for (let page = 1; page <= 5; page++) {
    let result: GitHubResponse<{
      total_count: number;
      repositories: GitHubUserAccessibleRepository[];
    }>;
    try {
      result = await githubJson(
        `https://api.github.com/user/installations/${input.installationId}/repositories?per_page=100&page=${page}`,
        input.accessToken,
      );
    } catch {
      throw new Error("github_user_repository_access_unavailable");
    }
    const data = result.data;
    if (
      !Number.isSafeInteger(data?.total_count) ||
      data.total_count < 0 ||
      !Array.isArray(data.repositories) ||
      data.repositories.some(
        (repository) =>
          !Number.isSafeInteger(repository?.id) ||
          typeof repository?.name !== "string" ||
          typeof repository?.full_name !== "string" ||
          typeof repository?.owner?.login !== "string" ||
          typeof repository?.default_branch !== "string" ||
          typeof repository?.private !== "boolean" ||
          typeof repository?.archived !== "boolean",
      )
    ) {
      throw new Error("github_user_repository_access_invalid_response");
    }
    totalCount ??= data.total_count;
    if (data.total_count !== totalCount)
      throw new Error("github_user_repository_access_invalid_response");
    repositories.push(...data.repositories);
    if (repositories.length > 500) throw new Error("github_user_repository_limit_exceeded");
    if (page * 100 >= totalCount) return repositories;
  }
  if ((totalCount ?? 0) > 500) throw new Error("github_user_repository_limit_exceeded");
  return repositories;
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

  private installationAppJwt() {
    try {
      return createAppJwt(this.appId, this.privateKey);
    } catch {
      throw new GitHubAppInstallationError({ stage: "app_jwt", category: "signing_failed" });
    }
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
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/app/installations/${installationId}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.installationAppJwt()}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "Auterim-Preflight/1.0",
        },
        signal: AbortSignal.timeout(12_000),
        cache: "no-store",
      });
    } catch (error) {
      throw safeInstallationError("installation_metadata", error);
    }
    if (!response.ok) {
      throw new GitHubAppInstallationError({
        stage: "installation_metadata",
        category: installationHttpCategory("installation_metadata", response.status),
        upstreamStatus: response.status,
      });
    }
    try {
      const installation = (await response.json()) as {
        id: number;
        app_id?: number;
        account?: { login?: string } | null;
        target_type?: "User" | "Organization";
        repository_selection?: "all" | "selected";
        permissions?: Record<string, string>;
        suspended_at?: string | null;
      };
      if (
        !installation ||
        installation.id !== installationId ||
        installation.app_id !== Number(this.appId) ||
        !["User", "Organization"].includes(installation.target_type ?? "") ||
        !["all", "selected"].includes(installation.repository_selection ?? "") ||
        !installation.permissions ||
        installation.permissions.contents !== "read" ||
        installation.permissions.metadata !== "read" ||
        Object.values(installation.permissions).some((permission) => permission !== "read") ||
        (installation.account !== null &&
          installation.account !== undefined &&
          typeof installation.account.login !== "string")
      ) {
        throw new Error("invalid_installation_metadata");
      }
      return installation;
    } catch {
      throw new GitHubAppInstallationError({
        stage: "installation_metadata",
        category: "invalid_response",
      });
    }
  }

  async getInstallationAccount(installationId: number) {
    const installation = await this.installationMetadata(installationId);
    if (installation.suspended_at || !installation.account?.login)
      throw new GitHubAppInstallationError({
        stage: "installation_metadata",
        category: "installation_unavailable",
      });
    return installation.account.login;
  }

  async verifyInstallation(installationId: number): Promise<GitHubUserInstallation> {
    const installation = await this.installationMetadata(installationId);
    if (installation.suspended_at || !installation.account?.login)
      throw new GitHubAppInstallationError({
        stage: "installation_metadata",
        category: "installation_unavailable",
      });
    return {
      id: installation.id,
      appId: Number(this.appId),
      accountLogin: installation.account.login,
      targetType: installation.target_type!,
      repositorySelection: installation.repository_selection!,
      permissions: installation.permissions!,
      suspendedAt: installation.suspended_at ?? null,
    };
  }

  async listInstallationRepositories(installationId: number) {
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${this.installationAppJwt()}`,
            "content-type": "application/json",
            "x-github-api-version": "2022-11-28",
            "user-agent": "Auterim-Preflight/1.0",
          },
          body: JSON.stringify({ permissions: { contents: "read" } }),
          signal: AbortSignal.timeout(12_000),
          cache: "no-store",
        },
      );
    } catch (error) {
      throw safeInstallationError("installation_token", error);
    }
    if (!response.ok) {
      throw new GitHubAppInstallationError({
        stage: "installation_token",
        category: installationHttpCategory("installation_token", response.status),
        upstreamStatus: response.status,
      });
    }
    let token: { token?: string; expires_at?: string };
    try {
      token = (await response.json()) as { token?: string; expires_at?: string };
    } catch {
      throw new GitHubAppInstallationError({
        stage: "installation_token",
        category: "invalid_response",
      });
    }
    if (!token.token || !Number.isFinite(Date.parse(token.expires_at ?? "")))
      throw new GitHubAppInstallationError({
        stage: "installation_token",
        category: "invalid_response",
      });
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
      let result: GitHubResponse<{
        total_count: number;
        repositories: InstallationRepository[];
      }>;
      try {
        result = await githubJson<{
          total_count: number;
          repositories: InstallationRepository[];
        }>(
          `https://api.github.com/installation/repositories?per_page=100&page=${page}`,
          token.token,
        );
      } catch (error) {
        throw safeInstallationError("repository_list", error);
      }
      if (
        !Number.isSafeInteger(result.data?.total_count) ||
        result.data.total_count < 0 ||
        !Array.isArray(result.data?.repositories) ||
        result.data.repositories.some(
          (repository) =>
            !Number.isSafeInteger(repository?.id) ||
            typeof repository?.owner?.login !== "string" ||
            typeof repository?.name !== "string" ||
            typeof repository?.default_branch !== "string" ||
            typeof repository?.private !== "boolean" ||
            typeof repository?.archived !== "boolean",
        )
      ) {
        throw new GitHubAppInstallationError({
          stage: "repository_list",
          category: "invalid_response",
        });
      }
      if (page === 1) totalCount = result.data.total_count;
      if (totalCount > 500) throw new Error("github_repository_limit_exceeded");
      repositories.push(...result.data.repositories);
      if (repositories.length >= totalCount || result.data.repositories.length === 0) break;
    }
    if (repositories.length < totalCount)
      throw new GitHubAppInstallationError({
        stage: "repository_list",
        category: "repository_list_truncated",
      });
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

  /** Materialize only a bounded, regular-file snapshot at the exact verified commit. */
  async materializeRepository(repository: RepositoryTarget, ref: string, destination: string) {
    if (!/^[a-f0-9]{40,64}$/.test(ref)) throw new Error("github_invalid_repository_ref");
    const token = await this.installationToken(repository);
    const archiveUrl = `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/tarball/${ref}`;
    let response = await fetch(archiveUrl, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        "user-agent": "Auterim-Preflight/1.0",
      },
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
      cache: "no-store",
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("github_repository_archive_unavailable");
      const redirect = new URL(location, archiveUrl);
      if (
        redirect.protocol !== "https:" ||
        redirect.hostname !== "codeload.github.com" ||
        (redirect.port !== "" && redirect.port !== "443")
      ) {
        throw new Error("github_repository_archive_redirect_rejected");
      }
      response = await fetch(redirect, {
        signal: AbortSignal.timeout(20_000),
        redirect: "error",
        cache: "no-store",
      });
    }
    if (!response.ok) throw new Error(`github_repository_archive_${response.status}`);
    const compressed = await boundedBody(response, MAX_ARCHIVE_COMPRESSED_BYTES);
    let tar: Buffer;
    try {
      tar = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_EXPANDED_BYTES });
    } catch {
      throw new Error("github_repository_archive_invalid");
    }
    await mkdir(destination, { recursive: true });
    let offset = 0;
    let files = 0;
    let extracted = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const nul = header.indexOf(0, 0);
      const rawName = header.subarray(0, nul < 0 ? 100 : nul).toString("utf8");
      const rawPrefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      const archiveName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
      const rawSize = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
      const size = rawSize ? Number.parseInt(rawSize, 8) : 0;
      const kind = header[156] === 0 ? "0" : String.fromCharCode(header[156]!);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) {
        throw new Error("github_repository_archive_invalid");
      }
      if (kind === "0" && size > 0) {
        const entry = safeArchivePath(destination, archiveName);
        if (entry && size <= MAX_ARCHIVE_FILE_BYTES) {
          if (++files > MAX_ARCHIVE_FILES || extracted + size > MAX_ARCHIVE_EXPANDED_BYTES) {
            throw new Error("github_repository_archive_bounds_exceeded");
          }
          const data = tar.subarray(offset + 512, offset + 512 + size);
          await mkdir(path.dirname(entry.target), { recursive: true });
          await writeFile(entry.target, data, { flag: "wx" });
          extracted += size;
        }
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    if (files === 0) throw new Error("github_repository_archive_empty");
    return { files, bytes: extracted };
  }
}
