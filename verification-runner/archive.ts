import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createGzip, createGunzip } from "node:zlib";
import { finished } from "node:stream/promises";

const BLOCK = 512;

export type SafeArchiveFile = { path: string; mode: number; sha256: string; bytes: number };

function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, item]) => [key, normalize(item)]),
      );
    return input;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function safeArchivePath(value: string) {
  return (
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes(":") &&
    !/^[a-z]:/i.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    value.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export function isSensitiveArtifactPath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  const basename = normalized.split("/").at(-1)?.toLowerCase() ?? "";
  return (
    /(^|\/)\.env(?:\..*)?$/i.test(normalized) ||
    /(^|\/)(?:secrets?|credentials?)(?:\.[^/]*)?$/i.test(normalized) ||
    /(^|\/)(?:id_rsa|id_ed25519|known_hosts|authorized_keys)$/i.test(normalized) ||
    /\.(?:pem|key|p12|pfx|kdbx|keystore)$/i.test(basename) ||
    basename === ".npmrc"
  );
}

function writeText(target: Buffer, offset: number, length: number, value: string) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > length) throw new Error("verification_archive_path_too_long");
  bytes.copy(target, offset);
}

function octal(target: Buffer, offset: number, length: number, value: number) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("verification_archive_invalid_size");
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  if (encoded.length > length) throw new Error("verification_archive_invalid_size");
  writeText(target, offset, length, encoded);
}

