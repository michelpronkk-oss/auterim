import "server-only";
import type { ConnectorProvider } from "./model";

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
