import "server-only";
import type { ConnectorProvider } from "./model";
import type { VercelConfigurationDiagnostic } from "@/lib/deployments/vercel";

export type ConnectorCallbackStage =
  | "state_claim"
  | "pkce_decrypt"
  | "token_exchange"
  | "configuration_fetch"
  | "configuration_normalization"
  | "identity_verification"
  | "credential_encryption"
  | "persistence";

export type ConnectorCallbackOutcome = "started" | "succeeded" | "failed";

export type ConnectorCallbackReason =
  | "invalid_callback"
  | "state_replayed"
  | "authorization_expired"
  | "authorization_failed"
  | "provider_unavailable"
  | "permission_missing"
  | "authorization_save_failed"
  | "rpc_error"
  | "provider_response_invalid"
  | "identity_mismatch";

export function logConnectorCallbackStage(input: {
  provider: ConnectorProvider;
  stage: ConnectorCallbackStage;
  outcome: ConnectorCallbackOutcome;
  reason?: ConnectorCallbackReason;
  providerStatus?: number;
  databaseCode?: string;
}) {
  const event = {
    event: "connector_callback",
    provider: input.provider,
    stage: input.stage,
    outcome: input.outcome,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(Number.isInteger(input.providerStatus) &&
    input.providerStatus! >= 100 &&
    input.providerStatus! <= 599
      ? { providerStatus: input.providerStatus }
      : {}),
    ...(input.databaseCode && /^[0-9A-Z]{5}$/.test(input.databaseCode)
      ? { databaseCode: input.databaseCode }
      : {}),
  };
  console.info(JSON.stringify(event));
}

export function logVercelConfigurationDiagnostic(input: VercelConfigurationDiagnostic) {
  const event = {
    event: "vercel_configuration_normalization",
    configurationIdMatches: input.configurationIdMatches,
    teamIdMatches: input.teamIdMatches,
    status: input.status,
    projectSelection: input.projectSelection,
    projectCount: Number.isInteger(input.projectCount)
      ? Math.min(Math.max(input.projectCount, 0), 101)
      : 0,
    scopeCount: Number.isInteger(input.scopeCount)
      ? Math.min(Math.max(input.scopeCount, 0), 101)
      : 0,
    scopeShapes: input.scopeShapes.slice(0, 100).map((scope) => {
      if (scope.type === "string")
        return {
          type: scope.type,
          ...(scope.value && /^(read|write|read-write):[a-z][a-z0-9-]{0,79}$/.test(scope.value)
            ? { value: scope.value }
            : {}),
        };
      if (scope.type === "object")
        return {
          type: scope.type,
          keys: scope.keys
            .filter((key) => ["name", "scope", "accessLevel", "access", "permission"].includes(key))
            .slice(0, 5),
          ...(scope.candidateName && /^[a-z][a-z0-9-]{0,79}$/.test(scope.candidateName)
            ? { candidateName: scope.candidateName }
            : {}),
          ...(scope.candidateAccess && /^(read|write|read-write)$/.test(scope.candidateAccess)
            ? { candidateAccess: scope.candidateAccess }
            : {}),
        };
      return { type: "other" as const };
    }),
    rejectionStage: input.rejectionStage,
    missingScopes: input.missingScopes
      .filter((scope) => /^[a-z][a-z0-9-]{0,79}$/.test(scope))
      .slice(0, 10),
  };
  console.info(JSON.stringify(event));
}
