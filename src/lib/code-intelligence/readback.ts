import type { CoverageState } from "@/lib/code-intelligence/analyzer";
import ts from "typescript";

export const CODE_ANALYSIS_READBACK_WORKSPACE = "e140d48e-9dc0-4552-a9a4-a81fe3872422";
export const CODE_ANALYSIS_READBACK_REPOSITORY = "3b4f4fe6-cbbd-4bbd-a340-71f7c268e2c4";
export const CODE_ANALYSIS_READBACK_PRODUCT = "de1f2a12-de3c-4644-8892-b6c2d458a300";

export const EXTERNAL_REFERENCE_TYPES = [
  "package",
  "import",
  "sdk_call",
  "event",
  "endpoint",
  "dynamic_endpoint",
  "environment_variable",
  "schema",
] as const;

export const RELATION_TYPES = [
  "FILE_CONTAINS_SYMBOL",
  "IMPORTS_PACKAGE",
  "IMPORTS_SYMBOL",
  "CALLS_SYMBOL",
  "REFERENCES_EXTERNAL",
  "USES_ENV_NAME",
  "HANDLES_EVENT",
  "CALLS_ENDPOINT",
  "REFERENCES_SCHEMA",
] as const;

export function isSafeReadbackPath(value: string) {
  const safePathSegment =
    process.platform === "win32" ? /^[A-Za-z0-9_@.\-\[\]]+$/ : /^[A-Za-z0-9_@.:\-\[\]]+$/;
  return (
    value.length > 0 &&
    value.length <= 1024 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !/^[A-Za-z]:/.test(value) &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".." && safePathSegment.test(part))
  );
}

function resemblesCredential(value: string) {
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/i.test(
      value,
    ) ||
    /\bBearer\s+\S+/i.test(value) ||
    /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(value)
  )
    return true;
  const trimmed = value.trim();
  if (trimmed.length < 28 || !/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;
  const alphabet = new Set(trimmed).size;
  return alphabet >= 16 && alphabet / trimmed.length > 0.45;
}

export function persistedCredentialLikeValueCount(values: string[]) {
  return values.filter(resemblesCredential).length;
}

export type PackageLockSnapshot = { path: string; source: string };

function resolvedPackageVersion(name: string, lockfiles: readonly PackageLockSnapshot[]) {
  const packageLock = lockfiles.find((file) => file.path === "package-lock.json");
  if (packageLock) {
    try {
      const parsed: unknown = JSON.parse(packageLock.source);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const packages = (parsed as Record<string, unknown>).packages;
      if (!packages || typeof packages !== "object" || Array.isArray(packages)) return undefined;
      const entry = (packages as Record<string, unknown>)[`node_modules/${name}`];
      return entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).version
        : undefined;
    } catch {
      return undefined;
    }
  }

  const pnpmLock = lockfiles.find((file) => file.path === "pnpm-lock.yaml");
  if (pnpmLock) {
    let current = "";
    for (const line of pnpmLock.source.split(/\r?\n/).slice(0, 100_000)) {
      if (/^  \/?[^\s:]+@[^\s:]+:\s*$/.test(line)) {
        current = line.trim().replace(/^\//, "").replace(/:$/, "");
        continue;
      }
      if (current && /^    version:\s*["']?[^\s"']+/.test(line)) {
        const version = /^    version:\s*["']?([^\s"']+)/.exec(line)?.[1];
        const separator = current.lastIndexOf("@");
        if (version && separator > 0 && current.slice(0, separator) === name) return version;
        current = "";
      }
    }
    return undefined;
  }

  const yarnLock = lockfiles.find((file) => file.path === "yarn.lock");
  if (yarnLock) {
    let selectors: string[] = [];
    for (const line of yarnLock.source.split(/\r?\n/).slice(0, 100_000)) {
      if (!line.startsWith(" ") && line.endsWith(":")) {
        selectors = line
          .slice(0, -1)
          .split(/,\s*/)
          .map((item) => item.replace(/^"|"$/g, ""));
        continue;
      }
      if (selectors.length && /^  version\s+"?([^"\s]+)"?/.test(line)) {
        const version = /^  version\s+"?([^"\s]+)"?/.exec(line)?.[1];
        const resolved = selectors.some((selector) => {
          const separator = selector.lastIndexOf("@");
          return separator > 0 && selector.slice(0, separator) === name;
        });
        if (resolved) return version;
        selectors = [];
      }
    }
  }
  return undefined;
}

