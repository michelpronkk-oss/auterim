import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  resolveEnvironmentProvider,
  resolveModelProvider,
  resolvePackageProvider,
  resolveProviderHost,
} from "./provider-registry.js";
import {
  DISCOVERY_REGISTRY_VERSION,
  DISCOVERY_SCANNER_VERSION,
  DISCOVERY_SCHEMA_VERSION,
  type DiscoveryObservation,
  type GitProjectIdentity,
  type SafeEvidenceMetadata,
  type ScanProjectOptions,
  type ScanResult,
} from "./types.js";

const LIMITS = {
  maxDepth: 8,
  maxDirectories: 600,
  maxFiles: 4_000,
  maxManifestBytes: 256 * 1024,
  maxTotalManifestBytes: 1_500 * 1024,
  maxEnvironmentFileBytes: 128 * 1024,
  maxTotalEnvironmentBytes: 256 * 1024,
  maxSourceFileBytes: 256 * 1024,
  maxTotalSourceBytes: 2 * 1024 * 1024,
  maxSourceFiles: 600,
  maxTotalBytes: 4 * 1024 * 1024,
  maxObservations: 1_500,
  maxDurationMs: 8_000,
  maxGitMetadataBytes: 48 * 1024,
} as const;

const ignoredDirectories = new Set([
  ".cache",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "__pycache__",
  ".venv",
  "venv",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "target",
  "coverage",
  "out",
  ".ssh",
  ".gnupg",
  ".aws",
  "secrets",
  "credentials",
  "certificates",
  "certs",
  "private",
]);
const sensitiveDirectories = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  "secrets",
  "credentials",
  "certificates",
  "certs",
  "private",
]);

const packageJsonNames = new Set(["package.json", "composer.json"]);
const textManifestNames = new Set(["requirements.txt", "pyproject.toml", "go.mod", "Cargo.toml"]);
const lockfileNames = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);
const sourceExtensions = new Set([
  ".cjs",
  ".go",
  ".js",
  ".jsx",
  ".mjs",
  ".py",
  ".rs",
  ".ts",
  ".tsx",
]);
const sensitiveFileNames = new Set([
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "service-account.json",
]);
const sensitiveFileExtensions = new Set([
  ".cer",
  ".crt",
  ".der",
  ".jks",
  ".key",
  ".keystore",
  ".p12",
  ".pfx",
  ".pem",
]);

type ScanState = {
  root: string;
  signal?: AbortSignal;
  startedAt: number;
  filesVisited: number;
  directoriesVisited: number;
  manifestsParsed: number;
  symlinksSkipped: number;
  totalManifestBytes: number;
  totalEnvironmentBytes: number;
  totalSourceBytes: number;
  totalBytesRead: number;
  sourceFilesInspected: number;
  ignoredDirectories: number;
  ignoredSensitiveFiles: number;
  ignoredSensitiveDirectories: number;
  truncated: boolean;
  partialReasons: Set<ScanResult["stats"]["partialReasons"][number]>;
  observations: Map<string, DiscoveryObservation>;
};

function markPartial(state: ScanState, reason: ScanResult["stats"]["partialReasons"][number]) {
  state.truncated = true;
  state.partialReasons.add(reason);
}

function withinRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function safeSegment(value: string, maximum = 100): string | null {
  if (!/^[A-Za-z0-9_.-]+$/.test(value) || value === "." || value === "..") return null;
  return value.slice(0, maximum);
}

function safeRelativePath(root: string, absolutePath: string): string | null {
  const relative = path.relative(root, absolutePath).split(path.sep).join("/");
  if (!relative || relative.startsWith("/") || relative.split("/").some((part) => part === ".."))
    return null;
  if (relative.length > 240 || !/^[A-Za-z0-9_./@ -]+$/.test(relative)) return null;
  return relative;
}

function safeSubproject(relativePath: string | null) {
  if (!relativePath) return null;
  const directory = path.posix.dirname(relativePath);
  if (directory === ".") return null;
  return directory.length <= 180 ? directory : null;
}

function observationId(
  family: string,
  identifier: string,
  relativePath: string | null,
  scope: string,
) {
  return createHash("sha256")
    .update(`${family}\0${identifier}\0${relativePath ?? ""}\0${scope}`)
    .digest("hex")
    .slice(0, 32);
}

function addObservation(state: ScanState, observation: DiscoveryObservation) {
  if (state.observations.size >= LIMITS.maxObservations) {
    markPartial(state, "max_observations");
    return;
  }
  state.observations.set(observation.id, observation);
}

function elapsed(state: ScanState) {
  return Date.now() - state.startedAt;
}

