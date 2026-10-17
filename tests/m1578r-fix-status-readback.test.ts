import { describe, expect, it } from "vitest";
import {
  M1578RInternalTestAcceptanceInputSchema,
  sanitizeM1578RVerificationChecks,
} from "../src/trigger/m1578r-internal-test-acceptance";

describe("M15.78R bounded Fix Run status readback", () => {
  it("accepts only the fixed readback action without caller-supplied IDs", () => {
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({ action: "read_fix_status" }).success,
    ).toBe(true);
    expect(
      M1578RInternalTestAcceptanceInputSchema.safeParse({
        action: "read_fix_status",
        fixRunId: "caller-controlled",
      }).success,
    ).toBe(false);
  });

  it("returns verification metadata only and drops output or unknown fields", () => {
    expect(
      sanitizeM1578RVerificationChecks([
        {
          commandClass: "targeted_test",
          status: "passed",
          durationMs: 120,
          outputBytes: 42,
          diagnosticCategory: null,
          stdout: "must not be returned",
          secret: "must not be returned",
        },
        { commandClass: "test", status: "invalid", stdout: "ignored" },
        "malformed",
      ]),
    ).toEqual([
      {
        commandClass: "targeted_test",
        status: "passed",
        durationMs: 120,
        outputBytes: 42,
        diagnosticCategory: null,
      },
    ]);
  });
});
