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

export type GitHubInstallationScopeInspection = {
  appIdentityMatches: boolean;
  installationIdentityMatches: boolean;
  accountLogin: string | null;
  installationActive: boolean;
  selectedRepositoriesOnly: boolean;
  requiredWritePermissionsGranted: boolean;
  noUnexpectedWritePermissions: boolean;
  visibleRepositoryCount: number | null;
  exactRepositoryVisible: boolean;
  defaultBranch: string | null;
  defaultBranchSha: string | null;
  requiredPathsPresent?: boolean;
  npmLockfileFamily?: "npm" | "unsupported";
};

/**
 * Read-only scope inspection for an already-installed Auterim GitHub App.
 * It mints a temporary read-only installation token in memory, lists the
 * installation's visible repositories, and never returns the token.
 */
export async function inspectGitHubInstallationScope(input: {
  appId: string;
  privateKey: string;
  installationId: number;
  expectedAccountLogin: string;
  repositoryId: number;
  owner: string;
  repository: string;
  defaultBranch: string;
  requiredPaths?: string[];
  fetcher?: typeof fetch;
}): Promise<GitHubInstallationScopeInspection> {
  if (
    !Number.isSafeInteger(input.installationId) ||
    input.installationId <= 0 ||
    !Number.isSafeInteger(input.repositoryId) ||
    input.repositoryId <= 0 ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.expectedAccountLogin) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.repository) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.defaultBranch) ||
    (input.requiredPaths ?? []).some(
      (path) =>
        path.length > 200 ||
        path.startsWith("/") ||
        path.includes("\\") ||
        path.split("/").some((part) => !part || part === "." || part === ".."),
    )
  ) {
    throw new Error("github_installation_scope_input_invalid");
  }

  const fetcher = input.fetcher ?? fetch;
  const jwt = createAppJwt(input.appId, input.privateKey);
  const app = await request(fetcher, "https://api.github.com/app", jwt);
  const appIdentityMatches = app.id === Number(input.appId);
  if (!appIdentityMatches) {
    return {
      appIdentityMatches: false,
      installationIdentityMatches: false,
      accountLogin: null,
      installationActive: false,
      selectedRepositoriesOnly: false,
      requiredWritePermissionsGranted: false,
      noUnexpectedWritePermissions: false,
      visibleRepositoryCount: null,
      exactRepositoryVisible: false,
      defaultBranch: null,
      defaultBranchSha: null,
    };
  }

  const installation = await request(
    fetcher,
    `https://api.github.com/app/installations/${input.installationId}`,
    jwt,
  );
  const account = installation.account as Record<string, unknown> | undefined;
  const accountLogin = typeof account?.login === "string" ? account.login : null;
  const installationPermissions = installation.permissions as Record<string, unknown> | undefined;
  const installationIdentityMatches =
    installation.id === input.installationId && installation.app_id === Number(input.appId);
  const installationActive = !installation.suspended_at;
  const selectedRepositoriesOnly = installation.repository_selection === "selected";
  const requiredWritePermissionsGranted =
    installationPermissions?.contents === "write" &&
    installationPermissions?.pull_requests === "write";
  const noUnexpectedWritePermissions =
    !!installationPermissions &&
    Object.entries(installationPermissions).every(
      ([name, value]) =>
        ["contents", "pull_requests", "metadata"].includes(name) &&
        (name === "metadata" ? value === "read" : value === "read" || value === "write"),
    );

  if (
    !installationIdentityMatches ||
    accountLogin?.toLowerCase() !== input.expectedAccountLogin.toLowerCase() ||
    !installationActive ||
    !selectedRepositoriesOnly ||
    !noUnexpectedWritePermissions
  ) {
    return {
      appIdentityMatches,
      installationIdentityMatches,
      accountLogin,
      installationActive,
      selectedRepositoriesOnly,
      requiredWritePermissionsGranted,
      noUnexpectedWritePermissions,
      visibleRepositoryCount: null,
      exactRepositoryVisible: false,
      defaultBranch: null,
      defaultBranchSha: null,
    };
  }

  const tokenResponse = await request(
    fetcher,
    `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
    jwt,
    { method: "POST", body: JSON.stringify({ permissions: { contents: "read" } }) },
  );
  const token = tokenResponse.token;
  const expiresAt = Date.parse(String(tokenResponse.expires_at ?? ""));
  const tokenPermissions = tokenResponse.permissions as Record<string, unknown> | undefined;
  if (
    typeof token !== "string" ||
    token.length < 20 ||
    token.length > 4096 ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    !tokenPermissions ||
    tokenPermissions.contents !== "read" ||
    Object.entries(tokenPermissions).some(
      ([name, value]) => !["contents", "metadata"].includes(name) || value !== "read",
    )
  ) {
    throw new Error("github_installation_read_token_invalid");
  }

  const repositoryList = await request(
    fetcher,
    "https://api.github.com/installation/repositories?per_page=100",
    token,
  );
  const totalCount = repositoryList.total_count;
  const repositories = repositoryList.repositories;
  if (
    !Number.isSafeInteger(totalCount) ||
    !Array.isArray(repositories) ||
    totalCount !== repositories.length
  ) {
    throw new Error("github_installation_repository_list_invalid");
  }
  const exactRepositoryVisible =
    totalCount === 1 &&
    repositories.length === 1 &&
    (repositories[0] as Record<string, unknown>)?.id === input.repositoryId &&
    typeof (repositories[0] as Record<string, unknown>)?.full_name === "string" &&
    String((repositories[0] as Record<string, unknown>).full_name).toLowerCase() ===
      `${input.owner}/${input.repository}`.toLowerCase();

  if (!exactRepositoryVisible) {
    return {
      appIdentityMatches,
      installationIdentityMatches,
      accountLogin,
      installationActive,
      selectedRepositoriesOnly,
      requiredWritePermissionsGranted,
      noUnexpectedWritePermissions,
      visibleRepositoryCount: totalCount as number,
      exactRepositoryVisible: false,
      defaultBranch: null,
      defaultBranchSha: null,
    };
  }

  const branch = await request(
    fetcher,
    `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/branches/${encodeURIComponent(input.defaultBranch)}`,
    token,
  );
  const commit = branch.commit as Record<string, unknown> | undefined;
  const defaultBranchSha =
    typeof commit?.sha === "string" && /^[a-f0-9]{40,64}$/i.test(commit.sha)
      ? commit.sha.toLowerCase()
      : null;
  if (!defaultBranchSha) throw new Error("github_installation_default_branch_invalid");

  let requiredPathsPresent: boolean | undefined;
  let npmLockfileFamily: "npm" | "unsupported" | undefined;
  if (input.requiredPaths?.length) {
    const tree = await request(
      fetcher,
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/trees/${encodeURIComponent(defaultBranchSha)}?recursive=1`,
      token,
    );
    const entries = tree.tree;
    if (tree.truncated === true || !Array.isArray(entries))
      throw new Error("github_installation_default_tree_invalid");
    const paths = new Set(
      entries
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
        .filter((entry) => typeof entry.path === "string" && entry.type === "blob")
        .map((entry) => String(entry.path)),
    );
    requiredPathsPresent = input.requiredPaths.every((path) => paths.has(path));
    const lockfiles = [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
    ].filter((path) => paths.has(path));
    npmLockfileFamily =
      lockfiles.length === 1 &&
      (lockfiles[0] === "package-lock.json" || lockfiles[0] === "npm-shrinkwrap.json")
        ? "npm"
        : "unsupported";
  }

  return {
    appIdentityMatches,
    installationIdentityMatches,
    accountLogin,
    installationActive,
    selectedRepositoriesOnly,
    requiredWritePermissionsGranted,
    noUnexpectedWritePermissions,
    visibleRepositoryCount: totalCount as number,
    exactRepositoryVisible,
    defaultBranch: input.defaultBranch,
    defaultBranchSha,
    ...(requiredPathsPresent !== undefined ? { requiredPathsPresent } : {}),
    ...(npmLockfileFamily !== undefined ? { npmLockfileFamily } : {}),
  };
}