function shouldStop(state: ScanState) {
  if (state.signal?.aborted) {
    markPartial(state, "cancelled");
    return true;
  }
  if (elapsed(state) >= LIMITS.maxDurationMs) {
    markPartial(state, "deadline");
    return true;
  }
  if (state.filesVisited >= LIMITS.maxFiles) markPartial(state, "max_files");
  if (state.directoriesVisited >= LIMITS.maxDirectories) markPartial(state, "max_directories");
  if (state.observations.size >= LIMITS.maxObservations) markPartial(state, "max_observations");
  if (state.sourceFilesInspected >= LIMITS.maxSourceFiles) markPartial(state, "max_files");
  if (
    state.totalBytesRead >= LIMITS.maxTotalBytes ||
    state.totalSourceBytes >= LIMITS.maxTotalSourceBytes
  )
    markPartial(state, "max_total_bytes");
  if (
    state.filesVisited >= LIMITS.maxFiles ||
    state.directoriesVisited >= LIMITS.maxDirectories ||
    state.observations.size >= LIMITS.maxObservations ||
    state.sourceFilesInspected >= LIMITS.maxSourceFiles ||
    state.totalBytesRead >= LIMITS.maxTotalBytes ||
    state.totalSourceBytes >= LIMITS.maxTotalSourceBytes
  )
    return true;
  return false;
}

async function safeReadText(state: ScanState, absolutePath: string, maxBytes: number) {
  try {
    const before = await lstat(absolutePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      if (before.size > maxBytes) markPartial(state, "file_too_large");
      return null;
    }
    if (state.totalBytesRead + before.size > LIMITS.maxTotalBytes) {
      markPartial(state, "max_total_bytes");
      return null;
    }
    const resolved = await realpath(absolutePath);
    if (!withinRoot(state.root, resolved)) return null;
    const flags =
      constants.O_RDONLY |
      ((constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
    const handle = await open(absolutePath, flags);
    try {
      const openedPath = await realpath(absolutePath);
      if (!withinRoot(state.root, openedPath)) return null;
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > maxBytes) {
        if (opened.size > maxBytes) markPartial(state, "file_too_large");
        return null;
      }
      // Read through the opened handle into a fixed-size buffer. A prior stat is
      // only advisory: another process could grow the file after the size check.
      const buffer = Buffer.alloc(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.byteLength) {
        const result = await handle.read(
          buffer,
          bytesRead,
          buffer.byteLength - bytesRead,
          bytesRead,
        );
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > maxBytes) {
        markPartial(state, "file_too_large");
        return null;
      }
      if (state.totalBytesRead + bytesRead > LIMITS.maxTotalBytes) {
        markPartial(state, "max_total_bytes");
        return null;
      }
      state.totalBytesRead += bytesRead;
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    markPartial(state, "read_error");
    return null;
  }
}

function normalizedPackageName(input: string) {
  const name = input.trim().toLowerCase();
  if (name.length > 180 || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(name)) return null;
  return name;
}

function packageRootFromImport(input: string) {
  if (!input || input.startsWith(".") || input.startsWith("/") || input.startsWith("node:"))
    return null;
  const parts = input.split("/");
  const root = input.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  return normalizedPackageName(root ?? "");
}

function safeVersion(input: unknown) {
  if (typeof input !== "string") return undefined;
  const version = input.trim();
  if (version.length > 80 || !/^[0-9a-zA-Z*^~<>=|.,+ _-]+$/.test(version)) return undefined;
  return version;
}

function packageObservation(input: {
  state: ScanState;
  name: string;
  version?: unknown;
  ecosystem: SafeEvidenceMetadata["ecosystem"];
  manifestKind: SafeEvidenceMetadata["manifestKind"];
  scope: SafeEvidenceMetadata["dependencyScope"];
  absolutePath: string;
}) {
  const normalizedIdentifier =
    input.ecosystem === "go" ? input.name.toLowerCase().trim() : normalizedPackageName(input.name);
  if (
    !normalizedIdentifier ||
    (input.ecosystem === "go" &&
      (normalizedIdentifier.length > 180 ||
        !/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9._-]+){1,8}$/.test(normalizedIdentifier) ||
        normalizedIdentifier.split("/").some((part) => part === "." || part === "..")))
  )
    return;
  const providerCandidate = resolvePackageProvider(normalizedIdentifier);
  const relativePath = safeRelativePath(input.state.root, input.absolutePath);
  const declaredVersion = safeVersion(input.version);
  const metadata: SafeEvidenceMetadata = {
    ecosystem: input.ecosystem,
    manifestKind: input.manifestKind,
    dependencyScope: input.scope,
    ...(declaredVersion ? { declaredVersion } : {}),
  };
  const scopeKey = input.scope ?? "unknown";
  addObservation(input.state, {
    id: observationId("package_manifest", normalizedIdentifier, relativePath, scopeKey),
    evidenceFamily: "package_manifest",
    normalizedIdentifier,
    providerCandidate,
    confidence: providerCandidate.status === "known" ? 0.92 : 0.35,
    reasonCode:
      providerCandidate.status === "known" ? "known_package_provider" : "unmapped_package",
    safeRelativePath: relativePath,
    subproject: safeSubproject(relativePath),
    metadata,
  });
  const framework = frameworkPackages[normalizedIdentifier];
  if (framework) {
    addObservation(input.state, {
      id: observationId("framework_runtime", normalizedIdentifier, relativePath, scopeKey),
      evidenceFamily: "framework_runtime",
      normalizedIdentifier,
      providerCandidate: { status: "unknown", providerSlug: null, providerName: null },
      confidence: 0.96,
      reasonCode: "framework_package",
      safeRelativePath: relativePath,
      subproject: safeSubproject(relativePath),
      metadata: {
        ecosystem: input.ecosystem,
        manifestKind: input.manifestKind,
        dependencyScope: input.scope,
        runtimeName: framework.runtime,
        configKind: framework.kind,
      },
    });
  }
}

