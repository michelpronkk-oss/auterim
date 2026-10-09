export const DEPLOYMENT_PROVIDERS = ["vercel"] as const;
export type DeploymentProvider = (typeof DEPLOYMENT_PROVIDERS)[number];

export type DeploymentEnvironment = "production" | "preview" | "custom" | "unknown";
export type DeploymentState = "queued" | "building" | "ready" | "error" | "canceled" | "unknown";
export type DeploymentVerification =
  "observed" | "mapped" | "commit_verified" | "production_verified" | "inconclusive" | "historical";

export type DeploymentObservation = {
  providerDeploymentId: string;
  environment: DeploymentEnvironment;
  state: DeploymentState;
  commitSha: string | null;
  sourceRepository: { owner: string; name: string } | null;
  branch: string | null;
  url: string | null;
  createdAt: string | null;
  readyAt: string | null;
  observedAt: string;
  isCurrentProduction: boolean;
};

export type RepositoryCommitEvidence = {
  workspaceId: string;
  productId: string;
  repositoryId: string;
  commitSha: string;
  verified: boolean;
};

export type DeploymentEvidenceDecision = {
  state: DeploymentVerification;
  exactCommitMatch: boolean;
  reason:
    | "unmapped"
    | "repository_mismatch"
    | "commit_missing"
    | "commit_mismatch"
    | "not_production"
    | "deployment_not_ready"
    | "historical"
    | "verified";
};

const shaPattern = /^[a-f0-9]{40,64}$/i;

export function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !parsed.hostname
    )
      return null;
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function safeGitHubRepositoryIdentity(input: {
  owner: unknown;
  name: unknown;
}): { owner: string; name: string } | null {
  if (
    typeof input.owner !== "string" ||
    typeof input.name !== "string" ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.owner) ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(input.name)
  )
    return null;
  return { owner: input.owner.toLowerCase(), name: input.name.toLowerCase() };
}

export function decideDeploymentEvidence(input: {
  repositoryEvidence: RepositoryCommitEvidence | null;
  mappedWorkspaceId: string | null;
  mappedProductId: string | null;
  mappedRepositoryId: string | null;
  mappedRepositoryIdentity?: { owner: string; name: string } | null;
  observation: DeploymentObservation;
}): DeploymentEvidenceDecision {
  const { repositoryEvidence, observation } = input;
  if (
    !repositoryEvidence ||
    !input.mappedWorkspaceId ||
    !input.mappedProductId ||
    !input.mappedRepositoryId
  )
    return { state: "observed", exactCommitMatch: false, reason: "unmapped" };
  if (
    input.mappedRepositoryIdentity &&
    (!observation.sourceRepository ||
      observation.sourceRepository.owner !== input.mappedRepositoryIdentity.owner.toLowerCase() ||
      observation.sourceRepository.name !== input.mappedRepositoryIdentity.name.toLowerCase())
  )
    return { state: "inconclusive", exactCommitMatch: false, reason: "repository_mismatch" };
  if (
    repositoryEvidence.workspaceId !== input.mappedWorkspaceId ||
    repositoryEvidence.productId !== input.mappedProductId ||
    repositoryEvidence.repositoryId !== input.mappedRepositoryId ||
    !repositoryEvidence.verified
  )
    return { state: "inconclusive", exactCommitMatch: false, reason: "repository_mismatch" };
  if (!observation.commitSha || !shaPattern.test(observation.commitSha))
    return { state: "inconclusive", exactCommitMatch: false, reason: "commit_missing" };
  if (observation.commitSha.toLowerCase() !== repositoryEvidence.commitSha.toLowerCase())
    return { state: "inconclusive", exactCommitMatch: false, reason: "commit_mismatch" };
  if (observation.environment !== "production")
    return { state: "commit_verified", exactCommitMatch: true, reason: "not_production" };
  if (observation.state !== "ready")
    return { state: "commit_verified", exactCommitMatch: true, reason: "deployment_not_ready" };
  if (!observation.isCurrentProduction)
    return { state: "historical", exactCommitMatch: true, reason: "historical" };
  return { state: "production_verified", exactCommitMatch: true, reason: "verified" };
}

export function normalizeDeploymentObservation(input: {
  id: unknown;
  target: unknown;
  state: unknown;
  commitSha: unknown;
  owner: unknown;
  repository: unknown;
  branch: unknown;
  url: unknown;
  createdAt: unknown;
  readyAt: unknown;
  observedAt: string;
  isCurrentProduction: boolean;
}): DeploymentObservation | null {
  if (typeof input.id !== "string" || input.id.length < 1 || input.id.length > 200) return null;
  const target =
    input.target === "production" || input.target === "preview" ? input.target : "custom";
  const stateMap: Record<string, DeploymentState> = {
    QUEUED: "queued",
    INITIALIZING: "building",
    BUILDING: "building",
    READY: "ready",
    ERROR: "error",
    CANCELED: "canceled",
    CANCELLED: "canceled",
  };
  const state = typeof input.state === "string" ? (stateMap[input.state] ?? "unknown") : "unknown";
  const commitSha =
    typeof input.commitSha === "string" && shaPattern.test(input.commitSha)
      ? input.commitSha.toLowerCase()
      : null;
  const sourceRepository = safeGitHubRepositoryIdentity({
    owner: input.owner,
    name: input.repository,
  });
  const validDate = (value: unknown) => {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
    return new Date(value).toISOString();
  };
  return {
    providerDeploymentId: input.id,
    environment: target,
    state,
    commitSha,
    sourceRepository,
    branch:
      typeof input.branch === "string"
        ? input.branch.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 255)
        : null,
    url: safeHttpsUrl(
      typeof input.url === "string" ? `https://${input.url.replace(/^https?:\/\//i, "")}` : null,
    ),
    createdAt: validDate(input.createdAt),
    readyAt: validDate(input.readyAt),
    observedAt: input.observedAt,
    isCurrentProduction: target === "production" && input.isCurrentProduction,
  };
}
