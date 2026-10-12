import "server-only";
import { ConnectorError } from "@/lib/connectors/model";
import type { ProviderCredentials } from "@/lib/connectors/providers";
import {
  normalizeDeploymentObservation,
  safeGitHubRepositoryIdentity,
  type DeploymentObservation,
} from "./model";

const MAX_PROVIDER_BYTES = 512 * 1024;
const MAX_DEPLOYMENTS = 20;
const MAX_PROJECTS = 100;
const REQUIRED_READ_SCOPES = [
  "deployment",
  "domain",
  "integration-configuration",
  "project",
] as const;
const ALLOWED_READ_SCOPE_NAMES = new Set([...REQUIRED_READ_SCOPES, "team", "user"]);

export type VercelConfigurationRejectionStage =
  | "configuration_invalid"
  | "configuration_id_mismatch"
  | "team_mismatch"
  | "project_selection_missing"
  | "project_selection_too_broad"
  | "selected_projects_empty"
  | "selected_projects_invalid"
  | "scopes_unreadable"
  | "required_scope_missing"
  | "write_scope_detected"
  | "unexpected_scope_detected";

export type VercelScopeShapeSummary =
  | { type: "string"; value?: string }
  | { type: "object"; keys: string[]; candidateName?: string; candidateAccess?: string }
  | { type: "other" };

export type VercelConfigurationDiagnostic = {
  configurationIdMatches: boolean;
  teamIdMatches: boolean;
  status: string | null;
  projectSelection: "all" | "selected" | null;
  projectCount: number;
  scopeCount: number;
  scopeShapes: VercelScopeShapeSummary[];
  rejectionStage: VercelConfigurationRejectionStage | null;
  missingScopes: string[];
};

export type VercelConfiguration = {
  id: string;
  teamId: string | null;
  projectSelection: "all" | "selected";
  projects: string[];
  scopes: string[];
};

export type VercelProject = {
  id: string;
  name: string;
  accountId: string | null;
  repository: { owner: string; name: string } | null;
  safeMetadata: Record<string, string | number | boolean | null>;
};

export type VercelProjectDeploymentSnapshot = {
  project: VercelProject;
  observations: DeploymentObservation[];
  currentProductionDeploymentId: string | null;
};

function connectorError(status: number) {
  const category =
    status === 401
      ? "AUTH_REQUIRED"
      : status === 403
        ? "PERMISSION_MISSING"
        : status === 404
          ? "RESOURCE_NOT_FOUND"
          : status === 429
            ? "RATE_LIMITED"
            : status >= 500
              ? "PROVIDER_UNAVAILABLE"
              : "UNKNOWN_SAFE";
  return new ConnectorError(
    category,
    status === 429 || status >= 500,
    "vercel",
    "The Vercel connection could not be read.",
  );
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && /^\d+$/.test(length) && Number(length) > MAX_PROVIDER_BYTES) {
    await response.body?.cancel();
    throw new ConnectorError(
      "PROVIDER_UNAVAILABLE",
      true,
      "vercel",
      "Vercel returned an oversized response.",
    );
  }
  if (!response.body)
    throw new ConnectorError(
      "UNKNOWN_SAFE",
      false,
      "vercel",
      "Vercel returned an invalid response.",
    );
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PROVIDER_BYTES) {
        await reader.cancel();
        throw new ConnectorError(
          "PROVIDER_UNAVAILABLE",
          true,
          "vercel",
          "Vercel returned an oversized response.",
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ConnectorError(
      "UNKNOWN_SAFE",
      false,
      "vercel",
      "Vercel returned an invalid response.",
    );
  }
}

async function vercelGet<T>(
  credentials: ProviderCredentials,
  path: string,
  teamId: string | null,
): Promise<T> {
  const url = new URL(`https://api.vercel.com${path}`);
  if (teamId) url.searchParams.set("teamId", teamId);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${credentials.accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
      redirect: "error",
    });
  } catch {
    throw new ConnectorError(
      "PROVIDER_UNAVAILABLE",
      true,
      "vercel",
      "Vercel is temporarily unavailable.",
    );
  }
  if (!response.ok) throw connectorError(response.status);
  return (await readJsonBounded(response)) as T;
}

