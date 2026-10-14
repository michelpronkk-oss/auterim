import { describe, expect, it } from "vitest";
import {
  M157_FIXED_TARGET,
  m157ChildEnvironment,
  rejectM157TargetOverrides,
} from "../scripts/m157-deployment-acceptance.ts";

describe("M15.7 fixed-target deployment acceptance runner", () => {
  it("pins every customer and provider target without accepting an override object", () => {
    expect(M157_FIXED_TARGET).toEqual({
      workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
      productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
      installationId: "43dfb9e9-787e-4818-b72e-d9616704f6b5",
      resourceId: "348b9342-b779-4668-9ab0-f42245cdcd49",
      externalProjectId: "prj_fENIbPMtNzudgAnLv4xsjqSOw8PK",
      teamId: "team_tM3JXep1ZWAuR2rAcvuTtXAf",
      supabaseProjectRef: "lnljaacbptrubppoypaz",
      repositoryOwner: "michelpronkk-oss",
      repositoryName: "auterim",
      initialReleaseSha: "b08510b852fe89a1df5438be9fd245d48c9a8dbd",
      initialBaselineEvidenceId: "598af30d-c1ab-4081-a67b-0b0980f92dfa",
      initialBaselineRunId: "ad81490d-1a6e-4d5f-8f78-9a9b3f633c4c",
    });
    expect(Object.isFrozen(M157_FIXED_TARGET)).toBe(true);
    expect(() => rejectM157TargetOverrides([])).not.toThrow();
    for (const option of [
      "--workspace",
      "--product",
      "--installation",
      "--resource",
      "--project",
      "--sha",
    ]) {
      expect(() => rejectM157TargetOverrides([option, "other"])).toThrow(
        "m157_cli_target_overrides_not_supported",
      );
    }
  });

  it("passes only the exact acceptance environment to the test child", () => {
    const child = m157ChildEnvironment({
      NEXT_PUBLIC_SUPABASE_URL: "https://lnljaacbptrubppoypaz.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "public-fixture",
      SUPABASE_SECRET_KEY: "server-fixture",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-fixture",
      CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS: "keyring-fixture",
      CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION: "1",
      VERCEL_CLIENT_SECRET: "must-not-forward",
      DODO_PAYMENTS_API_KEY: "must-not-forward",
      SLACK_CLIENT_SECRET: "must-not-forward",
      AUTERIM_M157_DEPLOYMENT_ACCEPTANCE: "must-not-forward",
    });

    expect(Object.keys(child).sort()).toEqual(
      [
        "AUTERIM_M157_DEPLOYMENT_ACCEPTANCE",
        "CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION",
        "CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS",
        "GITHUB_APP_ID",
        "GITHUB_APP_PRIVATE_KEY",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "NEXT_PUBLIC_SUPABASE_URL",
        "NODE_ENV",
        "SUPABASE_SECRET_KEY",
      ].sort(),
    );
    expect(child.AUTERIM_M157_DEPLOYMENT_ACCEPTANCE).toBe("1");
    expect(child.VERCEL_CLIENT_SECRET).toBeUndefined();
    expect(child.DODO_PAYMENTS_API_KEY).toBeUndefined();
  });
});