function makeHeader(name: string, size: number, mode: number, directory: boolean) {
  const header = Buffer.alloc(BLOCK);
  let fileName = name;
  let prefix = "";
  if (Buffer.byteLength(fileName) > 100) {
    const splitAt = fileName.lastIndexOf("/");
    if (splitAt <= 0) throw new Error("verification_archive_path_too_long");
    prefix = fileName.slice(0, splitAt);
    fileName = fileName.slice(splitAt + 1);
    if (Buffer.byteLength(prefix) > 155 || Buffer.byteLength(fileName) > 100)
      throw new Error("verification_archive_path_too_long");
  }
  writeText(header, 0, 100, fileName);
  octal(header, 100, 8, mode);
  octal(header, 108, 8, 0);
  octal(header, 116, 8, 0);
  octal(header, 124, 12, directory ? 0 : size);
  octal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = directory ? 0x35 : 0x30;
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  if (prefix) writeText(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  const checksum = sum.toString(8).padStart(6, "0") + "\0 ";
  writeText(header, 148, 8, checksum);
  return header;
}

async function writeChunk(stream: NodeJS.WritableStream, bytes: Buffer) {
  if (!stream.write(bytes))
    await new Promise<void>((resolve, reject) => {
      stream.once("drain", resolve);
      stream.once("error", reject);
    });
}

/** Streams a deterministic ustar+gzip archive; links and special files are rejected. */
export async function packSafeDirectory(
  root: string,
  destination: string,
  limits: { maxFiles: number; maxBytes: number },
) {
  const realRoot = path.resolve(root);
  const gzip = createGzip({ level: 9 });
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  gzip.pipe(output);
  let count = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.toLowerCase() === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      const relative = path.relative(realRoot, absolute).replaceAll("\\", "/");
      if (!safeArchivePath(relative) || stat.isSymbolicLink())
        throw new Error("verification_archive_unsafe_path");
      if (stat.isDirectory()) {
        count += 1;
        if (count > limits.maxFiles) throw new Error("verification_archive_file_limit");
        await writeChunk(gzip, makeHeader(`${relative}/`, 0, 0o555, true));
        await visit(absolute);
      } else if (stat.isFile()) {
        count += 1;
        bytes += stat.size;
        if (count > limits.maxFiles || bytes > limits.maxBytes)
          throw new Error("verification_archive_size_limit");
        const mode = stat.mode & 0o111 ? 0o555 : 0o444;
        await writeChunk(gzip, makeHeader(relative, stat.size, mode, false));
        for await (const chunk of createReadStream(absolute))
          await writeChunk(gzip, Buffer.from(chunk));
        const padding = (BLOCK - (stat.size % BLOCK)) % BLOCK;
        if (padding) await writeChunk(gzip, Buffer.alloc(padding));
      } else {
        throw new Error("verification_archive_special_file");
      }
    }
  };
  try {
    await visit(realRoot);
    await writeChunk(gzip, Buffer.alloc(BLOCK * 2));
    gzip.end();
    await finished(output);
    return { fileCount: count, byteCount: bytes };
  } catch (error) {
    gzip.destroy();
    output.destroy();
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

class TarReader {
  private iterator: AsyncIterator<Buffer>;
  private pending = Buffer.alloc(0);
  constructor(source: NodeJS.ReadableStream) {
    this.iterator = source[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }
  async read(size: number) {
    while (this.pending.byteLength < size) {
      const next = await this.iterator.next();
      if (next.done) throw new Error("verification_archive_truncated");
      this.pending = Buffer.concat([this.pending, Buffer.from(next.value)]);
    }
    const bytes = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return bytes;
  }
}

function readString(header: Buffer, offset: number, length: number) {
  const end = header.indexOf(0, offset);
  return header
    .subarray(offset, end < 0 || end >= offset + length ? offset + length : end)
    .toString("utf8");
}

function readOctal(header: Buffer, offset: number, length: number) {
  const value = header
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/, "")
    .trim();
  if (!/^[0-7]*$/.test(value)) throw new Error("verification_archive_invalid_header");
  const parsed = value ? Number.parseInt(value, 8) : 0;
  if (!Number.isSafeInteger(parsed)) throw new Error("verification_archive_invalid_header");
  return parsed;
}

/** Extracts only regular files/directories and rejects links, traversal, and expansion over budget. */
export async function extractSafeTarGzip(
  archive: string,
  destination: string,
  limits: { maxFiles: number; maxBytes: number; forbidSensitiveFiles?: boolean },
) {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const reader = new TarReader(createReadStream(archive).pipe(createGunzip()));
  let count = 0;
  let bytes = 0;
  const treeFiles: SafeArchiveFile[] = [];
  const entries = new Set<string>();
  while (true) {
    const header = await reader.read(BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const expectedChecksum = readOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (actualChecksum !== expectedChecksum || readString(header, 257, 6) !== "ustar")
      throw new Error("verification_archive_invalid_header");
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const type = String.fromCharCode(header[156] ?? 0);
    const isDirectory = type === "5";
    const rawRelative = prefix ? `${prefix}/${name}` : name;
    const relative = isDirectory ? rawRelative.replace(/\/$/, "") : rawRelative;
    if ((!isDirectory && type !== "0" && type !== "\0") || !safeArchivePath(relative))
      throw new Error("verification_archive_unsafe_entry");
    if (relative.split("/").some((part) => part.toLowerCase() === ".git"))
      throw new Error("verification_archive_git_metadata_forbidden");
    if (limits.forbidSensitiveFiles && isSensitiveArtifactPath(relative))
      throw new Error("verification_archive_secret_file");
    if (entries.has(relative)) throw new Error("verification_archive_duplicate_entry");
    entries.add(relative);
    count += 1;
    if (count > limits.maxFiles) throw new Error("verification_archive_file_limit");
    const target = path.resolve(root, ...relative.split("/"));
    if (!target.startsWith(`${root}${path.sep}`))
      throw new Error("verification_archive_unsafe_entry");
    const mode = readOctal(header, 100, 8);
    if (isDirectory ? mode !== 0o555 : mode !== 0o444 && mode !== 0o555)
      throw new Error("verification_archive_mutable_entry");
    if (isDirectory) {
      if (readOctal(header, 124, 12) !== 0)
        throw new Error("verification_archive_invalid_directory");
      await mkdir(target, { recursive: true, mode: 0o555 });
      await mkdir(path.dirname(target), { recursive: true, mode: 0o555 });
      continue;
    }
    const size = readOctal(header, 124, 12);
    const fileMode = readOctal(header, 100, 8);
    bytes += size;
    if (bytes > limits.maxBytes) throw new Error("verification_archive_size_limit");
    await mkdir(path.dirname(target), { recursive: true, mode: 0o555 });
    const handle = await open(target, "wx", mode & 0o111 ? 0o555 : 0o444);
    const digest = createHash("sha256");
    try {
      let remaining = size;
      while (remaining > 0) {
        const chunk = await reader.read(Math.min(remaining, 1024 * 1024));
        digest.update(chunk);
        await handle.write(chunk);
        remaining -= chunk.byteLength;
      }
    } finally {
      await handle.close();
    }
    treeFiles.push({ path: relative, mode: fileMode, sha256: digest.digest("hex"), bytes: size });
    const padding = (BLOCK - (size % BLOCK)) % BLOCK;
    if (padding) await reader.read(padding);
  }
  return {
    fileCount: count,
    byteCount: bytes,
    treeFiles,
    treeSha256: sha256(canonicalJson(treeFiles)),
  };
}