type ParsedVercelScope = { name: string; access: "read" | "write" | "read-write" };

function scopeAccess(value: unknown): ParsedVercelScope["access"] | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase().replaceAll("_", "/");
  if (normalized === "read") return "read";
  if (normalized === "write") return "write";
  if (normalized === "read/write" || normalized === "read-write") return "read-write";
  return null;
}

function parseVercelScope(value: unknown): ParsedVercelScope | null {
  if (typeof value === "string") {
    // Current Vercel Integration API contract: `read:project` / `read-write:project`.
    const current = /^(read|read-write|write):([a-z][a-z0-9-]{0,79})$/i.exec(value);
    if (current) {
      const access = scopeAccess(current[1]);
      return access ? { name: current[2]!.toLowerCase(), access } : null;
    }
    // Keep compatibility with previously accepted `project:read` values.
    const legacy = /^([a-z][a-z0-9-]{0,79}):(read|read\/write|write)$/i.exec(value);
    if (legacy) {
      const access = scopeAccess(legacy[2]);
      return access ? { name: legacy[1]!.toLowerCase(), access } : null;
    }
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const names = [row.name, row.scope].filter((item) => item !== undefined);
  const accesses = [row.accessLevel, row.access, row.permission].filter(
    (item) => item !== undefined,
  );
  if (
    names.length !== 1 ||
    accesses.length !== 1 ||
    typeof names[0] !== "string" ||
    !/^[a-z][a-z0-9-]{0,79}$/i.test(names[0])
  )
    return null;
  const access = scopeAccess(accesses[0]);
  return access ? { name: names[0].toLowerCase(), access } : null;
}

function parseVercelScopes(value: unknown): ParsedVercelScope[] | null {
  if (Array.isArray(value)) {
    if (value.length > 100) return null;
    const parsed = value.map(parseVercelScope);
    return parsed.some((scope) => scope === null) ? null : (parsed as ParsedVercelScope[]);
  }
  if (value && typeof value === "object") {
    // Preserve the legacy scope map only when every key/value is explicit and valid.
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) return null;
    const parsed = entries.map(([name, access]) => {
      if (!/^[a-z][a-z0-9-]{0,79}$/i.test(name)) return null;
      const normalizedAccess = scopeAccess(access);
      return normalizedAccess ? { name: name.toLowerCase(), access: normalizedAccess } : null;
    });
    return parsed.some((scope) => scope === null) ? null : (parsed as ParsedVercelScope[]);
  }
  return null;
}

function summarizeScopeShapes(value: unknown): VercelScopeShapeSummary[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((scope): VercelScopeShapeSummary => {
    if (typeof scope === "string") {
      const parsed = parseVercelScope(scope);
      return { type: "string", ...(parsed ? { value: `${parsed.access}:${parsed.name}` } : {}) };
    }
    if (scope && typeof scope === "object" && !Array.isArray(scope)) {
      const row = scope as Record<string, unknown>;
      const keys = Object.keys(row)
        .filter((key) => ["name", "scope", "accessLevel", "access", "permission"].includes(key))
        .sort();
      const name = typeof row.name === "string" ? row.name : row.scope;
      const access = row.accessLevel ?? row.access ?? row.permission;
      return {
        type: "object",
        keys,
        ...(typeof name === "string" && /^[a-z][a-z0-9-]{0,79}$/i.test(name)
          ? { candidateName: name.toLowerCase() }
          : {}),
        ...(scopeAccess(access) ? { candidateAccess: scopeAccess(access)! } : {}),
      };
    }
    return { type: "other" };
  });
}