function packageFactMatchesManifest(
  normalizedValue: string,
  source: string,
  lockfiles: readonly PackageLockSnapshot[],
) {
  const delimiter = normalizedValue.lastIndexOf("@");
  if (delimiter <= 0) return false;
  const name = normalizedValue.slice(0, delimiter);
  const manifestValue = normalizedValue.slice(delimiter + 1);
  try {
    const manifest: unknown = JSON.parse(source);
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    const sections = [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const;
    const declared = sections
      .map((section) => (manifest as Record<string, unknown>)[section])
      .map((value) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)[name]
          : undefined,
      )
      .find((value): value is string => typeof value === "string");
    if (!declared) return false;
    const resolved = resolvedPackageVersion(name, lockfiles);
    return manifestValue === (typeof resolved === "string" ? resolved : declared);
  } catch {
    return false;
  }
}

export function safeReadbackValue(type: string, value: string): string | null {
  if (!value || value.length > 512 || resemblesCredential(value)) return null;
  switch (type) {
    case "package":
      return /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+@[~^<>=*xX0-9A-Za-z.+|:, -]{1,80}$/.test(value)
        ? value
        : null;
    case "import":
      return /^[A-Za-z0-9@._/-]{1,240}$/.test(value) ? value : null;
    case "sdk_call":
      return /^[A-Za-z0-9@._/$-]+(?:\.[A-Za-z0-9_$-]+)+$/.test(value) ? value : null;
    case "event":
      return /^[A-Za-z0-9_.:-]{3,160}$/.test(value) ? value : null;
    case "endpoint": {
      try {
        const url = new URL(value);
        if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password)
          return null;
        return `${url.origin}${url.pathname}`.slice(0, 512);
      } catch {
        return null;
      }
    }
    case "dynamic_endpoint":
      return value === "[dynamic]" ? value : null;
    case "environment_variable":
      return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) ? value : null;
    case "schema":
      return /^[A-Za-z_$][A-Za-z0-9_$.]{0,159}$/.test(value) ? value : null;
    default:
      return null;
  }
}

