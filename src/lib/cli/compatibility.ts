export const SUPPORTED_CLI_PAYLOAD_SCHEMA = "1.0.0" as const;

export function cliPayloadSchemaCompatibility(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "malformed" as const;
  const version = (value as Record<string, unknown>).schemaVersion;
  if (typeof version !== "string") return "malformed" as const;
  return version === SUPPORTED_CLI_PAYLOAD_SCHEMA
    ? ("supported" as const)
    : ("unsupported" as const);
}