export function normalizeVercelConfiguration(
  value: unknown,
  expected: { configurationId: string; teamId: string | null },
  onDiagnostic?: (diagnostic: VercelConfigurationDiagnostic) => void,
): VercelConfiguration {
  const outer = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  const row =
    outer?.configuration && typeof outer.configuration === "object"
      ? (outer.configuration as Record<string, unknown>)
      : outer;
  const projectSelectionValue = row?.projectSelection ?? row?.project_selection;
  const rawProjects = row?.projects;
  const rawScopes = row?.scopes;
  const status =
    typeof row?.status === "string" &&
    ["error", "onboarding", "pending", "ready", "resumed", "suspended", "uninstalled"].includes(
      row.status.toLowerCase(),
    )
      ? row.status.toLowerCase()
      : null;
  const emitDiagnostic = (
    rejectionStage: VercelConfigurationRejectionStage | null,
    missingScopes: string[] = [],
  ) =>
    onDiagnostic?.({
      configurationIdMatches: row?.id === expected.configurationId,
      teamIdMatches:
        (typeof row?.teamId === "string" ? row.teamId : row?.team_id) === expected.teamId,
      status,
      projectSelection:
        projectSelectionValue === "all" || projectSelectionValue === "selected"
          ? projectSelectionValue
          : null,
      projectCount: Array.isArray(rawProjects) ? Math.min(rawProjects.length, MAX_PROJECTS + 1) : 0,
      scopeCount: Array.isArray(rawScopes) ? Math.min(rawScopes.length, 101) : 0,
      scopeShapes: summarizeScopeShapes(rawScopes),
      rejectionStage,
      missingScopes,
    });
  const reject = (
    stage: VercelConfigurationRejectionStage,
    category: ConstructorParameters<typeof ConnectorError>[0] = "PERMISSION_MISSING",
    message = "Vercel installation permissions could not be verified.",
    missingScopes: string[] = [],
  ): never => {
    emitDiagnostic(stage, missingScopes);
    throw new ConnectorError(category, false, "vercel", message);
  };

  if (!row) {
    emitDiagnostic("configuration_invalid");
    throw new ConnectorError(
      "PERMISSION_MISSING",
      false,
      "vercel",
      "Vercel installation permissions could not be verified.",
    );
  }
  const configurationRow = row;
  if (
    configurationRow.id !== expected.configurationId ||
    (typeof configurationRow.status === "string" &&
      ["disabled", "removed", "error", "suspended", "uninstalled"].includes(
        configurationRow.status.toLowerCase(),
      ))
  )
    reject("configuration_id_mismatch", "AUTH_REQUIRED", "Reconnect this Vercel installation.");
  const teamId =
    typeof configurationRow.teamId === "string"
      ? configurationRow.teamId
      : typeof configurationRow.team_id === "string"
        ? configurationRow.team_id
        : null;
  if (teamId !== expected.teamId)
    reject(
      "team_mismatch",
      "INVALID_REQUEST",
      "Vercel installation account did not match the authorization response.",
    );
  const projectSelection = projectSelectionValue;
  if (projectSelection !== "all" && projectSelection !== "selected")
    reject(
      "project_selection_missing",
      "PERMISSION_MISSING",
      "Vercel project access could not be verified.",
    );
  if (projectSelection !== "selected")
    reject(
      "project_selection_too_broad",
      "PERMISSION_MISSING",
      "Vercel access must be limited to explicitly selected projects.",
    );
  const normalizedProjectSelection = projectSelection as "all" | "selected";
  const projects = Array.isArray(rawProjects)
    ? [
        ...new Set(
          rawProjects.filter(
            (project): project is string =>
              typeof project === "string" && project.length > 0 && project.length <= 200,
          ),
        ),
      ]
    : [];
  if (projectSelection === "selected") {
    if (!Array.isArray(rawProjects) || rawProjects.length === 0)
      reject(
        "selected_projects_empty",
        "PERMISSION_MISSING",
        "No Vercel projects are authorized for this installation.",
      );
    const selectedProjectIds = rawProjects as unknown[];
    if (
      selectedProjectIds.length > MAX_PROJECTS ||
      projects.length !== selectedProjectIds.length ||
      projects.length === 0
    )
      reject(
        "selected_projects_invalid",
        "PERMISSION_MISSING",
        "Vercel project access could not be verified.",
      );
  }
  const parsedScopeResult = parseVercelScopes(rawScopes);
  if (!parsedScopeResult) reject("scopes_unreadable");
  const parsedScopes = parsedScopeResult as ParsedVercelScope[];
  if (parsedScopes.some((scope) => scope.access !== "read"))
    reject(
      "write_scope_detected",
      "PERMISSION_MISSING",
      "Vercel installation includes write permissions.",
    );
  if (parsedScopes.some((scope) => !ALLOWED_READ_SCOPE_NAMES.has(scope.name)))
    reject(
      "unexpected_scope_detected",
      "PERMISSION_MISSING",
      "Vercel installation includes unexpected permissions.",
    );
  const scopes = [...new Set(parsedScopes.map((scope) => `${scope.name}:read`))].sort();
  const missingScopes = REQUIRED_READ_SCOPES.filter((scope) => !scopes.includes(`${scope}:read`));
  if (missingScopes.length)
    reject(
      "required_scope_missing",
      "PERMISSION_MISSING",
      "The Vercel installation is missing required read permissions.",
      missingScopes,
    );
  emitDiagnostic(null);
  return {
    id: expected.configurationId,
    teamId,
    projectSelection: normalizedProjectSelection,
    projects: projects.slice(0, MAX_PROJECTS),
    scopes,
  };
}