const frameworkPackages: Record<
  string,
  {
    runtime: NonNullable<SafeEvidenceMetadata["runtimeName"]>;
    kind: NonNullable<SafeEvidenceMetadata["configKind"]>;
  }
> = {
  astro: { runtime: "node", kind: "astro" },
  express: { runtime: "node", kind: "other" },
  fastify: { runtime: "node", kind: "other" },
  next: { runtime: "node", kind: "next" },
  nuxt: { runtime: "node", kind: "nuxt" },
  react: { runtime: "node", kind: "other" },
  "react-dom": { runtime: "node", kind: "other" },
  svelte: { runtime: "node", kind: "svelte" },
  "@sveltejs/kit": { runtime: "node", kind: "svelte" },
  vite: { runtime: "node", kind: "vite" },
  vue: { runtime: "node", kind: "other" },
};

function recordPackageJson(
  state: ScanState,
  absolutePath: string,
  text: string,
  fileName: "package.json" | "composer.json",
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    markPartial(state, "malformed_manifest");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const object = parsed as Record<string, unknown>;
  const ecosystem = fileName === "package.json" ? "npm" : "composer";
  for (const [field, scope] of [
    ["dependencies", "production"],
    ["require", "production"],
    ["require-dev", "development"],
    ["optionalDependencies", "optional"],
    ["devDependencies", "development"],
  ] as const) {
    const dependencies = object[field];
    if (dependencies === undefined) continue;
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      markPartial(state, "malformed_manifest");
      continue;
    }
    for (const [name, version] of Object.entries(dependencies as Record<string, unknown>)) {
      packageObservation({
        state,
        name,
        version,
        ecosystem,
        manifestKind: fileName,
        scope,
        absolutePath,
      });
    }
  }
}

function recordRequirements(state: ScanState, absolutePath: string, text: string) {
  for (const line of text.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#") || entry.startsWith("-") || entry.startsWith(".")) continue;
    const match =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9_,.-]+\])?(?:\s*(?:===|==|~=|!=|<=|>=|<|>)\s*([^;\s]+))?(?:\s*;.*)?$/.exec(
        entry,
      );
    if (!match) {
      markPartial(state, "malformed_manifest");
      continue;
    }
    packageObservation({
      state,
      name: match[1]!,
      version: match[2],
      ecosystem: "python",
      manifestKind: "requirements.txt",
      scope: "production",
      absolutePath,
    });
  }
}

function recordGoMod(state: ScanState, absolutePath: string, text: string) {
  let inRequireBlock = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;
    if (/^require\s*\($/.test(trimmed)) {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && trimmed === ")") {
      inRequireBlock = false;
      continue;
    }
    const candidate = inRequireBlock ? trimmed : trimmed.replace(/^require\s+/, "");
    if (!inRequireBlock && !trimmed.startsWith("require ")) continue;
    const match =
      /^([A-Za-z0-9][A-Za-z0-9._/-]{0,179})\s+(v?[0-9][A-Za-z0-9.+-]{0,79})(?:\s+\/\/.*)?$/.exec(
        candidate,
      );
    if (!match || match[1]!.includes("..")) {
      if (inRequireBlock || trimmed.startsWith("require "))
        markPartial(state, "malformed_manifest");
      continue;
    }
    packageObservation({
      state,
      name: match[1]!,
      version: match[2],
      ecosystem: "go",
      manifestKind: "go.mod",
      scope: "production",
      absolutePath,
    });
  }
}

function recordCargo(state: ScanState, absolutePath: string, text: string) {
  let scope: SafeEvidenceMetadata["dependencyScope"] = "unknown";
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[(?:workspace\.)?dependencies\]$/.test(trimmed)) {
      scope = "production";
      continue;
    }
    if (/^\[(?:dev-dependencies|workspace\.dev-dependencies)\]$/.test(trimmed)) {
      scope = "development";
      continue;
    }
    if (/^\[(?:build-dependencies|workspace\.build-dependencies)\]$/.test(trimmed)) {
      scope = "build";
      continue;
    }
    if (trimmed.startsWith("[")) {
      scope = "unknown";
      continue;
    }
    if (scope === "unknown" || !trimmed || trimmed.startsWith("#")) continue;
    const match =
      /^([A-Za-z0-9_-]{1,100})\s*=\s*(?:"([^"]{1,80})"|\{[^}]{0,300}?version\s*=\s*"([^"]{1,80})")/.exec(
        trimmed,
      );
    if (!match) {
      if (trimmed.includes("=")) markPartial(state, "malformed_manifest");
      continue;
    }
    packageObservation({
      state,
      name: match[1]!,
      version: match[2] ?? match[3],
      ecosystem: "cargo",
      manifestKind: "Cargo.toml",
      scope,
      absolutePath,
    });
  }
}

