import { createHash } from "node:crypto";
import ts from "typescript";
import { CodeAnalysisStageError } from "@/lib/code-intelligence/failures";

export const CODE_INTELLIGENCE_VERSION = "code-intelligence-v2";
// Endpoint call recognition was tightened after the first v2 readback exposed
// non-HTTP getters (for example URLSearchParams.get) as dynamic endpoints.
export const CODE_INTELLIGENCE_PROFILE = "javascript-typescript-v2.1";
export const CODE_SCAN_LIMITS = {
  maxFileBytes: 256_000,
  maxManifestBytes: 5_000_000,
  maxRepositoryBytes: 10_000_000,
  maxFiles: 1_000,
  maxPersistedFacts: 50_000,
  maxAstNodes: 1_000_000,
  maxAstDepth: 512,
  maxDeferredNodes: 100_000,
} as const;

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "vendor",
]);
const CODE_EXTENSIONS = new Map([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".cjs", "javascript"],
  [".mjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".cts", "typescript"],
  [".mts", "typescript"],
]);
export type CodeLanguageAdapter = {
  id: string;
  supports(path: string): boolean;
  languageForPath(path: string): string | null;
  parse(path: string, text: string): ts.SourceFile;
};

export const JAVASCRIPT_TYPESCRIPT_ADAPTER: CodeLanguageAdapter = {
  id: "typescript-compiler-api-v1",
  supports: (path) => CODE_EXTENSIONS.has(ext(path)),
  languageForPath: (path) => CODE_EXTENSIONS.get(ext(path)) ?? null,
  parse: (path, text) => {
    const extension = ext(path);
    const scriptKind =
      extension === ".tsx"
        ? ts.ScriptKind.TSX
        : extension === ".jsx"
          ? ts.ScriptKind.JSX
          : [".js", ".cjs", ".mjs"].includes(extension)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
    return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind);
  },
};
export const CODE_LANGUAGE_ADAPTERS: readonly CodeLanguageAdapter[] = [
  JAVASCRIPT_TYPESCRIPT_ADAPTER,
];
const KNOWN_SKIP_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".mp4",
  ".mp3",
  ".svgz",
  ".wasm",
  ".map",
]);
const SUPPORTED_ROUTE_TARGETS = new Set([
  "dependency_product_impact",
  "dependency_impact_repository_exposure_candidate",
  "contract_exposure_analysis",
  "repository_dependency_exposure_analysis",
  "contract_repository_exposure_analysis",
  "integration_auth_risk_analysis",
]);
const HTTP_CLIENT_PACKAGES = new Set([
  "axios",
  "cross-fetch",
  "got",
  "isomorphic-fetch",
  "ky",
  "needle",
  "node-fetch",
  "request",
  "superagent",
  "undici",
]);
const HTTP_CLIENT_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "request",
]);

export type CoverageState = "complete" | "partial" | "unsupported" | "failed";
export type ConfidenceClass = "exact" | "structural" | "heuristic";
export type EntityType =
  | "file"
  | "module"
  | "function"
  | "method"
  | "class"
  | "import"
  | "package_dependency"
  | "external_sdk_reference"
  | "http_endpoint_reference"
  | "webhook_event_reference"
  | "environment_variable_name"
  | "model_or_resource_identifier"
  | "schema_reference";
export type ExternalReferenceType =
  | "package"
  | "import"
  | "sdk_call"
  | "event"
  | "endpoint"
  | "dynamic_endpoint"
  | "environment_variable"
  | "schema";
export type RelationType =
  | "FILE_CONTAINS_SYMBOL"
  | "IMPORTS_PACKAGE"
  | "IMPORTS_SYMBOL"
  | "CALLS_SYMBOL"
  | "REFERENCES_EXTERNAL"
  | "USES_ENV_NAME"
  | "HANDLES_EVENT"
  | "CALLS_ENDPOINT"
  | "REFERENCES_SCHEMA";

export type SnapshotFile = {
  path: string;
  text: string;
  size?: number;
  binary?: boolean;
  collectionTruncated?: boolean;
  directorySkipReason?: string;
  skipReason?: string;
};
export type CodeEntity = {
  entityKey: string;
  entityType: EntityType;
  name: string;
  language: string;
  path: string;
  startLine: number | null;
  startColumn: number | null;
  endLine: number | null;
  endColumn: number | null;
  extractorType: string;
  confidenceClass: ConfidenceClass;
};
export type CodeRelation = {
  fromEntityKey: string;
  toEntityKey: string;
  relationType: RelationType;
  confidenceClass: ConfidenceClass;
  evidencePath: string;
  evidenceStartLine: number;
  evidenceStartColumn: number;
  evidenceEndLine: number;
  evidenceEndColumn: number;
  extractorType: string;
};
export type ExternalReference = {
  entityKey: string;
  referenceType: ExternalReferenceType;
  normalizedValue: string;
  path: string;
  startLine: number;
  startColumn: number | null;
  endLine: number;
  endColumn: number | null;
  language: string;
  confidenceClass: ConfidenceClass;
  redacted: boolean;
  valueFingerprint: string | null;
  extractorType: string;
};
export type SkippedFile = { path: string; reason: string; size: number };
export type AnalysisResult = {
  coverageState: CoverageState;
  filesDiscovered: number;
  filesAnalyzed: number;
  filesSkipped: number;
  parseFailures: number;
  bytesAnalyzed: number;
  supportedFilesDiscovered: number;
  supportedFilesAnalyzed: number;
  supportedFilesSkippedByBound: number;
  unsupportedLanguageFiles: number;
  coverageReasonCounts: Record<string, number>;
  entities: CodeEntity[];
  relations: CodeRelation[];
  externalReferences: ExternalReference[];
  skippedFiles: SkippedFile[];
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const SAFE_PACKAGE_NAME = /^@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/;
const SAFE_PACKAGE_RANGE = /^[~^<>=*xX0-9A-Za-z.+|:, \-]{1,80}$/;
const SAFE_IMPORT_SPECIFIER = /^[A-Za-z0-9@._/-]{1,240}$/;
const tupleKey = (...parts: (string | number | null)[]) =>
  digest(parts.map((x) => x ?? "").join("\0"));
const stableCompare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const BOUND_SKIP_REASONS = new Set([
  "file_count_limit",
  "file_size_limit",
  "repository_byte_limit",
  "ast_node_limit",
  "ast_depth_limit",
  "fact_count_limit",
]);

function addRelation(relations: Map<string, CodeRelation>, relation: CodeRelation) {
  const key = tupleKey(
    relation.fromEntityKey,
    relation.toEntityKey,
    relation.relationType,
    relation.evidencePath,
    relation.evidenceStartLine,
    relation.evidenceStartColumn,
    relation.evidenceEndLine,
    relation.evidenceEndColumn,
    relation.extractorType,
  );
  relations.set(key, relation);
}

class BoundedFactMap<K, V> extends Map<K, V> {
  private readonly account: () => void;

  constructor(account: () => void) {
    super();
    this.account = account;
  }

  override set(key: K, value: V) {
    const isNew = !this.has(key);
    super.set(key, value);
    if (isNew) this.account();
    return this;
  }
}
const ext = (file: string) => file.slice(file.lastIndexOf(".")).toLowerCase();

function safeRelativePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.length > 1024 ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === ".." || part === ".")
  )
    return null;
  return normalized
    .split("/")
    .map((part) => {
      const extension = part.includes(".") ? ext(part) : "";
      const candidate = extension ? part.slice(0, -extension.length) : part;
      return looksSecret(candidate) ? `[redacted:${digest(part).slice(0, 16)}]${extension}` : part;
    })
    .join("/");
}

