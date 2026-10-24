import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE,
  connectionConfig,
  loadPlan,
  runMigration,
} from "../scripts/supabase-bounded-migration.mjs";

import { fixturePlan } from "./helpers/bounded-migration-fixture";

describe("bounded migration identity", () => {
  it("accepts only exact reviewed bytes and the single approved migration", () => {
    const { dir, plan } = fixturePlan();
    expect(plan.repository.size).toBe(88);
    expect(() => loadPlan(dir, `${CANDIDATE.file},other.sql`)).toThrow(/not_supported/);
    writeFileSync(path.join(dir, CANDIDATE.file), plan.sql + "\n");
    expect(() => loadPlan(dir, CANDIDATE.file)).toThrow(/checksum_mismatch/);
  });
  it("binds the TLS connection to the Auterim pooler and rejects extra startup options", () => {
    const ref = "lnljaacbptrubppoypaz";
    const url = `postgresql://postgres.${ref}:placeholder@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`;
    expect(connectionConfig(url, "secret", ref)).toMatchObject({
      password: "secret",
      ssl: { rejectUnauthorized: true },
    });
    for (const target of [
      url.replace(ref, "another"),
      url.replace(":5432", ":6543"),
      url + "?options=unsafe",
      url.replace(".pooler.supabase.com", ".example.com"),
    ])
      expect(() => connectionConfig(target, "secret", ref)).toThrow(/target_mismatch/);
    expect(() => connectionConfig(url, "secret", "another")).toThrow(/identity/);
  });
  it("refuses changed SQL before touching a connection", async () => {
    const { plan } = fixturePlan();
    const client = {
      query: () => {
        throw Error("must not connect");
      },
    };
    await expect(runMigration(client, { ...plan, sql: plan.sql + " " }, "apply")).rejects.toThrow(
      /invalid_plan/,
    );
  });
});