export async function getVercelConfiguration(
  credentials: ProviderCredentials,
): Promise<VercelConfiguration> {
  const configurationId = credentials.providerMetadata?.configurationId;
  const teamId = credentials.providerMetadata?.teamId;
  if (typeof configurationId !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(configurationId))
    throw new ConnectorError(
      "AUTH_REQUIRED",
      false,
      "vercel",
      "Reconnect this Vercel installation.",
    );
  const normalizedTeamId = typeof teamId === "string" ? teamId : null;
  const raw = await vercelGet<unknown>(
    credentials,
    `/v1/integrations/configuration/${encodeURIComponent(configurationId)}`,
    normalizedTeamId,
  );
  return normalizeVercelConfiguration(raw, { configurationId, teamId: normalizedTeamId });
}

function safeProject(value: unknown): VercelProject | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  const link =
    row.link && typeof row.link === "object" ? (row.link as Record<string, unknown>) : null;
  const repository = link
    ? safeGitHubRepositoryIdentity({ owner: link.org, name: link.repo })
    : null;
  const accountId = typeof row.accountId === "string" ? row.accountId : null;
  return {
    id: row.id.slice(0, 200),
    name: row.name.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 100),
    accountId,
    repository,
    safeMetadata: {
      accountId,
      framework:
        typeof row.framework === "string" && row.framework.length <= 80 ? row.framework : null,
      gitProvider:
        link && typeof link.type === "string" && link.type.length <= 40 ? link.type : null,
      repositoryOwner: repository?.owner ?? null,
      repositoryName: repository?.name ?? null,
    },
  };
}

export async function listVercelProjects(
  credentials: ProviderCredentials,
  teamId: string | null,
): Promise<VercelProject[]> {
  const configuration = await getVercelConfiguration(credentials);
  if (configuration.teamId !== teamId)
    throw new ConnectorError(
      "INVALID_REQUEST",
      false,
      "vercel",
      "Vercel installation team scope changed.",
    );
  const raw = await vercelGet<{
    projects?: unknown[];
    pagination?: { next?: string | number | null };
  }>(credentials, `/v9/projects?limit=${MAX_PROJECTS}`, teamId);
  const allowed = new Set(configuration.projects);
  return (raw.projects ?? []).slice(0, MAX_PROJECTS).flatMap((item) => {
    const project = safeProject(item);
    return project && (configuration.projectSelection === "all" || allowed.has(project.id))
      ? [project]
      : [];
  });
}