function looksSecret(value: string) {
  if (
    /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b)/i.test(
      value,
    ) ||
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
  )
    return true;
  const trimmed = value.trim();
  if (trimmed.length < 28 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  const alphabet = new Set(trimmed).size;
  return alphabet >= 16 && alphabet / trimmed.length > 0.45;
}

function addEntity(entities: Map<string, CodeEntity>, input: Omit<CodeEntity, "entityKey">) {
  const entityKey = tupleKey(
    input.entityType,
    input.path,
    input.name,
    input.startLine,
    input.startColumn,
  );
  if (!entities.has(entityKey))
    entities.set(entityKey, {
      ...input,
      name: looksSecret(input.name) ? "[redacted]" : input.name,
      entityKey,
    });
  return entityKey;
}

function packageRoot(specifier: string) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#")
  )
    return null;
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? null);
}

function addExternal(
  entities: Map<string, CodeEntity>,
  refs: Map<string, ExternalReference>,
  relations: Map<string, CodeRelation>,
  input: Omit<
    ExternalReference,
    "entityKey" | "redacted" | "valueFingerprint" | "startColumn" | "endColumn"
  > & {
    rawValue?: string;
    parentEntityKey?: string;
    forceRedact?: boolean;
    referenceStartColumn?: number;
    referenceEndColumn?: number;
    evidenceStartLine?: number;
    evidenceStartColumn?: number;
    evidenceEndLine?: number;
    evidenceEndColumn?: number;
  },
) {
  const secret =
    input.forceRedact === true ||
    looksSecret(input.normalizedValue) ||
    (input.rawValue !== undefined && looksSecret(input.rawValue));
  const normalizedValue = secret ? "[redacted]" : input.normalizedValue.slice(0, 512);
  const valueFingerprint = secret ? digest(input.rawValue ?? input.normalizedValue) : null;
  const entityType: EntityType =
    input.referenceType === "package"
      ? "package_dependency"
      : input.referenceType === "sdk_call"
        ? "external_sdk_reference"
        : input.referenceType === "endpoint" || input.referenceType === "dynamic_endpoint"
          ? "http_endpoint_reference"
          : input.referenceType === "event"
            ? "webhook_event_reference"
            : input.referenceType === "environment_variable"
              ? "environment_variable_name"
              : "schema_reference";
  const entityKey = addEntity(entities, {
    entityType,
    name: normalizedValue.slice(0, 240),
    language: input.language,
    path: input.path,
    startLine: input.startLine,
    startColumn: input.referenceStartColumn ?? input.evidenceStartColumn ?? 1,
    endLine: input.endLine,
    endColumn: input.referenceEndColumn ?? input.evidenceEndColumn ?? 1,
    extractorType: input.extractorType,
    confidenceClass: secret ? "heuristic" : input.confidenceClass,
  });
  const key = tupleKey(entityKey, input.referenceType, normalizedValue, input.extractorType);
  refs.set(key, {
    entityKey,
    referenceType: input.referenceType,
    normalizedValue,
    path: input.path,
    startLine: input.startLine,
    startColumn: input.referenceStartColumn ?? input.evidenceStartColumn ?? 1,
    endLine: input.endLine,
    endColumn: input.referenceEndColumn ?? input.evidenceEndColumn ?? 1,
    language: input.language,
    confidenceClass: secret ? "heuristic" : input.confidenceClass,
    redacted: secret,
    valueFingerprint,
    extractorType: input.extractorType,
  });
  if (input.parentEntityKey) {
    const relationType: RelationType =
      input.referenceType === "environment_variable"
        ? "USES_ENV_NAME"
        : input.referenceType === "event"
          ? "HANDLES_EVENT"
          : input.referenceType === "endpoint" || input.referenceType === "dynamic_endpoint"
            ? "CALLS_ENDPOINT"
            : input.referenceType === "schema"
              ? "REFERENCES_SCHEMA"
              : input.referenceType === "import"
                ? "IMPORTS_PACKAGE"
                : "REFERENCES_EXTERNAL";
    addRelation(relations, {
      fromEntityKey: input.parentEntityKey,
      toEntityKey: entityKey,
      relationType,
      confidenceClass: input.confidenceClass,
      evidencePath: input.path,
      evidenceStartLine: input.evidenceStartLine ?? input.startLine,
      evidenceStartColumn: input.evidenceStartColumn ?? 1,
      evidenceEndLine: input.evidenceEndLine ?? input.endLine,
      evidenceEndColumn: input.evidenceEndColumn ?? 1,
      extractorType: input.extractorType,
    });
  }
  return entityKey;
}