export function safeSourceSpanMatch(
  referenceType: string,
  normalizedValue: string,
  path: string,
  source: string,
  startLine: number,
  endLine: number,
  lockfiles: readonly PackageLockSnapshot[] = [],
) {
  if (
    !isSafeReadbackPath(path) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine - startLine > 100
  )
    return false;
  const lines = source.split(/\r?\n/);
  const span = lines.slice(startLine - 1, endLine).join("\n");
  if (!span) return false;
  switch (referenceType) {
    case "package":
      if (path !== "package.json") return false;
      return packageFactMatchesManifest(normalizedValue, source, lockfiles);
    case "import":
      return source.includes(normalizedValue);
    case "sdk_call": {
      const memberPath = normalizedValue.split(".").slice(1).join(".");
      return Boolean(memberPath) && span.includes(memberPath);
    }
    case "event":
      return span.includes(normalizedValue);
    case "endpoint": {
      try {
        const url = new URL(normalizedValue);
        return span.includes(url.hostname) || span.includes(url.pathname);
      } catch {
        return false;
      }
    }
    case "dynamic_endpoint":
      return /\bfetch\s*\(|\baxios\s*\(|\.request\s*\(/.test(span);
    case "environment_variable":
      return new RegExp(
        `process\\s*\\.\\s*env\\s*(?:\\.\\s*${normalizedValue}\\b|\\[\\s*[\"']${normalizedValue}[\"']\\s*\\])`,
      ).test(span);
    case "schema":
      return span.includes(normalizedValue.split(".").at(-1) ?? normalizedValue);
    default:
      return false;
  }
}

export type RelationProvenanceEntity = {
  entity_type: string;
  name: string;
  path: string;
  start_line: number | null;
  end_line: number | null;
};

function targetDeclarationMatchesSource(input: {
  path: string;
  source: string;
  entityType: string;
  name: string;
  startLine: number;
  endLine: number;
}) {
  const { path, source, entityType, name, startLine, endLine } = input;
  const scriptKind = /\.tsx$/i.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx?$/i.test(path) || /\.[cm]js$/i.test(path)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const stack: ts.Node[] = [parsed];
  while (stack.length > 0) {
    const node = stack.pop()!;
    const nodeStartLine = parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1;
    const nodeEndLine = parsed.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    if (nodeStartLine === startLine && nodeEndLine === endLine) {
      if (entityType === "class" && ts.isClassDeclaration(node) && node.name?.text === name)
        return true;
      if (
        entityType === "method" &&
        ts.isMethodDeclaration(node) &&
        node.name.getText(parsed) === name
      )
        return true;
      if (
        entityType === "function" &&
        ((ts.isFunctionDeclaration(node) && node.name?.text === name) ||
          ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
            ts.isVariableDeclaration(node.parent) &&
            ts.isIdentifier(node.parent.name) &&
            node.parent.name.text === name))
      )
        return true;
    }
    node.forEachChild((child) => {
      stack.push(child);
    });
  }
  return false;
}

export function relationEvidenceMatchesSource(input: {
  relationType: string;
  path: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  extractorType: string;
  from: RelationProvenanceEntity;
  to: RelationProvenanceEntity;
  matchingTargetDeclarations: number;
  source: string;
  matchingExternalReference: {
    referenceType: string;
    normalizedValue: string;
    redacted: boolean;
    startColumn?: number | null;
    endColumn?: number | null;
  } | null;
}) {
  const {
    relationType,
    path,
    startLine,
    startColumn,
    endLine,
    endColumn,
    extractorType,
    from,
    to,
    source,
  } = input;
  if (
    !isSafeReadbackPath(path) ||
    startLine < 1 ||
    startColumn < 1 ||
    endLine < startLine ||
    endColumn < 1 ||
    endLine - startLine > 200 ||
    from.path !== path ||
    to.path !== path
  )
    return false;
  const scriptKind = /\.tsx?$/i.test(path)
    ? /\.tsx$/i.test(path)
      ? ts.ScriptKind.TSX
      : ts.ScriptKind.TS
    : /\.jsx?$/i.test(path) || /\.[cm]js$/i.test(path)
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const lines = source.split(/\r?\n/);
  if (endLine > lines.length || startColumn > (lines[startLine - 1]?.length ?? 0) + 1) return false;
  if (endColumn > (lines[endLine - 1]?.length ?? 0) + 1) return false;
  const start = parsed.getPositionOfLineAndCharacter(startLine - 1, startColumn - 1);
  const end = parsed.getPositionOfLineAndCharacter(endLine - 1, endColumn - 1);
  if (end <= start || end > source.length) return false;
  const exactNodes: ts.Node[] = [];
  const stack: ts.Node[] = [parsed];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.getStart(parsed) === start && node.getEnd() === end) exactNodes.push(node);
    node.forEachChild((child) => {
      stack.push(child);
    });
  }
  const span = source.slice(start, end);
  const matchingReference = input.matchingExternalReference;
  const staticStringValue = (node: ts.Expression): string | null => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return staticStringValue(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticStringValue(node.left);
      const right = staticStringValue(node.right);
      return left === null || right === null ? null : left + right;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const part of node.templateSpans) {
        if (
          !ts.isStringLiteralLike(part.expression) &&
          !ts.isNoSubstitutionTemplateLiteral(part.expression)
        )
          return null;
        value += part.expression.text + part.literal.text;
      }
      return value;
    }
    return null;
  };
  const normalizedEndpoint = (raw: string) => {
    try {
      const value = new URL(raw);
      if (!["http:", "https:"].includes(value.protocol) || !value.hostname) return null;
      value.username = "";
      value.password = "";
      value.search = "";
      value.hash = "";
      return `${value.protocol}//${value.host.toLowerCase()}${value.pathname}`.slice(0, 512);
    } catch {
      return null;
    }
  };
  const callMemberPath = (expression: ts.Expression) => {
    const parts: string[] = [];
    let current = expression;
    while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      if (ts.isPropertyAccessExpression(current)) {
        parts.unshift(current.name.text);
        current = current.expression;
      } else {
        if (!current.argumentExpression || !ts.isStringLiteralLike(current.argumentExpression))
          return null;
        parts.unshift(current.argumentExpression.text);
        current = current.expression;
      }
    }
    return ts.isIdentifier(current) ? parts.join(".") : null;
  };
  const importOrigins = new Map<string, { packageName: string; path: string }>();
  const nodes: ts.Node[] = [];
  const nodeStack: ts.Node[] = [parsed];
  while (nodeStack.length) {
    const node = nodeStack.pop()!;
    nodes.push(node);
    node.forEachChild((child) => {
      nodeStack.push(child);
    });
  }
  for (const node of nodes) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const packageName = packageRootForReadback(node.moduleSpecifier.text);
      if (!packageName) continue;
      const importSubpath = node.moduleSpecifier.text
        .slice(packageName.length)
        .replace(/^\/+/, "")
        .replaceAll("/", ".");
      const clause = node.importClause;
      if (clause?.name) importOrigins.set(clause.name.text, { packageName, path: importSubpath });
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        importOrigins.set(clause.namedBindings.name.text, { packageName, path: importSubpath });
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const element of clause.namedBindings.elements)
          importOrigins.set(element.name.text, { packageName, path: importSubpath });
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
      const specifier = node.initializer.arguments[0].text;
      const packageName = packageRootForReadback(specifier);
      if (packageName)
        importOrigins.set(node.name.text, {
          packageName,
          path: specifier.slice(packageName.length).replace(/^\/+/, "").replaceAll("/", "."),
        });
    }
  }
  for (const node of nodes) {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name) || !node.initializer)
      continue;
    if (ts.isNewExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)) {
      const origin = importOrigins.get(node.initializer.expression.text);
      if (origin) importOrigins.set(node.name.text, { packageName: origin.packageName, path: "" });
      continue;
    }
    const chain = callMemberPath(node.initializer);
    if (!chain) continue;
    const root = node.initializer;
    let expression = root;
    while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression))
      expression = expression.expression;
    const origin = ts.isIdentifier(expression) ? importOrigins.get(expression.text) : undefined;
    if (origin)
      importOrigins.set(node.name.text, {
        packageName: origin.packageName,
        path: [origin.path, chain].filter(Boolean).join("."),
      });
  }
  const isEventDiscriminator = (node: ts.Node) =>
    /(?:^|\.)event\w*\.type$|\.type$|^type$/.test(node.getText(parsed));
  const importsModule = (node: ts.Node, packageName: string) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier))
      return packageRootForReadback(node.moduleSpecifier.text) === packageName;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
    ) {
      const callee = node.initializer.expression;
      const argument = node.initializer.arguments[0];
      return (
        ts.isIdentifier(callee) &&
        callee.text === "require" &&
        argument !== undefined &&
        ts.isStringLiteralLike(argument) &&
        packageRootForReadback(argument.text) === packageName
      );
    }
    return false;
  };
  switch (relationType) {
    case "FILE_CONTAINS_SYMBOL": {
      if (from.entity_type !== "file") return false;
      if (to.entity_type === "module")
        return (
          to.name === path.replace(/\.[^.]+$/, "") &&
          startLine === 1 &&
          startColumn === 1 &&
          end === source.length
        );
      return (
        exactNodes.some(
          (node) =>
            (ts.isFunctionDeclaration(node) && node.name?.text === to.name) ||
            (ts.isClassDeclaration(node) && node.name?.text === to.name) ||
            (ts.isMethodDeclaration(node) && node.name.getText(parsed) === to.name) ||
            (ts.isArrowFunction(node) &&
              ts.isVariableDeclaration(node.parent) &&
              ts.isIdentifier(node.parent.name) &&
              node.parent.name.text === to.name),
        ) &&
        to.start_line !== null &&
        to.end_line !== null &&
        to.start_line >= startLine &&
        to.end_line <= endLine &&
        span.length > 0
      );
    }
    case "IMPORTS_PACKAGE": {
      const delimiter = to.name.lastIndexOf("@");
      const packageName = delimiter > 0 ? to.name.slice(0, delimiter) : to.name;
      if (from.entity_type === "import" && to.entity_type === "package_dependency")
        return Boolean(packageName) && exactNodes.some((node) => importsModule(node, packageName));
      if (from.entity_type === "file" && to.entity_type === "schema_reference")
        return Boolean(
          extractorType === "typescript-compiler-api:import-reference-v1" &&
          matchingReference?.referenceType === "import" &&
          matchingReference.normalizedValue === to.name &&
          packageRootForReadback(to.name) &&
          exactNodes.some((node) => importsModule(node, packageRootForReadback(to.name)!)),
        );
      return false;
    }
    case "IMPORTS_SYMBOL": {
      const symbol = to.name.split("#").at(-1) ?? "";
      const packageName = to.name.slice(0, to.name.lastIndexOf("#"));
      return (
        from.entity_type === "import" &&
        to.entity_type === "import" &&
        from.name.length > 0 &&
        packageRootForReadback(from.name) === packageName &&
        Boolean(symbol) &&
        exactNodes.some((node) => {
          if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            return Boolean(
              ts.isStringLiteralLike(node.moduleSpecifier) &&
              node.moduleSpecifier.text === from.name &&
              clause &&
              (clause.name?.text === symbol ||
                (clause.namedBindings &&
                  ts.isNamespaceImport(clause.namedBindings) &&
                  clause.namedBindings.name.text === symbol) ||
                (clause.namedBindings &&
                  ts.isNamedImports(clause.namedBindings) &&
                  clause.namedBindings.elements.some((element) => element.name.text === symbol))),
            );
          }
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === "require" &&
            node.initializer.arguments[0] &&
            ts.isStringLiteralLike(node.initializer.arguments[0]) &&
            node.initializer.arguments[0].text === from.name &&
            ts.isIdentifier(node.name)
          )
            return node.name.text === symbol;
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer &&
            ts.isCallExpression(node.initializer) &&
            ts.isIdentifier(node.initializer.expression) &&
            node.initializer.expression.text === "require" &&
            node.initializer.arguments[0] &&
            ts.isStringLiteralLike(node.initializer.arguments[0]) &&
            node.initializer.arguments[0].text === from.name &&
            ts.isObjectBindingPattern(node.name)
          )
            return node.name.elements.some(
              (element) => ts.isIdentifier(element.name) && element.name.text === symbol,
            );
          return false;
        })
      );
    }
    case "CALLS_SYMBOL": {
      if (
        from.path !== to.path ||
        !to.name ||
        !["function", "method", "class"].includes(to.entity_type) ||
        !["file", "module", "function", "method", "class"].includes(from.entity_type) ||
        input.matchingTargetDeclarations !== 1 ||
        from.start_line === null ||
        from.end_line === null ||
        to.start_line === null ||
        to.end_line === null ||
        from.start_line > startLine ||
        from.end_line < endLine ||
        extractorType !== "typescript-compiler-api:same-file-call-site-v2"
      )
        return false;
      return (
        targetDeclarationMatchesSource({
          path,
          source,
          entityType: to.entity_type,
          name: to.name,
          startLine: to.start_line,
          endLine: to.end_line,
        }) &&
        exactNodes.some(
          (node) =>
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === to.name,
        )
      );
    }
    case "REFERENCES_EXTERNAL":
      return Boolean(
        matchingReference &&
        matchingReference.referenceType === "sdk_call" &&
        matchingReference.normalizedValue === to.name &&
        exactNodes.some((node) => {
          if (!ts.isCallExpression(node)) return false;
          const memberPath = callMemberPath(node.expression);
          if (!memberPath) return false;
          let root = node.expression;
          while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))
            root = root.expression;
          if (!ts.isIdentifier(root)) return false;
          const origin = importOrigins.get(root.text);
          if (!origin) return false;
          const fullPath = [origin.path, memberPath].filter(Boolean).join(".");
          return `${origin.packageName}.${fullPath}` === to.name;
        }),
      );
    case "USES_ENV_NAME":
      return exactNodes.some(
        (node) =>
          (ts.isPropertyAccessExpression(node) &&
            node.expression.getText(parsed) === "process.env" &&
            node.name.text === to.name) ||
          (ts.isElementAccessExpression(node) &&
            node.expression.getText(parsed) === "process.env" &&
            node.argumentExpression &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            node.argumentExpression.text === to.name),
      );
    case "HANDLES_EVENT":
      return Boolean(
        matchingReference &&
        matchingReference.referenceType === "event" &&
        matchingReference.normalizedValue === to.name &&
        exactNodes.some((node) => {
          if (ts.isBinaryExpression(node)) {
            const other = ts.isStringLiteralLike(node.left) ? node.right : node.left;
            return (
              [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
                node.operatorToken.kind,
              ) &&
              isEventDiscriminator(other) &&
              [node.left, node.right].some(
                (part) => ts.isStringLiteralLike(part) && part.text === to.name,
              )
            );
          }
          if (ts.isCaseClause(node)) {
            const switchStatement = node.parent.parent;
            return (
              ts.isSwitchStatement(switchStatement) &&
              isEventDiscriminator(switchStatement.expression) &&
              node.expression !== undefined &&
              ts.isStringLiteralLike(node.expression) &&
              node.expression.text === to.name
            );
          }
          return false;
        }),
      );
    case "CALLS_ENDPOINT":
      return Boolean(
        matchingReference &&
        ["endpoint", "dynamic_endpoint"].includes(matchingReference.referenceType) &&
        matchingReference.normalizedValue === to.name &&
        exactNodes.some((node) => {
          if (!ts.isCallExpression(node) || !node.arguments[0]) return false;
          const callableText = node.expression.getText(parsed);
          if (
            !["fetch", "axios", "get", "post", "request"].some(
              (name) => callableText === name || callableText.endsWith(`.${name}`),
            )
          )
            return false;
          if (matchingReference.redacted)
            return (
              matchingReference.normalizedValue === "[redacted]" &&
              matchingReference.startColumn === startColumn &&
              matchingReference.endColumn === endColumn
            );
          const raw = staticStringValue(node.arguments[0]);
          return matchingReference.referenceType === "dynamic_endpoint"
            ? raw === null
            : raw !== null && normalizedEndpoint(raw) === matchingReference.normalizedValue;
        }),
      );
    case "REFERENCES_SCHEMA":
      return Boolean(
        matchingReference &&
        matchingReference.referenceType === "schema" &&
        matchingReference.normalizedValue === to.name &&
        exactNodes.some(
          (node) => ts.isTypeReferenceNode(node) && node.typeName.getText(parsed) === to.name,
        ),
      );
    default:
      return false;
  }
}

