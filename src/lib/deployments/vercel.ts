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

function readScopeNames(value: unknown): string[] {
  const rows: Array<{ name: string; access: string }> = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        const match = /^([a-z-]+):(read|read\/write|write)$/i.exec(item);
        if (match) rows.push({ name: match[1]!.toLowerCase(), access: match[2]!.toLowerCase() });
      } else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const name =
          typeof row.name === "string" ? row.name : typeof row.scope === "string" ? row.scope : "";
        const access =
          typeof row.accessLevel === "string"
            ? row.accessLevel
            : typeof row.access === "string"
              ? row.access
              : typeof row.permission === "string"
                ? row.permission
                : "";
        if (name && access)
          rows.push({
            name: name.toLowerCase(),
            access: access.toLowerCase().replaceAll("_", "/"),
          });
      }
    }
  } else if (value && typeof value === "object") {
    for (const [name, accessValue] of Object.entries(value as Record<string, unknown>))
      if (typeof accessValue === "string")
        rows.push({
          name: name.toLowerCase(),
          access: accessValue.toLowerCase().replaceAll("_", "/"),
        });
  }
  return [
    ...new Set(
      rows
        .filter((scope) => scope.access === "read" || scope.access === "read/write")
        .map((scope) => `${scope.name}:read`),
    ),
  ].sort();
}

function hasWriteScope(value: unknown): boolean {
  const accessLevels: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        const match = /^[a-z-]+:(read|read\/write|write)$/i.exec(item);
        if (match) accessLevels.push(match[1]!.toLowerCase());
      } else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        const access =
          typeof row.accessLevel === "string"
            ? row.accessLevel
            : typeof row.access === "string"
              ? row.access
              : typeof row.permission === "string"
                ? row.permission
                : "";
        if (access) accessLevels.push(access.toLowerCase().replaceAll("_", "/"));
      }
    }
  } else if (value && typeof value === "object") {
    for (const access of Object.values(value as Record<string, unknown>))
      if (typeof access === "string") accessLevels.push(access.toLowerCase().replaceAll("_", "/"));
  }
  return accessLevels.some((access) => access === "write" || access === "read/write");
}

export function normalizeVercelConfiguration(
  value: unknown,
  expected: { configurationId: string; teamId: string | null },
): VercelConfiguration {
  if (!value || typeof value !== "object")
    throw new ConnectorError(
      "PERMISSION_MISSING",
      false,
      "vercel",
      "Vercel installation permissions could not be verified.",
    );
  const outer = value as Record<string, unknown>;
  const row =
    outer.configuration && typeof outer.configuration === "object"
      ? (outer.configuration as Record<string, unknown>)
      : outer;
  if (
    row.id !== expected.configurationId ||
    (typeof row.status === "string" &&
      ["disabled", "removed", "error"].includes(row.status.toLowerCase()))
  )
    throw new ConnectorError(
      "AUTH_REQUIRED",
      false,
      "vercel",
      "Reconnect this Vercel installation.",
    );
  const teamId =
    typeof row.teamId === "string"
      ? row.teamId
      : typeof row.team_id === "string"
        ? row.team_id
        : null;
  if (teamId !== expected.teamId)
    throw new ConnectorError(
      "INVALID_REQUEST",
      false,
      "vercel",
      "Vercel installation account did not match the authorization response.",
    );
  const projectSelection = row.projectSelection ?? row.project_selection;
  if (projectSelection !== "all" && projectSelection !== "selected")
    throw new ConnectorError(
      "PERMISSION_MISSING",
      false,
      "vercel",
      "Vercel project access could not be verified.",
    );
  const rawProjects = row.projects;
  const projects = Array.isArray(rawProjects)
    ? [
        ...new Set(
          rawProjects.flatMap((project) => {
            const id =
              typeof project === "string"
                ? project
                : project &&
                    typeof project === "object" &&
                    "id" in project &&
                    typeof project.id === "string"
                  ? project.id
                  : null;
            return id && id.length <= 200 ? [id] : [];
          }),
        ),
      ].slice(0, MAX_PROJECTS)
    : [];
  if (projectSelection === "selected" && projects.length === 0)
    throw new ConnectorError(
      "PERMISSION_MISSING",
      false,
      "vercel",
      "No Vercel projects are authorized for this installation.",
    );
  const scopes = readScopeNames(row.scopes);
  if (
    hasWriteScope(row.scopes) ||
    !REQUIRED_READ_SCOPES.every((scope) => scopes.includes(`${scope}:read`))
  )
    throw new ConnectorError(
      "PERMISSION_MISSING",
      false,
      "vercel",
      "The Vercel installation is missing required read permissions.",
    );
  return { id: expected.configurationId, teamId, projectSelection, projects, scopes };
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