function sourceLocation(source: ts.SourceFile, node: ts.Node) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const end = source.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function staticString(node: ts.Expression): string | null {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(node)) {
    let output = node.head.text;
    for (const span of node.templateSpans) {
      if (
        !ts.isStringLiteralLike(span.expression) &&
        !ts.isNoSubstitutionTemplateLiteral(span.expression)
      )
        return null;
      output += span.expression.text + span.literal.text;
    }
    return output;
  }
  return null;
}

function endpointValue(raw: string) {
  try {
    const value = new URL(raw);
    if (!["http:", "https:"].includes(value.protocol) || !value.hostname) return null;
    const sensitivePath = value.pathname.split("/").some((segment) => {
      try {
        return looksSecret(decodeURIComponent(segment));
      } catch {
        return true;
      }
    });
    const sensitiveHost = value.hostname.split(".").some((segment) => looksSecret(segment));
    const hasCredential = Boolean(
      value.username || value.password || sensitivePath || sensitiveHost,
    );
    value.username = "";
    value.password = "";
    value.search = "";
    value.hash = "";
    const normalized = `${value.protocol}//${value.host.toLowerCase()}${value.pathname}`.slice(
      0,
      512,
    );
    return { value: hasCredential ? "[redacted]" : normalized, redacted: hasCredential };
  } catch {
    return null;
  }
}

function memberChain(node: ts.Expression): { root: string; path: string[] } | null {
  const parts: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
    } else {
      const arg = current.argumentExpression;
      if (!arg || !ts.isStringLiteralLike(arg)) return null;
      parts.unshift(arg.text);
      current = current.expression;
    }
  }
  if (!ts.isIdentifier(current)) return null;
  return { root: current.text, path: parts };
}

function isEventDiscriminator(node: ts.Node) {
  const text = node.getText();
  return /(?:^|\.)event\w*\.type$|\.type$|^type$/.test(text);
}

function controlledEventString(node: ts.StringLiteralLike) {
  const parent = node.parent;
  if (
    ts.isBinaryExpression(parent) &&
    [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
      parent.operatorToken.kind,
    )
  ) {
    const other = parent.left === node ? parent.right : parent.left;
    return isEventDiscriminator(other) ? parent : null;
  }
  if (
    ts.isCaseClause(parent) &&
    ts.isSwitchStatement(parent.parent.parent) &&
    isEventDiscriminator(parent.parent.parent.expression)
  )
    return parent;
  return null;
}

function functionName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node)) &&
    node.name
  ) {
    return node.name.getText();
  }
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  )
    return node.parent.name.text;
  return null;
}

function parseManifest(
  files: SnapshotFile[],
  entities: Map<string, CodeEntity>,
  refs: Map<string, ExternalReference>,
  skippedFiles: SkippedFile[],
) {
  const manifest = files.find((file) => file.path === "package.json");
  if (!manifest) return false;
  const manifestSize = manifest.size ?? Buffer.byteLength(manifest.text, "utf8");
  if (manifestSize > CODE_SCAN_LIMITS.maxManifestBytes) {
    skippedFiles.push({ path: "package.json", reason: "manifest_size_limit", size: manifestSize });
    return true;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(manifest.text) as Record<string, unknown>;
  } catch {
    skippedFiles.push({
      path: "package.json",
      reason: "manifest_parse_failed",
      size: manifestSize,
    });
    return true;
  }
  const lock = files.find((file) => file.path === "package-lock.json");
  const pnpm = files.find((file) => file.path === "pnpm-lock.yaml");
  const yarn = files.find((file) => file.path === "yarn.lock");
  let lockPackages: Record<string, { version?: string }> = {};
  let incomplete = false;
  if (
    lock &&
    (lock.size ?? Buffer.byteLength(lock.text, "utf8")) > CODE_SCAN_LIMITS.maxManifestBytes
  ) {
    skippedFiles.push({
      path: "package-lock.json",
      reason: "lockfile_size_limit",
      size: lock.size ?? Buffer.byteLength(lock.text, "utf8"),
    });
    incomplete = true;
  } else if (lock) {
    try {
      const lockParsed = JSON.parse(lock.text) as {
        packages?: Record<string, { version?: string }>;
      };
      lockPackages = lockParsed.packages ?? {};
    } catch {
      skippedFiles.push({
        path: "package-lock.json",
        reason: "lockfile_parse_failed",
        size: lock.size ?? Buffer.byteLength(lock.text, "utf8"),
      });
      incomplete = true;
    }
  }
  if (
    !lock &&
    pnpm &&
    (pnpm.size ?? Buffer.byteLength(pnpm.text, "utf8")) > CODE_SCAN_LIMITS.maxManifestBytes
  ) {
    skippedFiles.push({
      path: "pnpm-lock.yaml",
      reason: "lockfile_size_limit",
      size: pnpm.size ?? Buffer.byteLength(pnpm.text, "utf8"),
    });
    incomplete = true;
  } else if (
    !lock &&
    yarn &&
    (yarn.size ?? Buffer.byteLength(yarn.text, "utf8")) > CODE_SCAN_LIMITS.maxManifestBytes
  ) {
    skippedFiles.push({
      path: "yarn.lock",
      reason: "lockfile_size_limit",
      size: yarn.size ?? Buffer.byteLength(yarn.text, "utf8"),
    });
    incomplete = true;
  } else if (!lock && pnpm) {
    let current = "";
    for (const line of pnpm.text.split(/\r?\n/).slice(0, 100_000)) {
      if (/^  \/?[^\s:]+@[^\s:]+:\s*$/.test(line)) {
        current = line.trim().replace(/^\//, "").replace(/:$/, "");
        continue;
      }
      if (current && /^    version:\s*["']?[^\s"']+/.test(line)) {
        const version = /^    version:\s*["']?([^\s"']+)/.exec(line)?.[1];
        const separator = current.lastIndexOf("@");
        const packageName = separator > 0 ? current.slice(0, separator) : current;
        if (version && packageName) lockPackages[`node_modules/${packageName}`] = { version };
        current = "";
      }
    }
  } else if (!lock && yarn) {
    let selectors: string[] = [];
    for (const line of yarn.text.split(/\r?\n/).slice(0, 100_000)) {
      if (!line.startsWith(" ") && line.endsWith(":")) {
        selectors = line
          .slice(0, -1)
          .split(/,\s*/)
          .map((item) => item.replace(/^"|"$/g, ""));
        continue;
      }
      if (selectors.length && /^  version\s+"?([^"\s]+)"?/.test(line)) {
        const version = /^  version\s+"?([^"\s]+)"?/.exec(line)?.[1];
        if (version) {
          for (const selector of selectors) {
            const at = selector.lastIndexOf("@");
            if (at > 0) lockPackages[`node_modules/${selector.slice(0, at)}`] = { version };
          }
        }
        selectors = [];
      }
    }
  }
  const sections: Array<[string, string]> = [
    ["dependencies", "production"],
    ["devDependencies", "development"],
    ["optionalDependencies", "optional"],
    ["peerDependencies", "peer"],
  ];
  for (const [field, dependencyClass] of sections) {
    const section = parsed[field];
    if (!section || typeof section !== "object" || Array.isArray(section)) continue;
    for (const [name, range] of Object.entries(section as Record<string, unknown>).sort(
      ([a], [b]) => stableCompare(a, b),
    )) {
      if (
        typeof range !== "string" ||
        !name ||
        name.length > 160 ||
        !SAFE_PACKAGE_NAME.test(name) ||
        range.length > 80 ||
        !SAFE_PACKAGE_RANGE.test(range) ||
        looksSecret(name) ||
        looksSecret(range)
      ) {
        if (
          !skippedFiles.some(
            (item) =>
              item.path === "package.json" &&
              item.reason === "manifest_value_redacted_or_oversized",
          )
        ) {
          skippedFiles.push({
            path: "package.json",
            reason: "manifest_value_redacted_or_oversized",
            size: manifestSize,
          });
        }
        incomplete = true;
        continue;
      }
      const resolved = lockPackages[`node_modules/${name}`]?.version;
      if (resolved && (!/^[0-9A-Za-z.+-]{1,80}$/.test(resolved) || looksSecret(resolved))) {
        incomplete = true;
        continue;
      }
      const value = `${name}@${resolved ?? range}`;
      const entityKey = addEntity(entities, {
        entityType: "package_dependency",
        name: value,
        language: "javascript",
        path: "package.json",
        startLine: null,
        startColumn: null,
        endLine: null,
        endColumn: null,
        extractorType: `package-manifest:${dependencyClass}`,
        confidenceClass: "exact",
      });
      const key = tupleKey(entityKey, "package", value, "package-manifest");
      refs.set(key, {
        entityKey,
        referenceType: "package",
        normalizedValue: value,
        path: "package.json",
        startLine: 1,
        startColumn: null,
        endLine: 1,
        endColumn: null,
        language: "javascript",
        confidenceClass: "exact",
        redacted: false,
        valueFingerprint: null,
        extractorType: `package-manifest:${dependencyClass}`,
      });
    }
  }
  return incomplete;
}

