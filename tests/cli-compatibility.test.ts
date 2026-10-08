import { describe, expect, it } from "vitest";
import { cliPayloadSchemaCompatibility } from "@/lib/cli/compatibility";

describe("CLI payload compatibility", () => {
  it("accepts only the currently supported schema version", () => {
    expect(cliPayloadSchemaCompatibility({ schemaVersion: "1.0.0" })).toBe("supported");
    expect(cliPayloadSchemaCompatibility({ schemaVersion: "2.0.0" })).toBe("unsupported");
    expect(cliPayloadSchemaCompatibility({ schemaVersion: 2 })).toBe("malformed");
    expect(cliPayloadSchemaCompatibility(null)).toBe("malformed");
  });
});
