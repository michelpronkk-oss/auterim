import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20261220000000_m1578r_patch_attempt2_verification_recovery.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("M15.78R bounded verification recovery migration", () => {
  it("requires and persists the exact already-applied second patch attempt", () => {
    expect(migration).toContain(
      "add column patch_attempt_number smallint not null check (patch_attempt_number = 2)",
    );
    expect(migration).toContain("and p.attempt_number = 2");
    expect(migration).toContain("patch_id, patch_fingerprint, patch_attempt_number");
    expect(migration).toContain("v_patch.id, v_patch.patch_fingerprint, v_patch.attempt_number");
    expect(migration).not.toContain("p.attempt_number = 1");
  });

  it("keeps the one-generation failed-stage and exact patch identity guards", () => {
    expect(migration).toContain("v_stage.attempt_count <> 1");
    expect(migration).toContain("v_stage.operator_retry_count <> 0");
    expect(migration).toContain(
      "v_stage.failure_category is distinct from 'verification_cache_artifact_unavailable'",
    );
    expect(migration).toContain(
      "p.patch_fingerprint = 'c7e9cfc34baa27a69cbd724877bb549a21e8188fcd29cc5b3399fb5cac2b3ece'",
    );
    expect(migration).toContain("p.status = 'applied'");
  });
});
