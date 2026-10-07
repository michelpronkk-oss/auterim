import { describe, expect, it } from "vitest";
import { safeDatabaseErrorDiagnostic } from "@/lib/m15/safe-database-error";

describe("safeDatabaseErrorDiagnostic", () => {
  it("keeps a recognized database code and fixed safe description", () => {
    expect(
      safeDatabaseErrorDiagnostic({
        code: "PGRST202",
        message: "raw provider message with customer content",
        details: "sensitive detail",
        hint: "sensitive hint",
      }),
    ).toEqual({
      code: "PGRST202",
      category: "rpc_not_found_in_schema_cache",
      safeMessage: "Database RPC is unavailable in the exposed schema.",
    });
  });

  it("omits invalid codes and all raw provider details", () => {
    const result = safeDatabaseErrorDiagnostic({
      code: "Bearer secret-token",
      message: "customer@example.com private value",
      details: "private detail",
      hint: "private hint",
    });
    expect(result).toEqual({
      code: "UNKNOWN",
      category: "database_request_failed",
      safeMessage: "Database request failed; provider details were omitted.",
    });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|customer@example\.com|private/);
  });
});
