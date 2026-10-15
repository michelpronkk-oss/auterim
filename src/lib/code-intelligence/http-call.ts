import ts from "typescript";

export const HTTP_CLIENT_PACKAGES = new Set([
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

export const HTTP_CLIENT_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "request",
]);

export type HttpClientOrigin = { packageName: string; path: string; member?: string };
type Binding = { declaration: ts.Node; origin: HttpClientOrigin | null };
export type HttpClientOriginIndex = {
  source: ts.SourceFile;
  scopes: Map<ts.Node, Map<string, Binding>>;
  reassigned: Set<Binding>;
  aliasResolutionTruncated: boolean;
  bindingPatternTruncated: boolean;
};

export function memberChain(node: ts.Expression): { root: string; path: string[] } | null {
  const parts: string[] = [];
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
    } else {
      const argument = current.argumentExpression;
      if (!argument || !ts.isStringLiteralLike(argument)) return null;
      parts.unshift(argument.text);
      current = current.expression;
    }
  }
  return ts.isIdentifier(current) ? { root: current.text, path: parts } : null;
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

function packageOrigin(specifier: string): HttpClientOrigin | null {
  const packageName = packageRoot(specifier);
  if (!packageName || !HTTP_CLIENT_PACKAGES.has(packageName)) return null;
  return {
    packageName,
    path: specifier.slice(packageName.length).replace(/^\/+/, "").replaceAll("/", "."),
  };
}

function bindingNames(name: ts.BindingName, index: HttpClientOriginIndex): string[] {
  const names: string[] = [];
  const pending: ts.BindingName[] = [name];
  let visited = 0;
  while (pending.length) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > 50_000) {
      index.bindingPatternTruncated = true;
      break;
    }
    if (ts.isIdentifier(current)) {
      names.push(current.text);
      continue;
    }
    for (const element of current.elements) {
      if (!ts.isOmittedExpression(element)) pending.push(element.name);
    }
  }
  return names;
}

function isVarDeclaration(node: ts.VariableDeclaration) {
  return (
    ts.isVariableDeclarationList(node.parent) &&
    (node.parent.flags & ts.NodeFlags.BlockScoped) === 0
  );
}

function lexicalScope(node: ts.Node) {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (
      ts.isBlock(current) ||
      ts.isCaseBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isForStatement(current) ||
      ts.isForInStatement(current) ||
      ts.isForOfStatement(current)
    )
      return current;
  }
  return node.getSourceFile();
}

function variableScope(node: ts.VariableDeclaration) {
  if (!isVarDeclaration(node)) return lexicalScope(node.parent);
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (
      ts.isFunctionLike(current) ||
      ts.isClassStaticBlockDeclaration(current) ||
      ts.isSourceFile(current)
    )
      return current;
  }
  return node.getSourceFile();
}

function bind(
  scopes: Map<ts.Node, Map<string, Binding>>,
  scope: ts.Node,
  name: string,
  declaration: ts.Node,
  origin: HttpClientOrigin | null = null,
) {
  let bindings = scopes.get(scope);
  if (!bindings) {
    bindings = new Map();
    scopes.set(scope, bindings);
  }
  const prior = bindings.get(name);
  if (!prior) bindings.set(name, { declaration, origin });
  else if (
    prior.origin?.packageName !== origin?.packageName ||
    prior.origin?.path !== origin?.path ||
    prior.origin?.member !== origin?.member
  )
    bindings.set(name, { declaration, origin: null });
}

function importBindings(
  clause: ts.ImportClause,
  packageName: string,
  modulePath: string,
): Array<[string, HttpClientOrigin]> {
  const origin = { packageName, path: modulePath };
  const bindings: Array<[string, HttpClientOrigin]> = [];
  if (clause.name) bindings.push([clause.name.text, origin]);
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) bindings.push([named.name.text, origin]);
  if (named && ts.isNamedImports(named)) {
    for (const element of named.elements) {
      const imported = element.propertyName ?? element.name;
      bindings.push([
        element.name.text,
        {
          packageName,
          path: [modulePath, ts.isIdentifier(imported) ? imported.text : ""]
            .filter(Boolean)
            .join("."),
          member: ts.isIdentifier(imported) ? imported.text : undefined,
        },
      ]);
    }
  }
  return bindings;
}

