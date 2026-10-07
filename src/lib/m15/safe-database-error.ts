export type SafeDatabaseErrorDiagnostic = {
  code: string;
  category: string;
  safeMessage: string;
};

const safeDatabaseErrorMessages: Record<string, Omit<SafeDatabaseErrorDiagnostic, "code">> = {
  "42P01": { category: "relation_missing", safeMessage: "Database relation is unavailable." },
  "42883": { category: "function_missing", safeMessage: "Database function is unavailable." },
  "42501": { category: "permission_denied", safeMessage: "Database permission was denied." },
  "57014": {
    category: "query_cancelled",
    safeMessage: "Database query was cancelled or timed out.",
  },
  PGRST202: {
    category: "rpc_not_found_in_schema_cache",
    safeMessage: "Database RPC is unavailable in the exposed schema.",
  },
  PGRST204: {
    category: "column_not_found_in_schema_cache",
    safeMessage: "Database column is unavailable in the exposed schema.",
  },
};

/** Preserve only a validated database code and fixed safe description; discard provider text. */
export function safeDatabaseErrorDiagnostic(error: unknown): SafeDatabaseErrorDiagnostic {
  const candidate = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const code =
    typeof candidate === "string" && /^[A-Z0-9]{4,10}$/.test(candidate) ? candidate : "UNKNOWN";
  return {
    code,
    ...(safeDatabaseErrorMessages[code] ?? {
      category: "database_request_failed",
      safeMessage: "Database request failed; provider details were omitted.",
    }),
  };
}