export function analyzeCodeSnapshot(inputFiles: SnapshotFile[]): AnalysisResult {
  const collectionTruncated = inputFiles.some((file) => file.collectionTruncated === true);
  const directorySkips = inputFiles.filter((file) => file.directorySkipReason);
  const files = inputFiles
    .filter((file) => !file.collectionTruncated && !file.directorySkipReason)
    .sort((a, b) => stableCompare(a.path, b.path));
  let factCount = 0;
  const accountFact = () => {
    factCount += 1;
    if (factCount > CODE_SCAN_LIMITS.maxPersistedFacts)
      throw new CodeAnalysisStageError("fact_limit_exceeded");
  };
  const entities = new BoundedFactMap<string, CodeEntity>(accountFact);
  const relations = new BoundedFactMap<string, CodeRelation>(accountFact);
  const refs = new BoundedFactMap<string, ExternalReference>(accountFact);
  const skippedFiles: SkippedFile[] = [];
  let filesAnalyzed = 0;
  let parseFailures = 0;
  let bytesAnalyzed = 0;
  let incomplete = collectionTruncated || directorySkips.length > 0;
  if (collectionTruncated) {
    skippedFiles.push({ path: "[repository]", reason: "traversal_entry_limit", size: 0 });
  }
  for (const file of directorySkips) {
    const pathValue = safeRelativePath(file.path);
    if (!pathValue) {
      incomplete = true;
      skippedFiles.push({
        path: `[unsafe-path:${digest(file.path).slice(0, 16)}]`,
        reason: "unsafe_path",
        size: 0,
      });
      continue;
    }
    skippedFiles.push({ path: pathValue, reason: file.directorySkipReason!, size: 0 });
  }
  let unsupportedCount = 0;
  const symbolEntities = new Map<string, string[]>();
  const unresolvedCalls: Array<{
    owner: string;
    callee: string;
    path: string;
    startLine: number;
    startColumn: number;
    endLine: number;
    endColumn: number;
  }> = [];
  let supportedFilesAnalyzed = 0;
  let unsupportedLanguageFiles = 0;
  let astNodesVisited = 0;
  let astBudgetReached = false;
  let astBudgetReason = "ast_node_limit";
  let deferredNodeCount = 0;
  const defer = <T>(queue: T[], value: T) => {
    deferredNodeCount += 1;
    if (deferredNodeCount > CODE_SCAN_LIMITS.maxDeferredNodes)
      throw new CodeAnalysisStageError("parse_budget_exceeded");
    queue.push(value);
  };

  const codeCandidates = files.filter((file) =>
    CODE_LANGUAGE_ADAPTERS.some((adapter) => adapter.supports(file.path)),
  );
  if (codeCandidates.length > CODE_SCAN_LIMITS.maxFiles) incomplete = true;
  let examined = 0;

  for (const original of files) {
    const pathValue = safeRelativePath(original.path);
    if (!pathValue) {
      skippedFiles.push({
        path: `[unsafe-path:${digest(original.path).slice(0, 16)}]`,
        reason: "unsafe_path",
        size: original.size ?? 0,
      });
      incomplete = true;
      continue;
    }
    const fileSize = original.size ?? Buffer.byteLength(original.text, "utf8");
    if (original.skipReason) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: original.skipReason,
        size: fileSize,
      });
      incomplete = true;
      continue;
    }
    const basename = pathValue.split("/").at(-1)!.toLowerCase();
    if (basename === ".env" || basename.startsWith(".env.")) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "environment_file_excluded",
        size: fileSize,
      });
      continue;
    }
    const parts = pathValue.split("/");
    const skipDirectory = parts.slice(0, -1).find((part) => SKIP_DIRS.has(part.toLowerCase()));
    if (skipDirectory) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: `generated_directory:${skipDirectory.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`,
        size: fileSize,
      });
      if (CODE_LANGUAGE_ADAPTERS.some((adapter) => adapter.supports(pathValue))) incomplete = true;
      continue;
    }
    if (/(?:\.min\.(?:js|css)|\.generated\.(?:js|ts|tsx)|\.map)$/i.test(pathValue)) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "generated_or_minified",
        size: fileSize,
      });
      if (CODE_LANGUAGE_ADAPTERS.some((adapter) => adapter.supports(pathValue))) incomplete = true;
      continue;
    }
    if (
      original.binary ||
      original.text.includes("\0") ||
      KNOWN_SKIP_EXTENSIONS.has(ext(pathValue))
    ) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "binary_or_non_source",
        size: fileSize,
      });
      if (CODE_LANGUAGE_ADAPTERS.some((adapter) => adapter.supports(pathValue))) incomplete = true;
      continue;
    }
    if (
      pathValue === "package-lock.json" ||
      pathValue === "pnpm-lock.yaml" ||
      pathValue === "yarn.lock"
    )
      continue;
    const adapter = CODE_LANGUAGE_ADAPTERS.find((candidate) => candidate.supports(pathValue));
    const language = adapter?.languageForPath(pathValue) ?? null;
    if (!language) {
      if (/\.(?:py|go|rb|php|java|cs|rs|swift|kt|scala|c|h|cpp)$/i.test(pathValue)) {
        unsupportedCount += 1;
        unsupportedLanguageFiles += 1;
        skippedFiles.push({
          path: pathValue.slice(0, 1024),
          reason: "unsupported_language",
          size: fileSize,
        });
        if (codeCandidates.length > 0) incomplete = true;
      }
      continue;
    }
    if (++examined > CODE_SCAN_LIMITS.maxFiles) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "file_count_limit",
        size: fileSize,
      });
      if (CODE_LANGUAGE_ADAPTERS.some((candidate) => candidate.supports(pathValue)))
        incomplete = true;
      incomplete = true;
      continue;
    }
    if (fileSize > CODE_SCAN_LIMITS.maxFileBytes) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "file_size_limit",
        size: fileSize,
      });
      incomplete = true;
      continue;
    }
    if (bytesAnalyzed + fileSize > CODE_SCAN_LIMITS.maxRepositoryBytes) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "repository_byte_limit",
        size: fileSize,
      });
      incomplete = true;
      continue;
    }

    if (astBudgetReached) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "ast_node_limit",
        size: fileSize,
      });
      incomplete = true;
      continue;
    }

    if (!adapter) continue;
    let source: ts.SourceFile;
    try {
      source = adapter.parse(pathValue, original.text);
    } catch {
      parseFailures += 1;
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: "parse_failed",
        size: fileSize,
      });
      incomplete = true;
      continue;
    }
    const parseDiagnostics = (
      source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }
    ).parseDiagnostics;
    const fileEntity = addEntity(entities, {
      entityType: "file",
      name: pathValue.split("/").at(-1)!.slice(0, 240),
      language,
      path: pathValue.slice(0, 1024),
      startLine: 1,
      startColumn: 1,
      endLine: source.getLineAndCharacterOfPosition(source.end).line + 1,
      endColumn: null,
      extractorType: "typescript-compiler-api:file-v1",
      confidenceClass: "exact",
    });
    const moduleEntity = addEntity(entities, {
      entityType: "module",
      name: pathValue.replace(/\.[^.]+$/, "").slice(0, 240),
      language,
      path: pathValue.slice(0, 1024),
      startLine: 1,
      startColumn: 1,
      endLine: source.getLineAndCharacterOfPosition(source.end).line + 1,
      endColumn: null,
      extractorType: "typescript-compiler-api:module-v1",
      confidenceClass: "structural",
    });
    addRelation(relations, {
      fromEntityKey: fileEntity,
      toEntityKey: moduleEntity,
      relationType: "FILE_CONTAINS_SYMBOL",
      confidenceClass: "structural",
      evidencePath: pathValue,
      evidenceStartLine: 1,
      evidenceStartColumn: 1,
      evidenceEndLine: source.getLineAndCharacterOfPosition(source.end).line + 1,
      evidenceEndColumn: source.getLineAndCharacterOfPosition(source.end).character + 1,
      extractorType: "typescript-compiler-api:module-containment-v2",
    });
    const importOrigins = new Map<string, { packageName: string; path: string }>();
    const importEntities: Array<{
      key: string;
      packageEntity: string | null;
      startLine: number;
      startColumn: number;
      endLine: number;
      endColumn: number;
    }> = [];
    const callNodes: Array<{ node: ts.CallExpression; owner: string }> = [];
    const envNodes: Array<{ node: ts.Node; name: string }> = [];
    const eventNodes: Array<{ node: ts.StringLiteralLike; evidenceNode: ts.Node; value: string }> =
      [];
    const endpointNodes: Array<{ node: ts.CallExpression; value: string | null }> = [];
    const schemaNodes: Array<{ node: ts.TypeReferenceNode; value: string }> = [];

    const registerImport = (spec: string, localNames: string[], evidenceNode: ts.Node) => {
      const root = packageRoot(spec);
      if (!root || !SAFE_IMPORT_SPECIFIER.test(spec) || looksSecret(spec)) return;
      const importLocation = sourceLocation(source, evidenceNode);
      const importSubpath = spec.startsWith(root)
        ? spec.slice(root.length).replace(/^\/+/, "").replaceAll("/", ".")
        : "";
      const importKey = addEntity(entities, {
        entityType: "import",
        name: spec.slice(0, 240),
        language,
        path: pathValue.slice(0, 1024),
        startLine: null,
        startColumn: null,
        endLine: null,
        endColumn: null,
        extractorType: "typescript-compiler-api:import-v1",
        confidenceClass: "exact",
      });
      const packageKey = addEntity(entities, {
        entityType: "package_dependency",
        name: root,
        language,
        path: pathValue.slice(0, 1024),
        startLine: null,
        startColumn: null,
        endLine: null,
        endColumn: null,
        extractorType: "typescript-compiler-api:package-import-v1",
        confidenceClass: "exact",
      });
      addRelation(relations, {
        fromEntityKey: importKey,
        toEntityKey: packageKey,
        relationType: "IMPORTS_PACKAGE",
        confidenceClass: "exact",
        evidencePath: pathValue,
        evidenceStartLine: importLocation.startLine,
        evidenceStartColumn: importLocation.startColumn,
        evidenceEndLine: importLocation.endLine,
        evidenceEndColumn: importLocation.endColumn,
        extractorType: "typescript-compiler-api:import-relation-v2",
      });
      importEntities.push({
        key: importKey,
        packageEntity: packageKey,
        startLine: importLocation.startLine,
        startColumn: importLocation.startColumn,
        endLine: importLocation.endLine,
        endColumn: importLocation.endColumn,
      });
      for (const local of localNames) {
        importOrigins.set(local, { packageName: root, path: importSubpath });
        const symbolKey = addEntity(entities, {
          entityType: "import",
          name: `${root}#${local}`.slice(0, 240),
          language,
          path: pathValue.slice(0, 1024),
          startLine: null,
          startColumn: null,
          endLine: null,
          endColumn: null,
          extractorType: "typescript-compiler-api:imported-symbol-v1",
          confidenceClass: "exact",
        });
        addRelation(relations, {
          fromEntityKey: importKey,
          toEntityKey: symbolKey,
          relationType: "IMPORTS_SYMBOL",
          confidenceClass: "exact",
          evidencePath: pathValue,
          evidenceStartLine: importLocation.startLine,
          evidenceStartColumn: importLocation.startColumn,
          evidenceEndLine: importLocation.endLine,
          evidenceEndColumn: importLocation.endColumn,
          extractorType: "typescript-compiler-api:imported-symbol-relation-v2",
        });
      }
      return root;
    };

    const walk = (root: ts.Node, rootOwner: string) => {
      const stack: Array<{ node: ts.Node; owner: string; depth: number }> = [
        { node: root, owner: rootOwner, depth: 0 },
      ];
      while (stack.length > 0 && !astBudgetReached) {
        const frame = stack.pop()!;
        const { node, depth } = frame;
        if (depth > CODE_SCAN_LIMITS.maxAstDepth) {
          astBudgetReached = true;
          astBudgetReason = "ast_depth_limit";
          break;
        }
        astNodesVisited += 1;
        if (astNodesVisited > CODE_SCAN_LIMITS.maxAstNodes) {
          astBudgetReached = true;
          astBudgetReason = "ast_node_limit";
          break;
        }
        const declared = functionName(node);
        let owner = frame.owner;
        if (declared) {
          const kind: EntityType = ts.isClassDeclaration(node)
            ? "class"
            : ts.isMethodDeclaration(node)
              ? "method"
              : "function";
          const loc = sourceLocation(source, node);
          owner = addEntity(entities, {
            entityType: kind,
            name: declared.slice(0, 240),
            language,
            path: pathValue.slice(0, 1024),
            ...loc,
            extractorType: "typescript-compiler-api:symbol-v1",
            confidenceClass: "structural",
          });
          addRelation(relations, {
            fromEntityKey: fileEntity,
            toEntityKey: owner,
            relationType: "FILE_CONTAINS_SYMBOL",
            confidenceClass: "structural",
            evidencePath: pathValue,
            evidenceStartLine: loc.startLine,
            evidenceStartColumn: loc.startColumn,
            evidenceEndLine: loc.endLine,
            evidenceEndColumn: loc.endColumn,
            extractorType: "typescript-compiler-api:containment-v2",
          });
          const symbolKey = `${pathValue}:${declared}`;
          const matches = symbolEntities.get(symbolKey);
          if (matches) matches.push(owner);
          else symbolEntities.set(symbolKey, [owner]);
        }

        if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
          const clause = node.importClause;
          const names = clause
            ? [
                ...(clause.name ? [clause.name.text] : []),
                ...(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
                  ? [clause.namedBindings.name.text]
                  : clause.namedBindings && ts.isNamedImports(clause.namedBindings)
                    ? clause.namedBindings.elements.map((item) => item.name.text)
                    : []),
              ]
            : [];
          registerImport(node.moduleSpecifier.text, names, node);
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "require" &&
          node.initializer.arguments[0] &&
          ts.isStringLiteralLike(node.initializer.arguments[0])
        ) {
          registerImport(node.initializer.arguments[0].text, [node.name.text], node);
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer &&
          ts.isCallExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          node.initializer.expression.text === "require" &&
          node.initializer.arguments[0] &&
          ts.isStringLiteralLike(node.initializer.arguments[0])
        ) {
          const specifier = node.initializer.arguments[0].text;
          const locals = node.name.elements.flatMap((element) =>
            ts.isIdentifier(element.name) ? [element.name.text] : [],
          );
          const root = registerImport(specifier, locals, node);
          if (root) {
            const importSubpath = specifier.startsWith(root)
              ? specifier.slice(root.length).replace(/^\/+/, "").replaceAll("/", ".")
              : "";
            for (const element of node.name.elements) {
              if (!ts.isIdentifier(element.name)) continue;
              const imported = element.propertyName ?? element.name;
              const importedName = ts.isIdentifier(imported) ? imported.text : null;
              if (importedName) {
                importOrigins.set(element.name.text, {
                  packageName: root,
                  path: [importSubpath, importedName].filter(Boolean).join("."),
                });
              }
            }
          }
        }
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
          if (
            ts.isNewExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression)
          ) {
            const origin = importOrigins.get(node.initializer.expression.text);
            if (origin)
              importOrigins.set(node.name.text, { packageName: origin.packageName, path: "" });
          } else {
            const chain = memberChain(node.initializer);
            const origin = chain && importOrigins.get(chain.root);
            if (origin)
              importOrigins.set(node.name.text, {
                packageName: origin.packageName,
                path: [...origin.path, ...chain.path].join("."),
              });
          }
        }
        if (ts.isCallExpression(node)) {
          defer(callNodes, { node, owner });
          if (ts.isIdentifier(node.expression) && !importOrigins.has(node.expression.text)) {
            const loc = sourceLocation(source, node);
            defer(unresolvedCalls, {
              owner,
              callee: node.expression.text,
              path: pathValue,
              startLine: loc.startLine,
              startColumn: loc.startColumn,
              endLine: loc.endLine,
              endColumn: loc.endColumn,
            });
          }
          const callable = memberChain(node.expression);
          const origin = callable ? importOrigins.get(callable.root) : undefined;
          const isRecognizedHttpCall = Boolean(
            callable &&
            ((callable.root === "fetch" && callable.path.length === 0) ||
              (origin &&
                HTTP_CLIENT_PACKAGES.has(origin.packageName) &&
                (callable.path.length === 0 ||
                  HTTP_CLIENT_METHODS.has(callable.path.at(-1) ?? "")))),
          );
          if (isRecognizedHttpCall) {
            const firstArg = node.arguments[0];
            if (firstArg) defer(endpointNodes, { node, value: staticString(firstArg) });
          }
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.expression.getText(source) === "process.env"
        ) {
          defer(envNodes, { node, name: node.name.text });
        }
        if (
          ts.isElementAccessExpression(node) &&
          node.expression.getText(source) === "process.env" &&
          node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression)
        ) {
          defer(envNodes, { node, name: node.argumentExpression.text });
        }
        if (ts.isStringLiteralLike(node)) {
          const evidenceNode = controlledEventString(node);
          if (evidenceNode) defer(eventNodes, { node, evidenceNode, value: node.text });
        }
        if (ts.isTypeReferenceNode(node)) {
          const value = node.typeName.getText(source);
          if (/(?:Schema|Contract|Payload|Event)(?:$|[.<])/.test(value))
            defer(schemaNodes, { node, value });
        }
        const children: ts.Node[] = [];
        ts.forEachChild(node, (child) => {
          children.push(child);
        });
        for (let index = children.length - 1; index >= 0; index -= 1)
          stack.push({ node: children[index]!, owner, depth: depth + 1 });
      }
    };
    walk(source, moduleEntity);

    if (astBudgetReached) {
      skippedFiles.push({
        path: pathValue.slice(0, 1024),
        reason: astBudgetReason,
        size: fileSize,
      });
      incomplete = true;
      continue;
    }
    supportedFilesAnalyzed += 1;

    for (const item of importEntities) {
      if (item.packageEntity) {
        const entity = entities.get(item.key)!;
        addExternal(entities, refs, relations, {
          referenceType: "import",
          normalizedValue: entity.name,
          rawValue: entity.name,
          path: pathValue,
          startLine: item.startLine,
          evidenceStartColumn: item.startColumn,
          endLine: item.endLine,
          evidenceEndColumn: item.endColumn,
          language,
          confidenceClass: "exact",
          extractorType: "typescript-compiler-api:import-reference-v1",
          parentEntityKey: fileEntity,
        });
      }
    }

    for (const env of envNodes) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env.name)) continue;
      const loc = sourceLocation(source, env.node);
      addExternal(entities, refs, relations, {
        referenceType: "environment_variable",
        normalizedValue: env.name,
        path: pathValue,
        startLine: loc.startLine,
        evidenceStartColumn: loc.startColumn,
        endLine: loc.endLine,
        evidenceEndColumn: loc.endColumn,
        language,
        confidenceClass: "exact",
        extractorType: "typescript-compiler-api:process-env-v1",
        parentEntityKey: fileEntity,
      });
    }

    for (const event of eventNodes) {
      if (!/^[A-Za-z0-9_.:-]{3,160}$/.test(event.value)) continue;
      const loc = sourceLocation(source, event.node);
      const evidenceLoc = sourceLocation(source, event.evidenceNode);
      addExternal(entities, refs, relations, {
        referenceType: "event",
        normalizedValue: event.value,
        rawValue: event.value,
        path: pathValue,
        startLine: loc.startLine,
        referenceStartColumn: loc.startColumn,
        evidenceStartLine: evidenceLoc.startLine,
        evidenceStartColumn: evidenceLoc.startColumn,
        endLine: loc.endLine,
        referenceEndColumn: loc.endColumn,
        evidenceEndLine: evidenceLoc.endLine,
        evidenceEndColumn: evidenceLoc.endColumn,
        language,
        confidenceClass: "structural",
        extractorType: "typescript-compiler-api:event-control-flow-v2",
        parentEntityKey: fileEntity,
      });
    }

    for (const schema of schemaNodes) {
      if (!/^[A-Za-z_$][A-Za-z0-9_$.]{0,159}$/.test(schema.value)) continue;
      const loc = sourceLocation(source, schema.node);
      addExternal(entities, refs, relations, {
        referenceType: "schema",
        normalizedValue: schema.value,
        rawValue: schema.value,
        path: pathValue,
        startLine: loc.startLine,
        evidenceStartColumn: loc.startColumn,
        endLine: loc.endLine,
        evidenceEndColumn: loc.endColumn,
        language,
        confidenceClass: "structural",
        extractorType: `${adapter?.id}:schema-reference-v1`,
        parentEntityKey: fileEntity,
      });
    }

    for (const { node: call, owner: callOwner } of callNodes) {
      const chain = memberChain(call.expression);
      if (!chain) continue;
      const origin = importOrigins.get(chain.root);
      if (!origin || chain.path.length === 0) continue;
      const member = [...origin.path.split(".").filter(Boolean), ...chain.path].join(".");
      if (!member) continue;
      const loc = sourceLocation(source, call);
      addExternal(entities, refs, relations, {
        referenceType: "sdk_call",
        normalizedValue: `${origin.packageName}.${member}`,
        path: pathValue,
        startLine: loc.startLine,
        evidenceStartColumn: loc.startColumn,
        endLine: loc.endLine,
        evidenceEndColumn: loc.endColumn,
        language,
        confidenceClass: "structural",
        extractorType: "typescript-compiler-api:sdk-call-v1",
        parentEntityKey: callOwner,
      });
    }

    for (const endpoint of endpointNodes) {
      const loc = sourceLocation(source, endpoint.node);
      const resolved = endpoint.value ? endpointValue(endpoint.value) : null;
      addExternal(entities, refs, relations, {
        referenceType: resolved ? "endpoint" : "dynamic_endpoint",
        normalizedValue: resolved?.value ?? "[dynamic]",
        rawValue: endpoint.value ?? undefined,
        forceRedact: resolved?.redacted,
        path: pathValue,
        startLine: loc.startLine,
        evidenceStartColumn: loc.startColumn,
        endLine: loc.endLine,
        evidenceEndColumn: loc.endColumn,
        language,
        confidenceClass: resolved ? "exact" : "heuristic",
        extractorType: "typescript-compiler-api:http-call-v1",
        parentEntityKey: fileEntity,
      });
    }

    for (const diagnostic of parseDiagnostics) {
      if (diagnostic.category === ts.DiagnosticCategory.Error) parseFailures += 1;
    }
    if (
      parseDiagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    ) {
      skippedFiles.push({ path: pathValue.slice(0, 1024), reason: "parse_failed", size: fileSize });
      incomplete = true;
    }
    bytesAnalyzed += fileSize;
    filesAnalyzed += 1;
  }

  incomplete = parseManifest(files, entities, refs, skippedFiles) || incomplete;
  for (const call of unresolvedCalls) {
    const target = symbolEntities.get(`${call.path}:${call.callee}`) ?? [];
    if (target.length === 1) {
      addRelation(relations, {
        fromEntityKey: call.owner,
        toEntityKey: target[0]!,
        relationType: "CALLS_SYMBOL",
        confidenceClass: "heuristic",
        evidencePath: call.path,
        evidenceStartLine: call.startLine,
        evidenceStartColumn: call.startColumn,
        evidenceEndLine: call.endLine,
        evidenceEndColumn: call.endColumn,
        extractorType: "typescript-compiler-api:same-file-call-site-v2",
      });
    }
  }

  const noSupportedSource =
    files.length === 0 || (codeCandidates.length === 0 && unsupportedCount === 0);
  if (noSupportedSource) {
    skippedFiles.push({
      path: "[repository]",
      reason: files.length === 0 ? "empty_repository" : "no_supported_source_files",
      size: 0,
    });
  }
  const coverageState: CoverageState = incomplete
    ? "partial"
    : filesAnalyzed === 0 && (unsupportedCount > 0 || noSupportedSource)
      ? "unsupported"
      : "complete";
  const entityList = [...entities.values()].sort((a, b) => stableCompare(a.entityKey, b.entityKey));
  const relationList = [...relations.values()].sort((a, b) =>
    stableCompare(
      tupleKey(
        a.fromEntityKey,
        a.toEntityKey,
        a.relationType,
        a.evidencePath,
        a.evidenceStartLine,
        a.evidenceStartColumn,
        a.evidenceEndLine,
        a.evidenceEndColumn,
      ),
      tupleKey(
        b.fromEntityKey,
        b.toEntityKey,
        b.relationType,
        b.evidencePath,
        b.evidenceStartLine,
        b.evidenceStartColumn,
        b.evidenceEndLine,
        b.evidenceEndColumn,
      ),
    ),
  );
  const referenceList = [...refs.values()].sort((a, b) =>
    stableCompare(
      tupleKey(a.referenceType, a.normalizedValue, a.path, a.startLine),
      tupleKey(b.referenceType, b.normalizedValue, b.path, b.startLine),
    ),
  );
  const coverageReasonCounts = Object.fromEntries(
    [...new Set(skippedFiles.map((file) => file.reason))]
      .sort(stableCompare)
      .map((reason) => [reason, skippedFiles.filter((file) => file.reason === reason).length]),
  );
  const supportedFilesSkippedByBound = skippedFiles.filter(
    (file) =>
      BOUND_SKIP_REASONS.has(file.reason) &&
      CODE_LANGUAGE_ADAPTERS.some((adapter) => adapter.supports(file.path)),
  ).length;
  return {
    coverageState,
    filesDiscovered: files.length,
    filesAnalyzed,
    filesSkipped: skippedFiles.length,
    parseFailures,
    bytesAnalyzed,
    supportedFilesDiscovered: codeCandidates.length,
    supportedFilesAnalyzed,
    supportedFilesSkippedByBound,
    unsupportedLanguageFiles,
    coverageReasonCounts,
    entities: entityList,
    relations: relationList,
    externalReferences: referenceList,
    skippedFiles,
  };
}

export function shouldAnalyzeRouteTarget(target: string) {
  return SUPPORTED_ROUTE_TARGETS.has(target);
}

export function isExactCommitSha(value: string) {
  return /^[a-f0-9]{40,64}$/.test(value);
}

export function createCodeAnalysisIdempotencyKey(input: {
  repositoryId: string;
  commitSha: string;
  analyzerVersion?: string;
  analysisProfile?: string;
}) {
  if (!isExactCommitSha(input.commitSha)) throw new Error("code_analysis_commit_sha_invalid");
  return digest(
    [
      input.repositoryId,
      input.commitSha,
      input.analyzerVersion ?? CODE_INTELLIGENCE_VERSION,
      input.analysisProfile ?? CODE_INTELLIGENCE_PROFILE,
    ].join(":"),
  );
}
