export const CONNECTOR_PROVIDERS = ["github", "slack", "linear", "sentry"] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export const CONNECTOR_CAPABILITIES = [
  "CAN_VERIFY",
  "CAN_READ_RUNTIME_CONTEXT",
  "CAN_RECEIVE_ALERTS",
  "CAN_CREATE_ACTIONS",
  "CAN_PREPARE_REMEDIATION",
  "CAN_READ_DEPLOYMENT_CONTEXT",
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export type ConnectorLifecycle =
  "disconnected" | "authorizing" | "connected" | "degraded" | "reauth_required" | "revoked";
export type ConnectorHealth =
  | "healthy"
  | "degraded"
  | "reauth_required"
  | "revoked"
  | "provider_unavailable"
  | "permission_missing"
  | "resource_missing";
export type ConnectorErrorCategory =
  | "AUTH_REQUIRED"
  | "PERMISSION_MISSING"
  | "RESOURCE_NOT_FOUND"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "INVALID_REQUEST"
  | "TRANSIENT"
  | "UNKNOWN_SAFE";

export class ConnectorError extends Error {
  constructor(
    readonly category: ConnectorErrorCategory,
    readonly retryable: boolean,
    readonly provider: ConnectorProvider,
    readonly safeMessage: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(safeMessage);
    this.name = "ConnectorError";
  }
}

export const PROVIDER_CAPABILITIES: Record<ConnectorProvider, readonly ConnectorCapability[]> = {
  github: ["CAN_VERIFY"],
  slack: ["CAN_RECEIVE_ALERTS"],
  linear: ["CAN_CREATE_ACTIONS"],
  sentry: ["CAN_READ_RUNTIME_CONTEXT"],
};

export const PROVIDER_SCOPE_REQUIREMENTS: Record<
  Exclude<ConnectorProvider, "github">,
  { required: readonly string[]; optional: readonly string[] }
> = {
  slack: { required: ["channels:read", "chat:write"], optional: [] },
  linear: { required: ["read", "issues:create"], optional: [] },
  sentry: { required: ["org:read", "project:read", "event:read"], optional: [] },
};

export function hasConnectorCapability(
  provider: ConnectorProvider,
  capability: ConnectorCapability,
): boolean {
  return PROVIDER_CAPABILITIES[provider].includes(capability);
}

export function normalizeProviderFailure(
  provider: ConnectorProvider,
  status: number,
  retryAfter: string | null,
): ConnectorError {
  const retrySeconds = retryAfter && /^\d{1,5}$/.test(retryAfter) ? Number(retryAfter) : undefined;
  if (status === 401)
    return new ConnectorError("AUTH_REQUIRED", false, provider, "Reconnect this connector.");
  if (status === 403)
    return new ConnectorError(
      "PERMISSION_MISSING",
      false,
      provider,
      "This connector is missing a required permission.",
    );
  if (status === 404)
    return new ConnectorError(
      "RESOURCE_NOT_FOUND",
      false,
      provider,
      "The selected resource is unavailable.",
    );
  if (status === 429)
    return new ConnectorError(
      "RATE_LIMITED",
      true,
      provider,
      "The provider is rate limiting requests.",
      Math.min(retrySeconds ?? 60, 3600),
    );
  if (status >= 500)
    return new ConnectorError(
      "PROVIDER_UNAVAILABLE",
      true,
      provider,
      "The provider is temporarily unavailable.",
    );
  if (status >= 400)
    return new ConnectorError(
      "INVALID_REQUEST",
      false,
      provider,
      "The provider rejected this request.",
    );
  return new ConnectorError(
    "UNKNOWN_SAFE",
    false,
    provider,
    "The connector request failed safely.",
  );
}

export type RuntimeSignalClass =
  "runtime_signal_found" | "runtime_signal_not_found" | "runtime_signal_inconclusive";

export function classifyRuntimeContext(input: {
  errors: readonly {
    issueId: string;
    type: string | null;
    firstSeen: string;
    lastSeen: string;
    count: number;
  }[];
  providerIdentifiers: readonly string[];
  windowStart: string;
  windowEnd: string;
}): { result: RuntimeSignalClass; matchedIssueIds: string[]; evidenceCount: number } {
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    return { result: "runtime_signal_inconclusive", matchedIssueIds: [], evidenceCount: 0 };
  const identifiers = input.providerIdentifiers
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length >= 3 && value.length <= 100);
  const inWindow = input.errors.filter((error) => {
    const first = Date.parse(error.firstSeen);
    const last = Date.parse(error.lastSeen);
    return Number.isFinite(first) && Number.isFinite(last) && first <= end && last >= start;
  });
  if (inWindow.length === 0)
    return { result: "runtime_signal_not_found", matchedIssueIds: [], evidenceCount: 0 };
  if (identifiers.length === 0)
    return {
      result: "runtime_signal_inconclusive",
      matchedIssueIds: [],
      evidenceCount: inWindow.length,
    };
  const matches = inWindow.filter((error) => {
    const type = error.type?.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase() ?? "";
    return identifiers.some((identifier) => {
      const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(type);
    });
  });
  return matches.length > 0
    ? {
        result: "runtime_signal_found",
        matchedIssueIds: matches.map((item) => item.issueId).slice(0, 20),
        evidenceCount: matches.length,
      }
    : {
        result: "runtime_signal_inconclusive",
        matchedIssueIds: [],
        evidenceCount: inWindow.length,
      };
}

export function safeConnectorResource(input: {
  id: string;
  type: string;
  name: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  return {
    externalResourceId: input.id.slice(0, 200),
    resourceType: input.type.slice(0, 50),
    displayName: input.name.replace(/[\r\n\u0000-\u001f]/g, " ").slice(0, 160),
    metadata: Object.fromEntries(
      Object.entries(input.metadata ?? {}).filter(([key, value]) => {
        if (!/^(?:isArchived|isPrivate|isMember|slug|teamKey|projectType)$/.test(key)) return false;
        if (typeof value === "boolean" || typeof value === "number") return true;
        return (
          typeof value === "string" &&
          value.length <= 80 &&
          !/[\r\n\u0000-\u001f]/.test(value) &&
          !/\b[^\s@]+@[^\s@]+\b|(?:xox[baprs]-|sk-[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{12,})/i.test(
            value,
          )
        );
      }),
    ),
  };
}
