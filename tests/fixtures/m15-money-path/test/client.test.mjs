import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("fixture documents the deprecated call without executing customer code", async () => {
  const source = await readFile(new URL("../src/client.ts", import.meta.url), "utf8");
  assert.match(source, /legacyClient\.send\(\)/);
});