type VercelDeployment = {
  uid?: unknown;
  id?: unknown;
  target?: unknown;
  readyState?: unknown;
  meta?: Record<string, unknown>;
  gitSource?: Record<string, unknown>;
  url?: unknown;
  createdAt?: unknown;
  ready?: unknown;
};

function currentDeploymentId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.deploymentId === "string") return row.deploymentId;
  if (typeof row.deployment === "object" && row.deployment !== null) {
    const deployment = row.deployment as Record<string, unknown>;
    if (typeof deployment.id === "string") return deployment.id;
    if (typeof deployment.uid === "string") return deployment.uid;
  }
  return null;
}

export async function getVercelProjectDeploymentSnapshot(
  credentials: ProviderCredentials,
  projectId: string,
  teamId: string | null,
  observedAt = new Date().toISOString(),
): Promise<VercelProjectDeploymentSnapshot> {
  const projectValue = await vercelGet<unknown>(
    credentials,
    `/v9/projects/${encodeURIComponent(projectId)}`,
    teamId,
  );
  const project = safeProject(projectValue);
  if (!project || project.id !== projectId)
    throw new ConnectorError(
      "RESOURCE_NOT_FOUND",
      false,
      "vercel",
      "The selected Vercel project is unavailable.",
    );
  const [deploymentsResponse, domainsResponse] = await Promise.all([
    vercelGet<{ deployments?: VercelDeployment[] }>(
      credentials,
      `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=${MAX_DEPLOYMENTS}`,
      teamId,
    ),
    vercelGet<{ domains?: Array<{ name?: unknown; verified?: unknown }> }>(
      credentials,
      `/v9/projects/${encodeURIComponent(projectId)}/domains?limit=100`,
      teamId,
    ),
  ]);
  const verifiedDomains = (domainsResponse.domains ?? [])
    .filter(
      (domain) =>
        domain.verified === true &&
        typeof domain.name === "string" &&
        /^[a-z0-9.-]{1,253}$/i.test(domain.name),
    )
    .map((domain) => domain.name as string)
    .slice(0, 10);
  const aliasTargets = await Promise.all(
    verifiedDomains.map(async (domain) => {
      const alias = await vercelGet<unknown>(
        credentials,
        `/v4/aliases/${encodeURIComponent(domain)}`,
        teamId,
      ).catch(() => null);
      return currentDeploymentId(alias);
    }),
  );
  const currentTargets = [...new Set(aliasTargets.filter((id): id is string => Boolean(id)))];
  const currentProductionDeploymentId = currentTargets.length === 1 ? currentTargets[0]! : null;
  const observations = (deploymentsResponse.deployments ?? [])
    .slice(0, MAX_DEPLOYMENTS)
    .flatMap((deployment) => {
      const meta = deployment.meta ?? {};
      const source = deployment.gitSource ?? {};
      const observation = normalizeDeploymentObservation({
        id: deployment.uid ?? deployment.id,
        target: deployment.target,
        state: deployment.readyState,
        commitSha:
          source.sha ?? meta.githubCommitSha ?? meta.gitlabCommitSha ?? meta.bitbucketCommitSha,
        owner: source.org ?? meta.githubOrg ?? meta.gitlabProjectNamespace,
        repository: source.repo ?? meta.githubRepo ?? meta.gitlabProjectName,
        branch: source.ref ?? meta.githubCommitRef ?? meta.gitlabCommitRef,
        url: deployment.url,
        createdAt:
          typeof deployment.createdAt === "number"
            ? new Date(deployment.createdAt).toISOString()
            : deployment.createdAt,
        readyAt:
          typeof deployment.ready === "number" ? new Date(deployment.ready).toISOString() : null,
        observedAt,
        isCurrentProduction: (deployment.uid ?? deployment.id) === currentProductionDeploymentId,
      });
      return observation ? [observation] : [];
    });
  return { project, observations, currentProductionDeploymentId };
}

export function vercelProjectResource(project: VercelProject) {
  return {
    externalResourceId: project.id,
    resourceType: "project" as const,
    displayName: project.name,
    metadata: project.safeMetadata,
  };
}
