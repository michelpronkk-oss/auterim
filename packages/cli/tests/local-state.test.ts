import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalProjectState, markLocalScanSuccessful } from "../src/local-state.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

describe("local project state", () => {
  it("recognizes repeat scans without persisting the path or a Product association", async () => {
    const root = await tempDirectory("auterim-project-root-");
    const configDirectory = await tempDirectory("auterim-config-");
    const first = await loadLocalProjectState(root, {
      configDirectory,
      now: new Date("2026-10-08T10:00:00.000Z"),
    });
    const repeated = await loadLocalProjectState(root, { configDirectory });
    const updated = await markLocalScanSuccessful(root, new Date("2026-10-08T11:00:00.000Z"), {
      configDirectory,
    });
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(configDirectory));
    const persisted = await readFile(join(configDirectory, files[0]!), "utf8");

    expect(repeated.localProjectId).toBe(first.localProjectId);
    expect(updated.lastSuccessfulScanAt).toBe("2026-10-08T11:00:00.000Z");
    expect(files).toHaveLength(1);
    expect(persisted).not.toContain(root);
    expect(persisted).not.toContain("product");
    expect(Object.keys(JSON.parse(persisted)).sort()).toEqual([
      "createdAt",
      "formatVersion",
      "lastSuccessfulScanAt",
      "localProjectId",
    ]);
  });

  it("regenerates malformed bounded local state", async () => {
    const root = await tempDirectory("auterim-project-root-");
    const configDirectory = await tempDirectory("auterim-config-");
    const { readdir, writeFile } = await import("node:fs/promises");
    const first = await loadLocalProjectState(root, { configDirectory });
    const file = join(configDirectory, (await readdir(configDirectory))[0]!);
    await writeFile(file, JSON.stringify({ formatVersion: 99, credential: "must-not-persist" }));
    const regenerated = await loadLocalProjectState(root, { configDirectory });
    const persisted = await readFile(file, "utf8");
    expect(regenerated.localProjectId).not.toBe(first.localProjectId);
    expect(persisted).not.toContain("credential");
  });
});