function bindingAt(index: HttpClientOriginIndex, node: ts.Node, name: string) {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const binding = index.scopes.get(current)?.get(name);
    if (binding) return binding;
  }
  return null;
}

function assignmentNames(target: ts.Node): string[] {
  const names: string[] = [];
  const pending = [target];
  while (pending.length) {
    const current = pending.pop()!;
    if (ts.isParenthesizedExpression(current)) pending.push(current.expression);
    else if (ts.isIdentifier(current)) names.push(current.text);
    else if (ts.isArrayLiteralExpression(current)) {
      for (const element of current.elements) {
        if (ts.isSpreadElement(element)) pending.push(element.expression);
        else if (!ts.isOmittedExpression(element)) pending.push(element);
      }
    } else if (ts.isObjectLiteralExpression(current)) {
      for (const property of current.properties) {
        if (ts.isShorthandPropertyAssignment(property)) names.push(property.name.text);
        else if (ts.isPropertyAssignment(property)) pending.push(property.initializer);
        else if (ts.isSpreadAssignment(property)) pending.push(property.expression);
      }
    }
  }
  return names;
}

function originAt(
  index: HttpClientOriginIndex,
  node: ts.Node,
  name: string,
  visiting = new Set<Binding>(),
): HttpClientOrigin | null {
  const binding = bindingAt(index, node, name);
  if (!binding) return null;
  if (binding.origin && !index.reassigned.has(binding)) return binding.origin;
  if (index.reassigned.has(binding)) {
    if (binding.origin) {
      index.aliasResolutionTruncated = true;
      return null;
    }
  }
  if (visiting.has(binding)) return null;
  if (visiting.size >= 64) {
    index.aliasResolutionTruncated = true;
    return null;
  }
  visiting.add(binding);
  const declaration = binding.declaration;
  let origin: HttpClientOrigin | null = null;

  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    const declarationInitializer = declaration.initializer;
    if (
      ts.isCallExpression(declarationInitializer) &&
      ts.isIdentifier(declarationInitializer.expression) &&
      declarationInitializer.expression.text === "require"
    ) {
      if (
        !bindingAt(index, declarationInitializer, "require") &&
        declarationInitializer.arguments[0] &&
        ts.isStringLiteralLike(declarationInitializer.arguments[0])
      ) {
        const moduleOrigin = packageOrigin(declarationInitializer.arguments[0].text);
        if (moduleOrigin && ts.isIdentifier(declaration.name)) origin = moduleOrigin;
        else if (moduleOrigin && ts.isObjectBindingPattern(declaration.name)) {
          const property = declaration.name.elements.find(
            (element) => ts.isIdentifier(element.name) && element.name.text === name,
          );
          if (property) {
            const imported = property.propertyName ?? property.name;
            if (ts.isIdentifier(imported))
              origin = {
                ...moduleOrigin,
                path: [moduleOrigin.path, imported.text].filter(Boolean).join("."),
                member: imported.text,
              };
          }
        }
      }
    } else {
      const chain = memberChain(
        ts.isCallExpression(declarationInitializer)
          ? declarationInitializer.expression
          : declarationInitializer,
      );
      if (chain) {
        const sourceOrigin = originAt(index, declarationInitializer, chain.root, visiting);
        if (sourceOrigin) {
          origin = resolveCreatedClientAlias(
            declarationInitializer,
            new Map([[chain.root, sourceOrigin]]),
          );
        }
      }
    }
  }

  visiting.delete(binding);
  if (origin && index.reassigned.has(binding)) {
    index.aliasResolutionTruncated = true;
    return null;
  }
  if (origin) binding.origin = origin;
  return origin;
}

