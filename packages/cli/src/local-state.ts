import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const maximumStateBytes = 4_096;

export type LocalProjectState = {
  formatVersion: 1;
  localProjectId: string;
  createdAt: string;
  lastSuccessfulScanAt: string | null;
};

function defaultConfigDirectory() {
  if (process.platform === "win32")
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Auterim");
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Auterim");
  const configured = process.env.XDG_CONFIG_HOME;
  return join(
    configured && isAbsolute(configured) ? configured : join(homedir(), ".config"),
    "auterim",
  );
}

function statePath(root: string, configDirectory: string) {
  const localKey = createHash("sha256").update(resolve(root)).digest("hex");
  return join(configDirectory, `${localKey}.json`);
}

function parseState(value: unknown): LocalProjectState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        !["formatVersion", "localProjectId", "createdAt", "lastSuccessfulScanAt"].includes(key),
    ) ||
    record.formatVersion !== 1 ||
    typeof record.localProjectId !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(record.localProjectId) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    (record.lastSuccessfulScanAt !== null &&
      (typeof record.lastSuccessfulScanAt !== "string" ||
        !Number.isFinite(Date.parse(record.lastSuccessfulScanAt))))
  )
    return null;
  return record as LocalProjectState;
}

async function writeState(path: string, state: LocalProjectState) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(state), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function loadLocalProjectState(
  root: string,
  options: { configDirectory?: string; now?: Date } = {},
): Promise<LocalProjectState> {
  const path = statePath(root, options.configDirectory ?? defaultConfigDirectory());
  let state: LocalProjectState | null = null;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maximumStateBytes)
      throw new Error("invalid_state");
    state = parseState(JSON.parse(await readFile(path, "utf8")));
  } catch {
    state = null;
  }
  if (!state) {
    state = {
      formatVersion: 1,
      localProjectId: randomUUID(),
      createdAt: (options.now ?? new Date()).toISOString(),
      lastSuccessfulScanAt: null,
    };
    await writeState(path, state);
  }
  return state;
}

export async function markLocalScanSuccessful(
  root: string,
  scannedAt = new Date(),
  options: { configDirectory?: string } = {},
) {
  const directory = options.configDirectory ?? defaultConfigDirectory();
  const current = await loadLocalProjectState(root, { configDirectory: directory });
  const updated = { ...current, lastSuccessfulScanAt: scannedAt.toISOString() };
  await writeState(statePath(root, directory), updated);
  return updated;
}

export function localStateSummary(state: LocalProjectState) {
  return {
    recognized: true as const,
    lastSuccessfulScanAt: state.lastSuccessfulScanAt,
  };
}