function recordPyproject(state: ScanState, absolutePath: string, text: string) {
  let inDependencies = false;
  let inOptionalDependencies = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (/^\[(project|tool\.poetry\.dependencies)\]$/.test(trimmed)) {
      inDependencies = true;
      inOptionalDependencies = false;
      continue;
    }
    if (/^\[project\.optional-dependencies\]$/.test(trimmed)) {
      inDependencies = true;
      inOptionalDependencies = true;
      continue;
    }
    if (trimmed.startsWith("[")) {
      inDependencies = false;
      inOptionalDependencies = false;
      continue;
    }
    if (!inDependencies || !trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\s*=\s*["']([^"']{0,80})["']/.exec(trimmed);
    if (!match) {
      if (trimmed.includes("=")) markPartial(state, "malformed_manifest");
      continue;
    }
    if (match[1]!.toLowerCase() === "python") continue;
    packageObservation({
      state,
      name: match[1]!,
      version: match[2],
      ecosystem: "python",
      manifestKind: "pyproject.toml",
      scope: inOptionalDependencies ? "optional" : "production",
      absolutePath,
    });
  }
}

function simpleObservation(input: {
  state: ScanState;
  family: DiscoveryObservation["evidenceFamily"];
  identifier: string;
  candidate: DiscoveryObservation["providerCandidate"];
  confidence: number;
  reasonCode: DiscoveryObservation["reasonCode"];
  absolutePath?: string;
  scope?: string;
  metadata?: SafeEvidenceMetadata;
}) {
  const relativePath = input.absolutePath
    ? safeRelativePath(input.state.root, input.absolutePath)
    : null;
  addObservation(input.state, {
    id: observationId(input.family, input.identifier, relativePath, input.scope ?? ""),
    evidenceFamily: input.family,
    normalizedIdentifier: input.identifier,
    providerCandidate: input.candidate,
    confidence: input.confidence,
    reasonCode: input.reasonCode,
    safeRelativePath: relativePath,
    subproject: safeSubproject(relativePath),
    metadata: input.metadata ?? {},
  });
}

function recordLockfileIdentity(state: ScanState, absolutePath: string, fileName: string) {
  const ecosystem =
    fileName === "package-lock.json" ||
    fileName === "pnpm-lock.yaml" ||
    fileName === "yarn.lock" ||
    fileName === "bun.lock" ||
    fileName === "bun.lockb"
      ? "npm"
      : fileName === "requirements.txt" ||
          fileName === "pipfile.lock" ||
          fileName === "poetry.lock" ||
          fileName === "uv.lock"
        ? "python"
        : fileName === "go.sum"
          ? "go"
          : fileName === "cargo.lock"
            ? "cargo"
            : fileName === "composer.lock"
              ? "composer"
              : "unknown";
  simpleObservation({
    state,
    family: "lockfile_identity",
    identifier: fileName,
    candidate: { status: "unknown", providerSlug: null, providerName: null },
    confidence: 1,
    reasonCode: "lockfile_identity",
    absolutePath,
    metadata: { ecosystem },
  });
}

function configFileInfo(name: string): {
  kind: NonNullable<SafeEvidenceMetadata["configKind"]>;
  provider?: DiscoveryObservation["providerCandidate"];
} | null {
  if (/^next\.config\.(?:js|cjs|mjs|ts)$/.test(name)) return { kind: "next" };
  if (/^vite\.config\.(?:js|cjs|mjs|ts)$/.test(name)) return { kind: "vite" };
  if (/^nuxt\.config\.(?:js|cjs|mjs|ts)$/.test(name)) return { kind: "nuxt" };
  if (/^(?:svelte\.config\.(?:js|cjs|mjs|ts)|svelte\.config\.js)$/.test(name))
    return { kind: "svelte" };
  if (/^astro\.config\.(?:js|cjs|mjs|ts)$/.test(name)) return { kind: "astro" };
  if (name === "vercel.json")
    return {
      kind: "vercel",
      provider: { status: "known", providerSlug: "vercel", providerName: "Vercel" },
    };
  if (name === "sentry.properties" || /^\.sentryclirc$/.test(name))
    return {
      kind: "sentry",
      provider: { status: "known", providerSlug: "sentry", providerName: "Sentry" },
    };
  if (name === "wrangler.toml" || name === "wrangler.json" || name === "wrangler.jsonc")
    return {
      kind: "cloudflare",
      provider: { status: "known", providerSlug: "cloudflare", providerName: "Cloudflare" },
    };
  if (name === "dockerfile" || /^docker-compose\.(?:yml|yaml)$/.test(name))
    return { kind: "docker" };
  if (
    name === ".nvmrc" ||
    name === ".node-version" ||
    name === ".python-version" ||
    name === "runtime.txt"
  )
    return { kind: "runtime" };
  if (name === "fly.toml" || name === "netlify.toml" || name === "railway.json")
    return { kind: "other" };
  return null;
}