export function externalReferenceEvidenceMatchesSource(input: {
  referenceType: string;
  normalizedValue: string;
  redacted: boolean;
  path: string;
  startLine: number;
  startColumn: number | null;
  endLine: number;
  endColumn: number | null;
  extractorType: string;
  source: string;
  lockfiles?: readonly PackageLockSnapshot[];
}) {
  if (input.referenceType === "package")
    return safeSourceSpanMatch(
      input.referenceType,
      input.normalizedValue,
      input.path,
      input.source,
      input.startLine,
      input.endLine,
      input.lockfiles,
    );
  if (input.startColumn === null || input.endColumn === null) return false;
  if (input.referenceType === "event") {
    if (
      !isSafeReadbackPath(input.path) ||
      input.startLine < 1 ||
      input.endLine < input.startLine ||
      input.endLine - input.startLine > 100
    )
      return false;
    const parsed = ts.createSourceFile(
      input.path,
      input.source,
      ts.ScriptTarget.Latest,
      true,
      /\.tsx?$/i.test(input.path) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
    );
    const start = parsed.getPositionOfLineAndCharacter(input.startLine - 1, input.startColumn - 1);
    const end = parsed.getPositionOfLineAndCharacter(input.endLine - 1, input.endColumn - 1);
    if (end <= start || end > input.source.length) return false;
    const stack: ts.Node[] = [parsed];
    while (stack.length) {
      const node = stack.pop()!;
      if (
        node.getStart(parsed) === start &&
        node.getEnd() === end &&
        ts.isStringLiteralLike(node) &&
        node.text === input.normalizedValue
      ) {
        if (ts.isBinaryExpression(node.parent)) {
          const comparison = node.parent;
          const other = comparison.left === node ? comparison.right : comparison.left;
          if (
            [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(
              comparison.operatorToken.kind,
            ) &&
            /(?:^|\.)event\w*\.type$|\.type$|^type$/.test(other.getText(parsed))
          )
            return true;
        }
        if (ts.isCaseClause(node.parent)) {
          const switchStatement = node.parent.parent.parent;
          if (
            ts.isSwitchStatement(switchStatement) &&
            /(?:^|\.)event\w*\.type$|\.type$|^type$/.test(
              switchStatement.expression.getText(parsed),
            )
          )
            return true;
        }
      }
      node.forEachChild((child) => {
        stack.push(child);
      });
    }
    return false;
  }
  const relationType = {
    import: "IMPORTS_PACKAGE",
    sdk_call: "REFERENCES_EXTERNAL",
    event: "HANDLES_EVENT",
    endpoint: "CALLS_ENDPOINT",
    dynamic_endpoint: "CALLS_ENDPOINT",
    environment_variable: "USES_ENV_NAME",
    schema: "REFERENCES_SCHEMA",
  }[input.referenceType];
  const entityType = {
    import: "schema_reference",
    sdk_call: "external_sdk_reference",
    event: "webhook_event_reference",
    endpoint: "http_endpoint_reference",
    dynamic_endpoint: "http_endpoint_reference",
    environment_variable: "environment_variable_name",
    schema: "schema_reference",
  }[input.referenceType];
  if (!relationType || !entityType) return false;
  return relationEvidenceMatchesSource({
    relationType,
    path: input.path,
    startLine: input.startLine,
    startColumn: input.startColumn,
    endLine: input.endLine,
    endColumn: input.endColumn,
    extractorType: input.extractorType,
    from: {
      entity_type: "file",
      name: input.path,
      path: input.path,
      start_line: input.startLine,
      end_line: input.endLine,
    },
    to: {
      entity_type: entityType,
      name: input.normalizedValue,
      path: input.path,
      start_line: input.startLine,
      end_line: input.endLine,
    },
    matchingTargetDeclarations: 0,
    source: input.source,
    matchingExternalReference: {
      referenceType: input.referenceType,
      normalizedValue: input.normalizedValue,
      redacted: input.redacted,
      startColumn: input.startColumn,
      endColumn: input.endColumn,
    },
  });
}

function packageRootForReadback(specifier: string) {
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

export function histogram<T extends Record<string, unknown>>(rows: T[], key: keyof T) {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = row[key];
    if (typeof value === "string") counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function classifySkipReason(reason: string, path: string) {
  const extension = path.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const supported = new Set([".js", ".jsx", ".cjs", ".mjs", ".ts", ".tsx", ".cts", ".mts"]);
  const sourcePath = supported.has(extension);
  if (reason === "environment_file_excluded") return "EXPECTED_SECURITY_SKIP" as const;
  if (reason === "binary_or_non_source") return "EXPECTED_NON_SOURCE_SKIP" as const;
  if (reason === "unsupported_language") return "UNSUPPORTED_LANGUAGE_GAP" as const;
  if (
    reason === "parse_failed" ||
    reason === "manifest_parse_failed" ||
    reason === "invalid_encoding"
  )
    return "PARSE_COVERAGE_GAP" as const;
  if (
    [
      "file_count_limit",
      "parse_time_budget",
      "ast_node_limit",
      "file_size_limit",
      "repository_byte_limit",
      "manifest_size_limit",
      "lockfile_size_limit",
      "traversal_entry_limit",
      "fact_count_limit",
    ].includes(reason)
  )
    return sourcePath
      ? ("SUPPORTED_SOURCE_COVERAGE_GAP" as const)
      : ("RESOURCE_BOUND_COVERAGE_GAP" as const);
  if (reason.startsWith("generated_directory:")) return "OTHER_INCOMPLETE" as const;
  if (reason === "generated_or_minified")
    return sourcePath
      ? ("SUPPORTED_SOURCE_COVERAGE_GAP" as const)
      : ("EXPECTED_NON_SOURCE_SKIP" as const);
  return "OTHER_INCOMPLETE" as const;
}

export function assessPartialCauses(reasons: Array<{ reason: string; path: string }>) {
  const counts = new Map<string, { reason: string; count: number; classification: string }>();
  for (const entry of reasons) {
    const classification = classifySkipReason(entry.reason, entry.path);
    const key = `${entry.reason}\0${classification}`;
    const current = counts.get(key) ?? { reason: entry.reason, count: 0, classification };
    current.count += 1;
    counts.set(key, current);
  }
  const causes = [...counts.values()].sort(
    (a, b) => b.count - a.count || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );
  const sourceBounds = new Set([
    "file_count_limit",
    "parse_time_budget",
    "ast_node_limit",
    "file_size_limit",
    "repository_byte_limit",
    "traversal_entry_limit",
    "fact_count_limit",
  ]);
  return {
    causes,
    partialPrimary: causes[0]?.reason ?? "no persisted skip reason explains partial coverage",
    supportedSourceSkippedByBounds: reasons.filter(
      ({ reason, path }) =>
        sourceBounds.has(reason) &&
        classifySkipReason(reason, path) === "SUPPORTED_SOURCE_COVERAGE_GAP",
    ).length,
    supportedSourceSkipped: reasons.filter(
      ({ reason, path }) =>
        classifySkipReason(reason, path) === "SUPPORTED_SOURCE_COVERAGE_GAP" &&
        !sourceBounds.has(reason),
    ).length,
  };
}

export type PersistedReadbackRun = {
  id: string;
  workspace_id: string;
  repository_id: string;
  product_id: string | null;
  commit_sha: string;
  status: string;
  coverage_state: CoverageState;
  files_discovered: number;
  files_analyzed: number;
  files_skipped: number;
  parse_failures: number;
  bytes_analyzed: number;
  supported_files_discovered: number;
  supported_files_analyzed: number;
  supported_files_skipped_by_bound: number;
  unsupported_language_files: number;
  coverage_reason_counts: Record<string, number>;
  persisted_entity_count: number;
  persisted_relation_count: number;
  persisted_reference_count: number;
  persisted_skip_count: number;
  analyzer_version: string;
  language_profile: string;
  analysis_profile: string;
};
