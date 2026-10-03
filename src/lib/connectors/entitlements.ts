import type { WorkspaceEntitlements } from "@/lib/billing/plan-catalog";
import type { ConnectorCapability, ConnectorProvider } from "./model";

const ENTITLEMENT_BY_CAPABILITY: Record<
  ConnectorCapability,
  keyof WorkspaceEntitlements["capabilities"] | null
> = {
  CAN_VERIFY: "repositoryConnections",
  CAN_READ_RUNTIME_CONTEXT: "sentryRuntimeContext",
  CAN_RECEIVE_ALERTS: "slackDelivery",
  CAN_CREATE_ACTIONS: "linearActions",
  CAN_PREPARE_REMEDIATION: "generateFix",
  CAN_READ_DEPLOYMENT_CONTEXT: null,
};

export function connectorCapabilityEntitled(
  entitlements: WorkspaceEntitlements,
  capability: ConnectorCapability,
) {
  const entitlement = ENTITLEMENT_BY_CAPABILITY[capability];
  return entitlement ? entitlements.capabilities[entitlement] : false;
}

export function connectorProviderEntitled(
  entitlements: WorkspaceEntitlements,
  provider: ConnectorProvider,
) {
  return provider === "github"
    ? connectorCapabilityEntitled(entitlements, "CAN_VERIFY")
    : connectorCapabilityEntitled(
        entitlements,
        provider === "slack"
          ? "CAN_RECEIVE_ALERTS"
          : provider === "linear"
            ? "CAN_CREATE_ACTIONS"
            : "CAN_READ_RUNTIME_CONTEXT",
      );
}