function recordConfigFile(
  state: ScanState,
  absolutePath: string,
  config: {
    kind: NonNullable<SafeEvidenceMetadata["configKind"]>;
    provider?: DiscoveryObservation["providerCandidate"];
  },
) {
  const fileName = path.basename(absolutePath).toLowerCase();
  const runtimeName: SafeEvidenceMetadata["runtimeName"] =
    fileName === ".nvmrc" || fileName === ".node-version"
      ? "node"
      : fileName === ".python-version" || fileName === "runtime.txt"
        ? "python"
        : undefined;
  simpleObservation({
    state,
    family: config.kind === "runtime" ? "framework_runtime" : "configuration_file",
    identifier: fileName,
    candidate: config.provider ?? { status: "unknown", providerSlug: null, providerName: null },
    confidence: config.provider ? 0.95 : 0.9,
    reasonCode: "configuration_identity",
    absolutePath,
    metadata: {
      configKind: config.kind,
      ...(runtimeName ? { runtimeName } : {}),
    },
  });
}

function recordRuntimeObservation(
  state: ScanState,
  absolutePath: string,
  runtimeName: NonNullable<SafeEvidenceMetadata["runtimeName"]>,
  ecosystem: NonNullable<SafeEvidenceMetadata["ecosystem"]>,
) {
  const relativePath = safeRelativePath(state.root, absolutePath);
  addObservation(state, {
    id: observationId("framework_runtime", runtimeName, relativePath, ecosystem),
    evidenceFamily: "framework_runtime",
    normalizedIdentifier: runtimeName,
    providerCandidate: { status: "unknown", providerSlug: null, providerName: null },
    confidence: 0.9,
    reasonCode: "framework_package",
    safeRelativePath: relativePath,
    subproject: safeSubproject(relativePath),
    metadata: { runtimeName, ecosystem },
  });
}

function runtimeForManifest(name: string): {
  runtime: NonNullable<SafeEvidenceMetadata["runtimeName"]>;
  ecosystem: NonNullable<SafeEvidenceMetadata["ecosystem"]>;
} {
  switch (name) {
    case "package.json":
      return { runtime: "node", ecosystem: "npm" };
    case "requirements.txt":
    case "pyproject.toml":
      return { runtime: "python", ecosystem: "python" };
    case "go.mod":
      return { runtime: "go", ecosystem: "go" };
    case "cargo.toml":
      return { runtime: "rust", ecosystem: "cargo" };
    case "composer.json":
      return { runtime: "php", ecosystem: "composer" };
    default:
      return { runtime: "unknown", ecosystem: "unknown" };
  }
}

function environmentNameObservation(
  state: ScanState,
  absolutePath: string | undefined,
  name: string,
) {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) return;
  const candidate = resolveEnvironmentProvider(name);
  simpleObservation({
    state,
    family: "environment_variable_name",
    identifier: name,
    candidate: candidate ?? { status: "unknown", providerSlug: null, providerName: null },
    confidence: candidate ? 0.66 : 0.4,
    reasonCode: candidate ? "known_environment_provider" : "environment_name",
    absolutePath,
    scope: "name_only",
  });
}

const pythonImportAliases: Record<string, string> = {
  anthropic: "@anthropic-ai/sdk",
  firebase_admin: "firebase-admin",
  openai: "openai",
  posthog: "posthog",
  sentry_sdk: "sentry-sdk",
  stripe: "stripe",
  supabase: "supabase-js",
  twilio: "twilio",
};

