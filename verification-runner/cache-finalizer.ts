import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { packSafeDirectory } from "./archive.ts";
const MAX_ARCHIVE_FILES = 50_000;
const MAX_ARCHIVE_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_CACHE_ARCHIVE_BYTES = 512 * 1024 * 1024;
const canonicalJson = (value: unknown) => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
};
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

const MAX_FILES = MAX_ARCHIVE_FILES;
const MAX_BYTES = MAX_ARCHIVE_EXPANDED_BYTES;

async function removeBinLinks(root: string, current = root): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name);
    if (entry.name === ".bin") {
      await rm(target, { recursive: true, force: true });
      continue;
    }
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("dependency_cache_symlink_layout_unsupported");
    if (info.isDirectory()) await removeBinLinks(root, target);
  }
}

async function makeImmutable(root: string, current = root) {
  const files: Array<{ path: string; mode: number; sha256: string; bytes: number }> = [];
  let bytes = 0;
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const target = path.join(current, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("dependency_cache_symlink_layout_unsupported");
    if (info.isDirectory()) {
      const child = await makeImmutable(root, target);
      files.push(...child.files);
      bytes += child.bytes;
      await chmod(target, 0o555);
    } else if (info.isFile()) {
      bytes += info.size;
      const mode = info.mode & 0o111 ? 0o555 : 0o444;
      await chmod(target, mode);
      files.push({
        path: path.relative(root, target).replaceAll("\\", "/"),
        mode,
        sha256: sha256(await readFile(target)),
        bytes: info.size,
      });
    } else throw new Error("dependency_cache_special_file_unsupported");
    if (files.length > MAX_FILES || bytes > MAX_BYTES)
      throw new Error("dependency_cache_size_limit");
  }
  if (current === root) await chmod(root, 0o555);
  return { files, bytes, treeSha256: sha256(canonicalJson(files)) };
}

export async function finalizeNpmDependencyTree(nodeModulesPath: string, outputDirectory: string) {
  const nodeModules = path.resolve(nodeModulesPath);
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await removeBinLinks(nodeModules);
  const tree = await makeImmutable(nodeModules);
  const archivePath = path.join(output, "dependencies.tar.gz");
  const archiveInfo = await packSafeDirectory(nodeModules, archivePath, {
    maxFiles: MAX_FILES,
    maxBytes: MAX_BYTES,
  });
  const archive = await readFile(archivePath);
  if (archive.byteLength > MAX_CACHE_ARCHIVE_BYTES || archiveInfo.byteCount !== tree.bytes)
    throw new Error("dependency_cache_archive_invalid");
  const metadata = {
    treeSha256: tree.treeSha256,
    fileCount: tree.files.length,
    byteCount: tree.bytes,
    archiveSha256: sha256(archive),
    archiveByteCount: archive.byteLength,
  };
  await writeFile(path.join(output, "tree.json"), canonicalJson(metadata), {
    flag: "wx",
    mode: 0o400,
  });
  return metadata;
}

const [nodeModulesPath, outputDirectory] = process.argv.slice(2);
if (nodeModulesPath && outputDirectory)
  await finalizeNpmDependencyTree(nodeModulesPath, outputDirectory);
