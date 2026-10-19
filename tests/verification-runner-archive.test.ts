import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { extractSafeTarGzip, packSafeDirectory } from "../verification-runner/archive";

const roots: string[] = [];

async function makeRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "m1578r-archive-permissions-"));
  roots.push(root);
  return root;
}

function rewriteHeaderChecksum(header: Buffer) {
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
}

function setHeaderName(header: Buffer, value: string) {
  header.fill(0, 0, 100);
  Buffer.from(value, "utf8").copy(header, 0);
  rewriteHeaderChecksum(header);
}

function setHeaderSize(header: Buffer, size: number) {
  header.fill(0, 124, 136);
  Buffer.from(size.toString(8).padStart(11, "0") + "\0", "ascii").copy(header, 124);
  rewriteHeaderChecksum(header);
}

function entryPayloadLength(tar: Buffer, offset: number) {
  const size = Number.parseInt(
    tar
      .subarray(offset + 124, offset + 136)
      .toString("ascii")
      .trim(),
    8,
  );
  return Math.ceil(size / 512) * 512;
}

async function writeFixtureArchive(root: string, files: Record<string, string>) {
  const source = path.join(root, "source");
  await mkdir(source, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(source, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  const archive = path.join(root, "fixture.tar.gz");
  await packSafeDirectory(source, archive, { maxFiles: 100, maxBytes: 1024 * 1024 });
  return { archive, source };
}

async function makeWritable(root: string) {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else await chmod(target, 0o600);
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await makeWritable(root).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("verification runner archive extraction permissions", () => {
  it("extracts a nested QA snapshot and restores immutable file and directory modes", async () => {
    const root = await makeRoot();
    const { archive } = await writeFixtureArchive(root, {
      "package.json": '{"name":"qa-fixture","private":true}\n',
      "package-lock.json": '{"name":"qa-fixture","lockfileVersion":3}\n',
      "src/endpoint.js": 'export const endpoint = "/v1/old";\n',
      "test/endpoint.test.js": 'test("endpoint fixture", () => {});\n',
    });
    const destination = path.join(root, "extracted");
    const result = await extractSafeTarGzip(archive, destination, {
      maxFiles: 100,
      maxBytes: 1024 * 1024,
      forbidSensitiveFiles: true,
    });

    expect(result.treeFiles.map((entry) => entry.path)).toEqual([
      "package-lock.json",
      "package.json",
      "src/endpoint.js",
      "test/endpoint.test.js",
    ]);
    expect(await readFile(path.join(destination, "src/endpoint.js"), "utf8")).toContain(
      '"/v1/old"',
    );
    if (process.platform !== "win32") {
      expect((await stat(path.join(destination, "src"))).mode & 0o777).toBe(0o555);
      expect((await stat(path.join(destination, "test"))).mode & 0o777).toBe(0o555);
      expect((await stat(path.join(destination, "src/endpoint.js"))).mode & 0o777).toBe(0o444);
    }
  });

  it("rejects traversal and symbolic-link entries without writing outside the destination", async () => {
    const root = await makeRoot();
    const { archive } = await writeFixtureArchive(root, { "safe.txt": "safe\n" });
    const tar = gunzipSync(await readFile(archive));
    const traversal = Buffer.from(tar);
    setHeaderName(traversal.subarray(0, 512), "../escape.txt");
    const traversalArchive = path.join(root, "traversal.tar.gz");
    await writeFile(traversalArchive, gzipSync(traversal));
    await expect(
      extractSafeTarGzip(traversalArchive, path.join(root, "traversal-out"), {
        maxFiles: 10,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("verification_archive_unsafe_entry");
    await expect(readFile(path.join(root, "escape.txt"))).rejects.toMatchObject({ code: "ENOENT" });

    const symlink = Buffer.from(tar);
    symlink[156] = 0x32;
    rewriteHeaderChecksum(symlink.subarray(0, 512));
    const symlinkArchive = path.join(root, "symlink.tar.gz");
    await writeFile(symlinkArchive, gzipSync(symlink));
    await expect(
      extractSafeTarGzip(symlinkArchive, path.join(root, "symlink-out"), {
        maxFiles: 10,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("verification_archive_unsafe_entry");
  });

  it("rejects duplicate entries and forbidden secret paths", async () => {
    const root = await makeRoot();
    const { archive } = await writeFixtureArchive(root, { "safe.txt": "safe\n" });
    const tar = gunzipSync(await readFile(archive));
    const firstEntryLength = 512 + entryPayloadLength(tar, 0);
    const duplicateTar = Buffer.concat([
      tar.subarray(0, firstEntryLength),
      tar.subarray(0, firstEntryLength),
      tar.subarray(firstEntryLength),
    ]);
    const duplicateArchive = path.join(root, "duplicate.tar.gz");
    await writeFile(duplicateArchive, gzipSync(duplicateTar));
    const duplicateOut = path.join(root, "duplicate-out");
    await expect(
      extractSafeTarGzip(duplicateArchive, duplicateOut, { maxFiles: 10, maxBytes: 1024 }),
    ).rejects.toThrow("verification_archive_duplicate_entry");
    expect(await readdir(duplicateOut)).toEqual([]);

    const secretTar = Buffer.from(tar);
    setHeaderName(secretTar.subarray(0, 512), ".env");
    const secretArchive = path.join(root, "secret.tar.gz");
    await writeFile(secretArchive, gzipSync(secretTar));
    await expect(
      extractSafeTarGzip(secretArchive, path.join(root, "secret-out"), {
        maxFiles: 10,
        maxBytes: 1024,
        forbidSensitiveFiles: true,
      }),
    ).rejects.toThrow("verification_archive_secret_file");
  });

  it("rejects truncated and invalid gzip archives and cleans partial extraction", async () => {
    const root = await makeRoot();
    const { archive } = await writeFixtureArchive(root, {
      "a-first.txt": "first\n",
      "z-second.txt": "second\n",
    });
    const tar = gunzipSync(await readFile(archive));
    const firstEntryLength = 512 + entryPayloadLength(tar, 0);
    const traversalTar = Buffer.from(tar);
    setHeaderName(traversalTar.subarray(firstEntryLength, firstEntryLength + 512), "../late.txt");
    const partialFailureArchive = path.join(root, "partial-failure.tar.gz");
    await writeFile(partialFailureArchive, gzipSync(traversalTar));
    const partialDestination = path.join(root, "partial-out");
    await expect(
      extractSafeTarGzip(partialFailureArchive, partialDestination, {
        maxFiles: 10,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("verification_archive_unsafe_entry");
    expect(await readdir(partialDestination)).toEqual([]);

    const truncated = path.join(root, "truncated.tar.gz");
    const truncatedTar = Buffer.from(tar.subarray(0, firstEntryLength));
    setHeaderSize(truncatedTar.subarray(0, 512), 1024);
    await writeFile(truncated, gzipSync(truncatedTar));
    await expect(
      extractSafeTarGzip(truncated, path.join(root, "truncated-out"), {
        maxFiles: 10,
        maxBytes: 2048,
      }),
    ).rejects.toThrow("verification_archive_truncated");

    const invalid = path.join(root, "invalid.tar.gz");
    await writeFile(invalid, Buffer.from("not a gzip archive"));
    await expect(
      extractSafeTarGzip(invalid, path.join(root, "invalid-out"), {
        maxFiles: 10,
        maxBytes: 1024,
      }),
    ).rejects.toThrow();
  });
});