function recordSourceSignals(state: ScanState, absolutePath: string, text: string) {
  const extension = path.extname(absolutePath).toLowerCase();
  const importPattern =
    extension === ".py"
      ? /^\s*(?:from\s+([A-Za-z0-9_.]+)\s+import|import\s+([A-Za-z0-9_.]+))/gm
      : extension === ".go"
        ? /^\s*import\s+(?:\w+\s+)?["']([^"']+)["']/gm
        : extension === ".rs"
          ? /^\s*(?:use|extern crate)\s+([A-Za-z0-9_]+)/gm
          : /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']([^"']{1,180})["']/g;
  for (const match of text.matchAll(importPattern)) {
    let imported = match[1] ?? match[2];
    if (!imported) continue;
    if (extension === ".py")
      imported =
        pythonImportAliases[imported.split(".")[0]!.toLowerCase()] ?? imported.split(".")[0]!;
    if (extension === ".go" || extension === ".rs") imported = imported.toLowerCase();
    else imported = packageRootFromImport(imported) ?? "";
    if (!imported) continue;
    const candidate = resolvePackageProvider(imported);
    if (candidate.status !== "known") continue;
    simpleObservation({
      state,
      family: "import_reference",
      identifier: imported,
      candidate,
      confidence: 0.76,
      reasonCode: "imported_provider_package",
      absolutePath,
      scope: extension,
      metadata: { ecosystem: extension === ".py" ? "python" : extension === ".go" ? "go" : "npm" },
    });
  }

  for (const match of text.matchAll(
    /\b(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]{1,63})\b|\b(?:os\.getenv|os\.environ\.get)\s*\(\s*["']([A-Z][A-Z0-9_]{1,63})["']/g,
  )) {
    const name = match[1] ?? match[2];
    if (name) environmentNameObservation(state, absolutePath, name);
  }

  for (const match of text.matchAll(/\bhttps?:\/\/([^\s"'`<>/\\?#]{1,253})/gi)) {
    const rawHost = match[1]?.split(":")[0]?.toLowerCase();
    if (!rawHost || !/^[a-z0-9.-]{1,253}$/.test(rawHost)) continue;
    const candidate = resolveProviderHost(rawHost);
    if (!candidate) continue;
    simpleObservation({
      state,
      family: "provider_host",
      identifier: rawHost,
      candidate,
      confidence: 0.82,
      reasonCode: "provider_host_reference",
      absolutePath,
    });
  }

  const modelPattern =
    /\b(?:gpt-[a-z0-9][a-z0-9.-]{0,79}|o[134](?:-[a-z0-9][a-z0-9.-]{0,79})?|claude-[a-z0-9][a-z0-9.-]{0,79}|gemini-[a-z0-9][a-z0-9.-]{0,79}|command-[a-z0-9][a-z0-9.-]{0,79}|mistral-[a-z0-9][a-z0-9.-]{0,79})\b/gi;
  for (const match of text.matchAll(modelPattern)) {
    const modelId = match[0]!.toLowerCase();
    const candidate = resolveModelProvider(modelId);
    if (!candidate) continue;
    const modelFamily =
      candidate.providerSlug === "openai"
        ? "openai"
        : candidate.providerSlug === "anthropic"
          ? "anthropic"
          : candidate.providerSlug === "gemini-api"
            ? "gemini"
            : candidate.providerSlug === "cohere"
              ? "cohere"
              : "mistral";
    simpleObservation({
      state,
      family: "model_identifier",
      identifier: modelId,
      candidate,
      confidence: 0.7,
      reasonCode: "model_reference",
      absolutePath,
      metadata: { modelFamily },
    });
  }
}

function isEnvironmentFile(name: string) {
  return name === ".env" || name.startsWith(".env.");
}

function recordEnvironmentNames(state: ScanState, absolutePath: string, text: string) {
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    environmentNameObservation(state, absolutePath, name);
  }
}

async function scanDirectory(state: ScanState, directory: string, depth: number): Promise<void> {
  if (shouldStop(state) || depth > LIMITS.maxDepth) {
    if (depth > LIMITS.maxDepth) markPartial(state, "max_depth");
    return;
  }
  state.directoriesVisited += 1;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    markPartial(state, "read_error");
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (shouldStop(state)) return;
    if (entry.isSymbolicLink()) {
      state.symlinksSkipped += 1;
      markPartial(state, "symlink_skipped");
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (!withinRoot(state.root, absolutePath)) continue;
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name.toLowerCase())) {
        state.ignoredDirectories += 1;
        if (sensitiveDirectories.has(entry.name.toLowerCase()))
          state.ignoredSensitiveDirectories += 1;
      } else {
        await scanDirectory(state, absolutePath, depth + 1);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    state.filesVisited += 1;
    const name = entry.name.toLowerCase();
    if (
      sensitiveFileNames.has(name) ||
      sensitiveFileExtensions.has(path.extname(name)) ||
      /(?:^|[._-])(secret|private[-_]?key|credential)(?:[._-]|$)/i.test(name)
    ) {
      state.ignoredSensitiveFiles += 1;
      continue;
    }
    if (isEnvironmentFile(name)) {
      const text = await safeReadText(state, absolutePath, LIMITS.maxEnvironmentFileBytes);
      if (text !== null) {
        const size = Buffer.byteLength(text, "utf8");
        if (state.totalEnvironmentBytes + size <= LIMITS.maxTotalEnvironmentBytes) {
          state.totalEnvironmentBytes += size;
          recordEnvironmentNames(state, absolutePath, text);
        } else markPartial(state, "max_total_bytes");
      }
      continue;
    }
    if (lockfileNames.has(name)) {
      recordLockfileIdentity(state, absolutePath, name);
      continue;
    }
    const config = configFileInfo(name);
    if (config) {
      recordConfigFile(state, absolutePath, config);
      continue;
    }
    const isPackageJson = packageJsonNames.has(name);
    const isTextManifest = textManifestNames.has(name);
    if (!isPackageJson && !isTextManifest) {
      const extension = path.extname(name);
      if (!sourceExtensions.has(extension)) continue;
      if (
        state.sourceFilesInspected >= LIMITS.maxSourceFiles ||
        state.totalSourceBytes >= LIMITS.maxTotalSourceBytes
      ) {
        markPartial(
          state,
          state.sourceFilesInspected >= LIMITS.maxSourceFiles ? "max_files" : "max_total_bytes",
        );
        continue;
      }
      const source = await safeReadText(state, absolutePath, LIMITS.maxSourceFileBytes);
      if (source === null) continue;
      const size = Buffer.byteLength(source, "utf8");
      if (state.totalSourceBytes + size > LIMITS.maxTotalSourceBytes) {
        markPartial(state, "max_total_bytes");
        continue;
      }
      state.totalSourceBytes += size;
      state.sourceFilesInspected += 1;
      recordSourceSignals(state, absolutePath, source);
      continue;
    }
    if (state.totalManifestBytes >= LIMITS.maxTotalManifestBytes) {
      markPartial(state, "max_total_bytes");
      continue;
    }
    const text = await safeReadText(state, absolutePath, LIMITS.maxManifestBytes);
    if (text === null) continue;
    const size = Buffer.byteLength(text, "utf8");
    if (state.totalManifestBytes + size > LIMITS.maxTotalManifestBytes) {
      markPartial(state, "max_total_bytes");
      continue;
    }
    state.totalManifestBytes += size;
    state.manifestsParsed += 1;
    const runtime = runtimeForManifest(name);
    recordRuntimeObservation(state, absolutePath, runtime.runtime, runtime.ecosystem);
    if (name === "package.json" || name === "composer.json")
      recordPackageJson(state, absolutePath, text, name);
    else if (name === "requirements.txt") recordRequirements(state, absolutePath, text);
    else if (name === "go.mod") recordGoMod(state, absolutePath, text);
    else if (name === "cargo.toml") recordCargo(state, absolutePath, text);
    else if (name === "pyproject.toml") recordPyproject(state, absolutePath, text);
  }
}

function safeGitComponent(value: string | null | undefined) {
  if (
    !value ||
    value.length > 120 ||
    !/^[A-Za-z0-9_.-]+$/.test(value) ||
    value === "." ||
    value === ".."
  )
    return null;
  return value;
}

function parseRemoteIdentity(
  rawUrl: string,
): Pick<GitProjectIdentity, "host" | "owner" | "repository"> | null {
  let hostName: string;
  let pathname: string;
  try {
    if (/^[^/@:]+@[^/:]+:[^/]+\/.+/.test(rawUrl)) {
      const match = /^[^/@:]+@([^/:]+):(.+)$/.exec(rawUrl)!;
      hostName = match[1]!;
      pathname = match[2]!;
    } else {
      const parsed = new URL(rawUrl);
      if (!["https:", "http:", "ssh:"].includes(parsed.protocol)) return null;
      hostName = parsed.hostname;
      pathname = parsed.pathname.replace(/^\//, "");
    }
  } catch {
    return null;
  }
  if (!hostName) return null;
  const [ownerRaw, repositoryRaw, ...rest] = pathname.replace(/\.git$/i, "").split("/");
  if (rest.length || !ownerRaw || !repositoryRaw) return null;
  const owner = safeGitComponent(ownerRaw);
  const repository = safeGitComponent(repositoryRaw);
  if (!owner || !repository) return null;
  const lowerHost = hostName.toLowerCase();
  const host: GitProjectIdentity["host"] =
    lowerHost === "github.com" || lowerHost === "gitlab.com" || lowerHost === "bitbucket.org"
      ? lowerHost
      : "other";
  return { host, owner, repository };
}

async function readBoundedGitFile(state: ScanState, gitDirectory: string, name: string) {
  const absolutePath = path.join(gitDirectory, name);
  if (!withinRoot(state.root, absolutePath)) return null;
  return safeReadText(state, absolutePath, LIMITS.maxGitMetadataBytes);
}

async function readGitIdentity(state: ScanState): Promise<GitProjectIdentity> {
  const empty: GitProjectIdentity = {
    host: null,
    owner: null,
    repository: null,
    branch: null,
    commit: null,
  };
  const gitDirectory = path.join(state.root, ".git");
  try {
    const info = await lstat(gitDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) return empty;
    const head = await readBoundedGitFile(state, gitDirectory, "HEAD");
    const config = await readBoundedGitFile(state, gitDirectory, "config");
    if (head === null || config === null) return empty;
    const headLine = head.trim();
    let branch: string | null = null;
    let commit: string | null = null;
    const refMatch = /^ref:\s+(refs\/heads\/[A-Za-z0-9_./-]{1,180})$/.exec(headLine);
    if (refMatch) {
      branch = safeGitComponent(refMatch[1]!.slice("refs/heads/".length));
      if (branch === null)
        branch =
          refMatch[1]!
            .slice("refs/heads/".length)
            .split("/")
            .map(safeGitComponent)
            .filter(Boolean)
            .join("/") || null;
      const refPath = refMatch[1]!.split("/");
      if (refPath.every((segment) => segment && segment !== "." && segment !== "..")) {
        const refValue = await readBoundedGitFile(state, gitDirectory, refPath.join(path.sep));
        if (refValue && /^[a-f0-9]{40,64}$/i.test(refValue.trim()))
          commit = refValue.trim().toLowerCase();
      }
      if (!commit) {
        const packed = await readBoundedGitFile(state, gitDirectory, "packed-refs");
        const packedLine = packed?.split(/\r?\n/).find((line) => line.endsWith(` ${refMatch[1]}`));
        const packedSha = packedLine?.split(" ", 1)[0];
        if (packedSha && /^[a-f0-9]{40,64}$/i.test(packedSha)) commit = packedSha.toLowerCase();
      }
    } else if (/^[a-f0-9]{40,64}$/i.test(headLine)) {
      commit = headLine.toLowerCase();
    }

    let inOrigin = false;
    let remoteUrl: string | null = null;
    for (const line of config.split(/\r?\n/)) {
      const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
      if (section) {
        inOrigin = section[1] === "origin";
        continue;
      }
      if (/^\s*\[/.test(line)) {
        inOrigin = false;
        continue;
      }
      const url = /^\s*url\s*=\s*(\S+)\s*$/.exec(line);
      if (inOrigin && url) {
        remoteUrl = url[1]!;
        break;
      }
    }
    const remote = remoteUrl ? parseRemoteIdentity(remoteUrl) : null;
    return {
      host: remote?.host ?? null,
      owner: remote?.owner ?? null,
      repository: remote?.repository ?? null,
      branch,
      commit,
    };
  } catch {
    return empty;
  }
}

export async function scanProject({ root, signal }: ScanProjectOptions): Promise<ScanResult> {
  const startedAt = Date.now();
  const failed = (reason: "root_unavailable" | "network_path_not_allowed"): ScanResult => ({
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    scannerVersion: DISCOVERY_SCANNER_VERSION,
    registryVersion: DISCOVERY_REGISTRY_VERSION,
    scanId: randomUUID(),
    projectFingerprint: null,
    status: "failed",
    projectSummary: {
      rootName: "project",
      git: { host: null, owner: null, repository: null, branch: null, commit: null },
    },
    stats: {
      filesVisited: 0,
      directoriesVisited: 0,
      manifestsParsed: 0,
      sourceFilesInspected: 0,
      observations: 0,
      symlinksSkipped: 0,
      ignoredDirectories: 0,
      ignoredSensitiveFiles: 0,
      ignoredSensitiveDirectories: 0,
      totalBytesRead: 0,
      truncated: true,
      partialReasons: [reason],
      durationMs: Math.max(0, Date.now() - startedAt),
    },
    observations: [],
  });
  if (typeof root !== "string" || root.length === 0 || root.length > 4_096) {
    return failed("root_unavailable");
  }
  if (process.platform === "win32" && root.startsWith("\\\\")) {
    return failed("network_path_not_allowed");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(path.resolve(root));
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) throw new Error("invalid_root");
  } catch {
    return failed("root_unavailable");
  }

  const state: ScanState = {
    root: canonicalRoot,
    signal,
    startedAt,
    filesVisited: 0,
    directoriesVisited: 0,
    manifestsParsed: 0,
    symlinksSkipped: 0,
    totalManifestBytes: 0,
    totalEnvironmentBytes: 0,
    totalSourceBytes: 0,
    totalBytesRead: 0,
    sourceFilesInspected: 0,
    ignoredDirectories: 0,
    ignoredSensitiveFiles: 0,
    ignoredSensitiveDirectories: 0,
    truncated: false,
    partialReasons: new Set(),
    observations: new Map(),
  };
  await scanDirectory(state, canonicalRoot, 0);
  const git = await readGitIdentity(state);
  if (git.host !== null || git.owner !== null || git.repository !== null) {
    const identifier = [git.host, git.owner, git.repository].filter(Boolean).join("/");
    const providerCandidate: DiscoveryObservation["providerCandidate"] =
      git.host === "github.com"
        ? { status: "known", providerSlug: "github", providerName: "GitHub" }
        : { status: "unknown", providerSlug: null, providerName: null };
    const metadata: SafeEvidenceMetadata = {
      ...(git.host ? { gitHost: git.host } : {}),
      ...(git.owner ? { gitOwner: git.owner } : {}),
      ...(git.repository ? { gitRepository: git.repository } : {}),
      ...(git.branch ? { gitBranch: git.branch } : {}),
      ...(git.commit ? { gitCommit: git.commit } : {}),
    };
    addObservation(state, {
      id: observationId("git_remote", identifier, null, "origin"),
      evidenceFamily: "git_remote",
      normalizedIdentifier: identifier,
      providerCandidate,
      confidence: git.host === "github.com" ? 0.98 : 0.45,
      reasonCode: "sanitized_git_origin",
      safeRelativePath: null,
      subproject: null,
      metadata,
    });
  }

  const status = signal?.aborted ? "cancelled" : state.truncated ? "partial" : "complete";
  const rootName = safeSegment(path.basename(canonicalRoot)) ?? "project";
  const observations = [...state.observations.values()].sort(
    (left, right) =>
      left.evidenceFamily.localeCompare(right.evidenceFamily) ||
      left.normalizedIdentifier.localeCompare(right.normalizedIdentifier) ||
      (left.safeRelativePath ?? "").localeCompare(right.safeRelativePath ?? "") ||
      left.id.localeCompare(right.id),
  );
  return {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    scannerVersion: DISCOVERY_SCANNER_VERSION,
    registryVersion: DISCOVERY_REGISTRY_VERSION,
    scanId: randomUUID(),
    projectFingerprint: null,
    status,
    projectSummary: { rootName, git },
    stats: {
      filesVisited: state.filesVisited,
      directoriesVisited: state.directoriesVisited,
      manifestsParsed: state.manifestsParsed,
      sourceFilesInspected: state.sourceFilesInspected,
      observations: observations.length,
      symlinksSkipped: state.symlinksSkipped,
      ignoredDirectories: state.ignoredDirectories,
      ignoredSensitiveFiles: state.ignoredSensitiveFiles,
      ignoredSensitiveDirectories: state.ignoredSensitiveDirectories,
      totalBytesRead: state.totalBytesRead,
      truncated: state.truncated,
      partialReasons: [...state.partialReasons].sort(),
      durationMs: Math.max(0, Date.now() - startedAt),
    },
    observations,
  };
}