export function collectHttpClientOrigins(source: ts.SourceFile): HttpClientOriginIndex {
  const scopes = new Map<ts.Node, Map<string, Binding>>();
  const index: HttpClientOriginIndex = {
    source,
    scopes,
    reassigned: new Set(),
    aliasResolutionTruncated: false,
    bindingPatternTruncated: false,
  };
  const stack: ts.Node[] = [source];

  // One bounded AST walk indexes lexical bindings. Call-site checks below only
  // walk their ancestor chain and never rescan the complete file.
  while (stack.length) {
    const node = stack.pop()!;
    if (ts.isImportDeclaration(node) && node.importClause) {
      const specifier = ts.isStringLiteralLike(node.moduleSpecifier)
        ? packageOrigin(node.moduleSpecifier.text)
        : null;
      const packageName = specifier?.packageName;
      if (packageName) {
        for (const [name, origin] of importBindings(node.importClause, packageName, specifier.path))
          bind(scopes, source, name, node.importClause, origin);
      } else {
        const clause = node.importClause;
        if (clause.name) bind(scopes, source, clause.name.text, clause);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
          bind(scopes, source, clause.namedBindings.name.text, clause);
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
          for (const element of clause.namedBindings.elements)
            bind(scopes, source, element.name.text, clause);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      for (const name of bindingNames(node.name, index))
        bind(scopes, variableScope(node), name, node);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters)
        for (const name of bindingNames(parameter.name, index)) bind(scopes, node, name, parameter);
      if (node.name && ts.isIdentifier(node.name) && ts.isFunctionExpression(node))
        bind(scopes, node, node.name.text, node);
    }
    if (ts.isFunctionDeclaration(node) && node.name)
      bind(scopes, lexicalScope(node.parent), node.name.text, node);
    if (ts.isClassDeclaration(node) && node.name)
      bind(scopes, lexicalScope(node.parent), node.name.text, node);
    if (ts.isClassExpression(node) && node.name) bind(scopes, node, node.name.text, node);
    if (ts.isCatchClause(node) && node.variableDeclaration)
      for (const name of bindingNames(node.variableDeclaration.name, index))
        bind(scopes, node, name, node.variableDeclaration);
    node.forEachChild((child) => {
      stack.push(child);
    });
  }

  const writes: ts.Node[] = [source];
  while (writes.length) {
    const node = writes.pop()!;
    const targets: ts.Node[] = [];
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    )
      targets.push(node.left);
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      if (
        node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken
      )
        targets.push(node.operand);
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    )
      targets.push(node.initializer);
    for (const target of targets) {
      for (const name of assignmentNames(target)) {
        const binding = bindingAt(index, target, name);
        if (binding) index.reassigned.add(binding);
      }
    }
    node.forEachChild((child) => {
      writes.push(child);
    });
  }
  return index;
}

export function isRecognizedHttpCall(call: ts.CallExpression, origins: HttpClientOriginIndex) {
  if (origins.bindingPatternTruncated) return false;
  const callable = memberChain(call.expression);
  if (!callable) return false;
  if (callable.root === "fetch" && callable.path.length === 0)
    if (bindingAt(origins, call, "fetch") === null) return true;
  const origin = originAt(origins, call, callable.root);
  return Boolean(
    origin &&
    HTTP_CLIENT_PACKAGES.has(origin.packageName) &&
    (origin.member
      ? HTTP_CLIENT_METHODS.has(origin.member) && callable.path.length === 0
      : callable.path.length === 0 ||
        (callable.path.length === 1 && HTTP_CLIENT_METHODS.has(callable.path[0]!))),
  );
}

export function resolveCreatedClientAlias(
  initializer: ts.Expression,
  origins: ReadonlyMap<string, HttpClientOrigin>,
): HttpClientOrigin | null {
  const call = ts.isCallExpression(initializer) ? initializer : null;
  const chain = memberChain(call?.expression ?? initializer);
  if (!chain) return null;
  const origin = origins.get(chain.root);
  if (!origin || !HTTP_CLIENT_PACKAGES.has(origin.packageName)) return null;
  if (call && !origin.member && chain.path.at(-1) === "create")
    return { packageName: origin.packageName, path: "" };
  if (!call && chain.path.length === 0) return { ...origin };
  if (!call && !origin.member && HTTP_CLIENT_METHODS.has(chain.path.at(-1) ?? ""))
    return {
      packageName: origin.packageName,
      path: [origin.path, ...chain.path].filter(Boolean).join("."),
      member: chain.path.at(-1),
    };
  return null;
}
