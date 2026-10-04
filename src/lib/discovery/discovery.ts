import "server-only";
import { parse } from "parse5";
import { performance } from "node:perf_hooks";
import { fetchHttpSource, SafeFetchError } from "@/lib/monitoring/fetcher";
import {
  canonicalizePublicWebsiteUrl,
  WebsiteUrlInputError,
} from "@/lib/discovery/normalize-website-url";
import {
  providerSignatureRegistry,
  type DiscoverySignalType,
  type SignatureInput,
} from "@/lib/discovery/registry";

export const discoveryLimits = {
  maxHtmlBytes: 2 * 1024 * 1024,
  maxHtmlNodes: 20_000,
  maxReferenceUrls: 64,
  maxInlineConfigUrls: 32,
  maxManifests: 1,
  maxManifestBytes: 32 * 1024,
  maxDeepScripts: 4,
  maxScriptBytes: 96 * 1024,
  maxDeepBytes: 384 * 1024,
  maxParallelDeepAssets: 2,
  maxScanDurationMs: 45_000,
} as const;

export type DiscoveryEvidence = {
  providerSlug: string;
  providerName: string;
  signatureKey: string;
  signalType: DiscoverySignalType;
  strength: "strong" | "medium" | "weak";
  sourceOrigin: string;
};

export type DiscoveryCandidate = {
  providerSlug: string;
  providerName: string;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  evidence: DiscoveryEvidence[];
};

export type UrlDiscoveryResult = {
  normalizedUrl: string;
  status: "completed" | "partial" | "failed";
  outcome: "complete" | "partial" | "empty" | "failed";
  candidates: DiscoveryCandidate[];
  evidence: DiscoveryEvidence[];
  deepPass: {
    requested: boolean;
    scriptsDiscovered: number;
    scriptsAttempted: number;
    scriptsFetched: number;
    bytesFetched: number;
    failures: number;
  };
  coverage: {
    outcome: "complete" | "partial" | "empty" | "failed";
    durationMs: number;
    html: {
      attempted: boolean;
      status: number | null;
      bytesRead: number;
      truncated: boolean;
      extractionPerformed: boolean;
      nodeLimitReached: boolean;
      referenceLimitReached: boolean;
    };
    headers: { inspected: number };
    csp: { inspected: boolean; hostSources: number };
    manifest: { attempted: boolean; discovered: number; fetched: number; failures: number };
    javascript: {
      attempted: boolean;
      scriptsDiscovered: number;
      scriptsAttempted: number;
      scriptsFetched: number;
      bytesFetched: number;
      failures: number;
      limitReached: boolean;
    };
    incompleteReasons: string[];
  };
  inspected: {
    responseHeaders: number;
    redirects: number;
    htmlNodes: number;
    scriptReferences: number;
    resourceReferences: number;
    cspHosts: number;
    inlineConfigUrls: number;
    manifestsFetched: number;
    jsAssetsFetched: number;
    dnsRecordsUsed: false;
    browserRuntime: false;
  };
  failureCategory?: string;
};

type HtmlNode = {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  value?: string;
  childNodes?: HtmlNode[];
};

export function normalizePublicWebsiteUrl(value: string): string {
  try {
    return canonicalizePublicWebsiteUrl(value);
  } catch (error) {
    if (error instanceof WebsiteUrlInputError) {
      throw new SafeFetchError(error.category, error.message);
    }
    throw error;
  }
}

function sanitizeSourceOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

function collectConfigUrls(
  value: unknown,
  urls: Set<string>,
  budget: { remaining: number; limited: boolean },
  depth = 0,
) {
  if (depth > 8 || budget.remaining <= 0) {
    budget.limited = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectConfigUrls(item, urls, budget, depth + 1);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    budget.remaining -= 1;
    if (
      /(?:api.?url|api|endpoint|dsn|base.?url|server.?url|auth.?url|project.?url|public.?url)$/i.test(
        key,
      )
    ) {
      if (typeof child === "string") {
        for (const url of collectEmbeddedUrls(child)) urls.add(url);
      }
    }
    collectConfigUrls(child, urls, budget, depth + 1);
    if (budget.remaining <= 0) break;
  }
}

function parseConfigJson(value: string, urls: Set<string>) {
  if (Buffer.byteLength(value, "utf8") > 32 * 1024) return true;
  const budget = { remaining: 500, limited: false };
  try {
    collectConfigUrls(JSON.parse(value), urls, budget);
  } catch {
    // A malformed public config block is ignored; its source text is never retained.
  }
  return budget.limited;
}

function collectNodeText(node: HtmlNode, maxBytes: number) {
  const values: string[] = [];
  const stack = [node];
  let size = 0;
  let visited = 0;
  while (stack.length && size < maxBytes && visited < 500) {
    const current = stack.pop()!;
    visited += 1;
    if (current.value) {
      const remaining = maxBytes - size;
      const value = Buffer.from(current.value, "utf8").subarray(0, remaining).toString("utf8");
      values.push(value);
      size += Buffer.byteLength(value, "utf8");
    }
    const children = current.childNodes ?? [];
    const allowed = Math.max(0, 500 - visited - stack.length);
    for (let index = Math.min(children.length, allowed) - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
  return { value: values.join(""), truncated: stack.length > 0 || visited >= 500 };
}

function collectReferences(html: string, baseUrl: string) {
  const tree = parse(html) as unknown as HtmlNode;
  const scripts: string[] = [];
  const resources: string[] = [];
  const stylesheets: string[] = [];
  const iframes: string[] = [];
  const formActions: string[] = [];
  const manifests: string[] = [];
  const inlineConfigUrls = new Set<string>();
  let scriptReferenceLimitReached = false;
  let inlineConfigLimitReached = false;
  const baseSearch = findFirstBaseHref(tree);
  const firstBaseHref = baseSearch.href;
  let effectiveBase = baseUrl;
  if (firstBaseHref) {
    try {
      const base = new URL(firstBaseHref, baseUrl);
      if (
        (base.protocol === "https:" || base.protocol === "http:") &&
        !base.username &&
        !base.password &&
        (base.port === "" ||
          (base.protocol === "http:" && base.port === "80") ||
          (base.protocol === "https:" && base.port === "443"))
      ) {
        effectiveBase = base.href;
      }
    } catch {
      // Invalid base tags fall back to the fetched document URL.
    }
  }
  const stack = [tree];
  let nodesVisited = 0;
  let referenceLimitReached = false;
  while (
    stack.length > 0 &&
    resources.length < discoveryLimits.maxReferenceUrls &&
    nodesVisited < discoveryLimits.maxHtmlNodes
  ) {
    const node = stack.pop()!;
    nodesVisited += 1;
    const attrs = new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
    const tagName = node.tagName?.toLowerCase();
    let resourceValue: string | undefined;
    if (tagName === "script") {
      const scriptType = attrs.get("type")?.toLowerCase() ?? "";
      const source = attrs.get("src");
      if (source && scripts.length >= 30) {
        scriptReferenceLimitReached = true;
      } else if (source) {
        const normalized = normalizeReference(source, effectiveBase);
        if (normalized) {
          scripts.push(normalized);
          resources.push(normalized);
        }
      } else if (
        (scriptType === "application/json" || scriptType === "text/json") &&
        (/^(?:__(?:app|runtime|public|client|provider)?[-_]?config__|(?:app|runtime|public|client|provider)?[-_]?config)$/i.test(
          attrs.get("id") ?? "",
        ) ||
          attrs.has("data-config") ||
          attrs.get("data-purpose")?.toLowerCase() === "config")
      ) {
        const text = collectNodeText(node, 32 * 1024);
        if (text.truncated || parseConfigJson(text.value, inlineConfigUrls))
          inlineConfigLimitReached = true;
      }
    } else if (tagName === "link") {
      const rel = attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
      if (rel.includes("manifest")) {
        resourceValue = attrs.get("href");
        if (resourceValue) {
          const normalized = normalizeReference(resourceValue, effectiveBase);
          if (normalized) manifests.push(normalized);
        }
      } else if (
        rel.some((value) =>
          ["stylesheet", "preconnect", "preload", "modulepreload", "icon", "dns-prefetch"].includes(
            value,
          ),
        )
      ) {
        resourceValue = attrs.get("href");
        if (resourceValue && rel.includes("stylesheet")) {
          const normalized = normalizeReference(resourceValue, effectiveBase);
          if (normalized) stylesheets.push(normalized);
        }
      }
    } else if (["img", "iframe", "source"].includes(tagName ?? "")) {
      resourceValue = attrs.get("src");
      if (tagName === "iframe" && resourceValue) {
        const normalized = normalizeReference(resourceValue, effectiveBase);
        if (normalized) iframes.push(normalized);
      }
    } else if (tagName === "video") {
      resourceValue = attrs.get("poster");
    } else if (tagName === "form") {
      const action = attrs.get("action");
      const normalized = action ? normalizeReference(action, effectiveBase) : null;
      if (normalized) formActions.push(normalized);
    } else if (tagName === "meta") {
      const keys = [attrs.get("name"), attrs.get("property")].filter((value): value is string =>
        Boolean(value),
      );
      const content = attrs.get("content");
      if (
        content &&
        keys.some((key) =>
          /^(?:api[-_]url|api[-_]endpoint|endpoint|dsn|sentry[-_]dsn|base[-_]url|server[-_]url|auth[-_]url|project[-_]url|public[-_]url)$/i.test(
            key.trim(),
          ),
        )
      ) {
        for (const url of collectEmbeddedUrls(content)) inlineConfigUrls.add(url);
      }
    }
    if (resourceValue) {
      const normalized = normalizeReference(resourceValue, effectiveBase);
      if (normalized) resources.push(normalized);
    }
    // Reverse-push so traversal and the 30-script cap preserve document order.
    const children = node.childNodes ?? [];
    const remainingNodes = discoveryLimits.maxHtmlNodes - nodesVisited - stack.length;
    for (
      let index = children.length - 1;
      index >= 0 && stack.length < discoveryLimits.maxHtmlNodes - nodesVisited;
      index -= 1
    ) {
      stack.push(children[index]!);
    }
    if (children.length > Math.max(0, remainingNodes)) referenceLimitReached = true;
  }
  return {
    scriptUrls: [...new Set(scripts)].slice(0, 30),
    resourceUrls: [...new Set(resources)].slice(0, discoveryLimits.maxReferenceUrls),
    stylesheetUrls: [...new Set(stylesheets)].slice(0, discoveryLimits.maxReferenceUrls),
    iframeUrls: [...new Set(iframes)].slice(0, discoveryLimits.maxReferenceUrls),
    formActionUrls: [...new Set(formActions)].slice(0, discoveryLimits.maxReferenceUrls),
    manifestUrls: [...new Set(manifests)].slice(0, discoveryLimits.maxManifests),
    inlineConfigUrls: [...inlineConfigUrls].slice(0, discoveryLimits.maxInlineConfigUrls),
    scriptReferenceLimitReached,
    inlineConfigLimitReached:
      inlineConfigLimitReached || inlineConfigUrls.size > discoveryLimits.maxInlineConfigUrls,
    nodesVisited: nodesVisited + baseSearch.nodesVisited,
    nodeLimitReached:
      (nodesVisited >= discoveryLimits.maxHtmlNodes && stack.length > 0) ||
      baseSearch.nodeLimitReached,
    referenceLimitReached:
      referenceLimitReached ||
      (resources.length >= discoveryLimits.maxReferenceUrls && stack.length > 0),
  };
}

function normalizeReference(value: string, baseUrl: string) {
  try {
    const url = new URL(value, baseUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      (url.port !== "" &&
        !(
          (url.protocol === "http:" && url.port === "80") ||
          (url.protocol === "https:" && url.port === "443")
        ))
    ) {
      return null;
    }
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function findFirstBaseHref(tree: HtmlNode) {
  const stack = [tree];
  let nodesVisited = 0;
  while (stack.length > 0 && nodesVisited < discoveryLimits.maxHtmlNodes) {
    const node = stack.pop()!;
    nodesVisited += 1;
    if (node.tagName === "base") {
      const href = node.attrs?.find((attribute) => attribute.name === "href")?.value;
      if (href !== undefined) return { href, nodesVisited, nodeLimitReached: false };
    }
    const children = node.childNodes ?? [];
    const allowed = Math.max(0, discoveryLimits.maxHtmlNodes - nodesVisited - stack.length);
    for (let index = Math.min(children.length, allowed) - 1; index >= 0; index -= 1) {
      stack.push(children[index]!);
    }
  }
  return {
    href: null,
    nodesVisited,
    nodeLimitReached: nodesVisited >= discoveryLimits.maxHtmlNodes && stack.length > 0,
  };
}

function collectEmbeddedUrls(source: string): string[] {
  const urls = new Set<string>();
  const matches = source.matchAll(/https?:\/\/[^\s"'`<>\\]+/gi);
  for (const [match] of matches) {
    if (urls.size >= 64) break;
    try {
      const url = new URL(match.replace(/[),.;]+$/, ""));
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        (url.port === "" ||
          (url.protocol === "http:" && url.port === "80") ||
          (url.protocol === "https:" && url.port === "443"))
      ) {
        url.search = "";
        url.hash = "";
        urls.add(url.href);
      }
    } catch {
      // Invalid string literals in a bundled file are ignored.
    }
  }
  return [...urls];
}

function parseContentSecurityPolicy(headers: Record<string, string>) {
  const hosts = new Set<string>();
  const relevantDirectives = new Set([
    "default-src",
    "connect-src",
    "script-src",
    "frame-src",
    "img-src",
    "style-src",
  ]);
  for (const [name, policy] of Object.entries(headers)) {
    if (name !== "content-security-policy" && name !== "content-security-policy-report-only")
      continue;
    for (const directive of policy.split(";")) {
      const [directiveName, ...values] = directive.trim().split(/\s+/);
      if (!relevantDirectives.has(directiveName?.toLowerCase() ?? "")) continue;
      for (const value of values) {
        if (/^(?:'|data:|blob:|https?:$|wss?:$|\*)/i.test(value)) {
          if (value === "*" || /^(?:'|data:|blob:|https?:$|wss?:$)/i.test(value)) continue;
        }
        const candidate = value.replace(/^\*\./, "");
        const cspSource = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
        const parsed = normalizeReference(cspSource, "https://csp.invalid/");
        if (!parsed) continue;
        const host = new URL(parsed).hostname.toLowerCase();
        if (host.includes(".") && host !== "csp.invalid") hosts.add(host);
      }
    }
  }
  return [...hosts].slice(0, discoveryLimits.maxReferenceUrls);
}

function inspectJavaScript(source: string) {
  const code: string[] = [];
  const urls = new Set<string>();
  let index = 0;
  let lastSignificantChar = "";
  while (index < source.length && urls.size < 64) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      code.push(" ");
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/"))
        index += 1;
      index = Math.min(source.length, index + 2);
      code.push(" ");
      continue;
    }
    if (current === "/" && next !== "/" && next !== "*") {
      const prefix = source.slice(Math.max(0, index - 24), index);
      const expressionKeyword =
        /\b(?:return|throw|case|delete|void|typeof|instanceof|in|of|yield|await|else|do)\s*$/i.test(
          prefix,
        );
      if (
        !lastSignificantChar ||
        /[([{=:;,!?&|+*%~^<>-]/.test(lastSignificantChar) ||
        expressionKeyword
      ) {
        let cursor = index + 1;
        let escaped = false;
        let characterClass = false;
        while (cursor < source.length) {
          const character = source[cursor]!;
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === "[") characterClass = true;
          else if (character === "]") characterClass = false;
          else if (character === "/" && !characterClass) break;
          else if (character === "\n" || character === "\r") break;
          cursor += 1;
        }
        if (source[cursor] === "/") {
          cursor += 1;
          while (/[a-z]/i.test(source[cursor] ?? "")) cursor += 1;
          code.push(" ");
          index = cursor;
          lastSignificantChar = "/";
          continue;
        }
      }
    }
    if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      index += 1;
      let value = "";
      let interpolatedTemplate = false;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) {
          value += source[index + 1];
          index += 2;
          continue;
        }
        if (quote === "`" && source[index] === "$" && source[index + 1] === "{")
          interpolatedTemplate = true;
        value += source[index];
        index += 1;
      }
      index = Math.min(source.length, index + 1);
      code.push(" ");
      lastSignificantChar = quote;
      if (!interpolatedTemplate) {
        for (const url of collectEmbeddedUrls(value)) urls.add(url);
      }
      continue;
    }
    code.push(current ?? "");
    if (current && !/\s/.test(current)) lastSignificantChar = current;
    index += 1;
  }
  return { code: code.join(""), urls: [...urls] };
}

function emptyInspection(redirects = 0) {
  return {
    responseHeaders: 0,
    redirects,
    htmlNodes: 0,
    scriptReferences: 0,
    resourceReferences: 0,
    cspHosts: 0,
    inlineConfigUrls: 0,
    manifestsFetched: 0,
    jsAssetsFetched: 0,
    dnsRecordsUsed: false as const,
    browserRuntime: false as const,
  };
}

function scoreStrength(strength: DiscoveryEvidence["strength"]) {
  return strength === "strong" ? 0.68 : strength === "medium" ? 0.4 : 0.18;
}

function matchEvidence(
  input: SignatureInput,
  sourceOrigin: string,
  seen: Set<string>,
  target: DiscoveryEvidence[],
) {
  for (const signature of providerSignatureRegistry) {
    if (!signature.matches(input)) continue;
    const key = `${signature.providerSlug}:${signature.signatureKey}:${sourceOrigin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push({
      providerSlug: signature.providerSlug,
      providerName: signature.providerName,
      signatureKey: signature.signatureKey,
      signalType: signature.signalType,
      strength: signature.strength,
      sourceOrigin,
    });
  }
}

function makeCandidates(evidence: DiscoveryEvidence[]): DiscoveryCandidate[] {
  const grouped = new Map<string, DiscoveryEvidence[]>();
  for (const item of evidence)
    grouped.set(item.providerSlug, [...(grouped.get(item.providerSlug) ?? []), item]);
  return [...grouped.entries()]
    .map(([providerSlug, items]) => {
      if (items.every((item) => item.strength === "weak")) return null;
      const strongestBySignal = new Map<DiscoverySignalType, number>();
      for (const item of items) {
        strongestBySignal.set(
          item.signalType,
          Math.max(strongestBySignal.get(item.signalType) ?? 0, scoreStrength(item.strength)),
        );
      }
      const rawConfidence = Number(
        (
          1 -
          [...strongestBySignal.values()].reduce((remainder, score) => remainder * (1 - score), 1)
        ).toFixed(3),
      );
      const strongSignalTypes = new Set(
        items.filter((item) => item.strength === "strong").map((item) => item.signalType),
      ).size;
      const confidence = rawConfidence;
      const label =
        strongSignalTypes >= 2 && rawConfidence >= 0.85
          ? "high"
          : rawConfidence >= 0.5
            ? "medium"
            : "low";
      return {
        providerSlug,
        providerName: items[0]!.providerName,
        confidence,
        confidenceLabel: label,
        evidence: items,
      };
    })
    .filter((candidate): candidate is DiscoveryCandidate => candidate !== null)
    .sort(
      (left, right) =>
        right.confidence - left.confidence || left.providerSlug.localeCompare(right.providerSlug),
    );
}

export async function discoverWebsiteDependencies(
  rawUrl: string,
  options: { deep?: boolean; fetcher?: typeof fetchHttpSource } = {},
): Promise<UrlDiscoveryResult> {
  const normalizedUrl = normalizePublicWebsiteUrl(rawUrl);
  const fetcher = options.fetcher ?? fetchHttpSource;
  const startedAt = performance.now();
  const deadlineAt = startedAt + discoveryLimits.maxScanDurationMs;
  const fetchBounds = () => {
    const remainingMs = Math.floor(deadlineAt - performance.now());
    if (remainingMs <= 0)
      throw new SafeFetchError("scan_deadline", "The discovery time budget ended.");
    return {
      timeoutMs: Math.min(10_000, remainingMs),
      dnsTimeoutMs: Math.min(3_000, remainingMs),
      deadlineAt,
    };
  };
  let page;
  try {
    page = await fetcher(
      normalizedUrl,
      {},
      {
        restrictToStandardPorts: true,
        maxResponseBytes: discoveryLimits.maxHtmlBytes,
        allowTruncatedResponse: true,
        ...fetchBounds(),
      },
    );
  } catch (error) {
    if (
      !(error instanceof SafeFetchError) ||
      error.category === "timeout" ||
      error.category === "dns_error" ||
      error.category === "network_error" ||
      (error.category === "http_error" &&
        (error.httpStatus === 408 || error.httpStatus === 429 || (error.httpStatus ?? 0) >= 500))
    ) {
      throw error;
    }
    return {
      normalizedUrl,
      status: "failed",
      outcome: "failed",
      candidates: [],
      evidence: [],
      deepPass: {
        requested: options.deep === true,
        scriptsDiscovered: 0,
        scriptsAttempted: 0,
        scriptsFetched: 0,
        bytesFetched: 0,
        failures: 0,
      },
      coverage: {
        outcome: "failed",
        durationMs: Math.min(
          discoveryLimits.maxScanDurationMs,
          Math.ceil(performance.now() - startedAt),
        ),
        html: {
          attempted: true,
          status: null,
          bytesRead: 0,
          truncated: false,
          extractionPerformed: false,
          nodeLimitReached: false,
          referenceLimitReached: false,
        },
        headers: { inspected: 0 },
        csp: { inspected: false, hostSources: 0 },
        manifest: { attempted: false, discovered: 0, fetched: 0, failures: 0 },
        javascript: {
          attempted: options.deep === true,
          scriptsDiscovered: 0,
          scriptsAttempted: 0,
          scriptsFetched: 0,
          bytesFetched: 0,
          failures: 0,
          limitReached: false,
        },
        incompleteReasons: [],
      },
      inspected: emptyInspection(),
      failureCategory: error instanceof SafeFetchError ? error.category : "fetch_failed",
    };
  }
  const pageOrigin = sanitizeSourceOrigin(page.finalUrl);
  if (!pageOrigin) {
    return {
      normalizedUrl,
      status: "failed",
      outcome: "failed",
      candidates: [],
      evidence: [],
      deepPass: {
        requested: options.deep === true,
        scriptsDiscovered: 0,
        scriptsAttempted: 0,
        scriptsFetched: 0,
        bytesFetched: 0,
        failures: 0,
      },
      coverage: {
        outcome: "failed",
        durationMs: Math.min(
          discoveryLimits.maxScanDurationMs,
          Math.ceil(performance.now() - startedAt),
        ),
        html: {
          attempted: true,
          status: page.status,
          bytesRead: page.bytesRead,
          truncated: page.bodyTruncated,
          extractionPerformed: false,
          nodeLimitReached: false,
          referenceLimitReached: false,
        },
        headers: { inspected: 0 },
        csp: { inspected: false, hostSources: 0 },
        manifest: { attempted: false, discovered: 0, fetched: 0, failures: 0 },
        javascript: {
          attempted: options.deep === true,
          scriptsDiscovered: 0,
          scriptsAttempted: 0,
          scriptsFetched: 0,
          bytesFetched: 0,
          failures: 0,
          limitReached: false,
        },
        incompleteReasons: [],
      },
      inspected: emptyInspection(page.redirectEvidence?.length ?? 0),
      failureCategory: "unsafe_target",
    };
  }

  const html = page.body.toString("utf8");
  const references = collectReferences(html, page.finalUrl);
  const cspHosts = parseContentSecurityPolicy(page.safeHeaders);
  const redirectOrigins = page.redirectEvidence?.length ? [pageOrigin] : [];
  const evidence: DiscoveryEvidence[] = [];
  const seen = new Set<string>();
  matchEvidence(
    {
      headers: page.safeHeaders,
      scriptUrls: references.scriptUrls,
      resourceUrls: references.resourceUrls,
      stylesheetUrls: references.stylesheetUrls,
      iframeUrls: references.iframeUrls,
      formActionUrls: references.formActionUrls,
      inlineConfigUrls: references.inlineConfigUrls,
      cspHosts,
      redirectOrigins,
      embeddedUrls: [],
      siteOrigin: pageOrigin,
    },
    pageOrigin,
    seen,
    evidence,
  );
  for (const redirect of page.redirectEvidence ?? []) {
    matchEvidence(
      {
        headers: redirect.safeHeaders,
        scriptUrls: [],
        resourceUrls: [],
        embeddedUrls: [],
        siteOrigin: redirect.origin,
      },
      redirect.origin,
      seen,
      evidence,
    );
  }

  let scriptsFetched = 0;
  let scriptsAttempted = 0;
  let scriptsDiscovered = 0;
  let scriptFailures = 0;
  let scriptTruncated = false;
  let bytesFetched = 0;
  let manifestsFetched = 0;
  let manifestFailures = 0;
  let manifestTruncated = false;
  const manifestConfigUrls = new Set<string>();
  const sameOriginScripts = options.deep
    ? references.scriptUrls.filter((scriptUrl) => {
        try {
          return new URL(scriptUrl).origin === pageOrigin;
        } catch {
          return false;
        }
      })
    : [];
  scriptsDiscovered = sameOriginScripts.length;
  if (options.deep) {
    for (const manifestUrl of references.manifestUrls) {
      if (manifestsFetched >= discoveryLimits.maxManifests) break;
      try {
        if (new URL(manifestUrl).origin !== pageOrigin) continue;
        const bounds = fetchBounds();
        const manifest = await fetcher(
          manifestUrl,
          {},
          {
            allowedOrigins: [pageOrigin],
            restrictToStandardPorts: true,
            acceptedContentTypes: ["application/manifest+json", "application/json"],
            maxResponseBytes: discoveryLimits.maxManifestBytes,
            allowTruncatedResponse: true,
            ...bounds,
          },
        );
        manifestsFetched += 1;
        bytesFetched += manifest.body.byteLength;
        manifestTruncated ||= manifest.bodyTruncated;
        if (manifest.bodyTruncated) manifestFailures += 1;
        parseConfigJson(manifest.body.toString("utf8"), manifestConfigUrls);
      } catch {
        // Manifests are optional public metadata and cannot fail the homepage scan.
        manifestFailures += 1;
      }
    }
  }

  const selectedScripts = sameOriginScripts.slice(0, discoveryLimits.maxDeepScripts);
  const scriptLimitReached = sameOriginScripts.length > selectedScripts.length;
  const scriptBudgets = selectedScripts.map((_, index) =>
    Math.min(
      discoveryLimits.maxScriptBytes,
      Math.floor(
        Math.max(0, discoveryLimits.maxDeepBytes - bytesFetched) /
          Math.max(1, selectedScripts.length - index),
      ),
    ),
  );
  const scriptResults = await mapWithConcurrency(
    selectedScripts.map((url, index) => ({ url, maxBytes: scriptBudgets[index]! })),
    discoveryLimits.maxParallelDeepAssets,
    async ({ url, maxBytes }) => {
      if (maxBytes <= 0) return { script: null, failure: true };
      try {
        scriptsAttempted += 1;
        const script = await fetcher(
          url,
          {},
          {
            allowedOrigins: [pageOrigin],
            restrictToStandardPorts: true,
            acceptedContentTypes: [
              "text/javascript",
              "application/javascript",
              "application/x-javascript",
            ],
            maxResponseBytes: maxBytes,
            allowTruncatedResponse: true,
            ...fetchBounds(),
          },
        );
        if (
          !["text/javascript", "application/javascript", "application/x-javascript"].includes(
            script.contentType ?? "",
          )
        ) {
          return { script: null, failure: true };
        }
        return { script, failure: false };
      } catch {
        return { script: null, failure: true };
      }
    },
  );
  for (const { script, failure } of scriptResults) {
    if (failure) scriptFailures += 1;
    if (!script) continue;
    scriptsFetched += 1;
    bytesFetched += script.body.byteLength;
    scriptTruncated ||= script.bodyTruncated;
    if (script.bodyTruncated) scriptFailures += 1;
    const parsed = inspectJavaScript(script.body.toString("utf8"));
    const scriptOrigin = sanitizeSourceOrigin(script.finalUrl);
    if (scriptOrigin) {
      matchEvidence(
        {
          headers: script.safeHeaders,
          scriptUrls: [],
          resourceUrls: [],
          embeddedUrls: [],
          javascriptUrls: parsed.urls,
          javascriptSources: [parsed.code],
          cspHosts: parseContentSecurityPolicy(script.safeHeaders),
          siteOrigin: pageOrigin,
        },
        scriptOrigin,
        seen,
        evidence,
      );
    }
  }

  if (manifestConfigUrls.size > 0) {
    matchEvidence(
      {
        headers: {},
        scriptUrls: [],
        resourceUrls: [],
        inlineConfigUrls: [...manifestConfigUrls],
        embeddedUrls: [],
        siteOrigin: pageOrigin,
      },
      pageOrigin,
      seen,
      evidence,
    );
  }

  const responseHeaders =
    Object.keys(page.safeHeaders).length +
    (page.redirectEvidence ?? []).reduce(
      (count, redirect) => count + Object.keys(redirect.safeHeaders).length,
      0,
    );
  const incompleteReasons: string[] = [];
  if (page.bodyTruncated) incompleteReasons.push("html_truncated");
  if (references.nodeLimitReached) incompleteReasons.push("html_node_limit");
  if (references.referenceLimitReached) incompleteReasons.push("reference_limit");
  if (references.scriptReferenceLimitReached) incompleteReasons.push("script_reference_limit");
  if (references.inlineConfigLimitReached) incompleteReasons.push("inline_config_limit");
  if (manifestFailures > 0) incompleteReasons.push("manifest_unavailable");
  if (manifestTruncated) incompleteReasons.push("manifest_truncated");
  if (scriptFailures > 0) incompleteReasons.push("javascript_unavailable");
  if (scriptTruncated) incompleteReasons.push("javascript_truncated");
  if (scriptLimitReached) incompleteReasons.push("deep_script_limit");
  if (performance.now() >= deadlineAt) incompleteReasons.push("scan_time_budget");
  const partial = incompleteReasons.length > 0;
  const candidates = makeCandidates(evidence);
  const outcome = partial ? "partial" : candidates.length === 0 ? "empty" : "complete";
  const durationMs = Math.ceil(performance.now() - startedAt);
  return {
    normalizedUrl,
    status: partial ? "partial" : "completed",
    outcome,
    candidates,
    evidence,
    deepPass: {
      requested: options.deep === true,
      scriptsDiscovered,
      scriptsAttempted,
      scriptsFetched,
      bytesFetched,
      failures: scriptFailures + manifestFailures,
    },
    coverage: {
      outcome,
      durationMs,
      html: {
        attempted: true,
        status: page.status,
        bytesRead: page.bytesRead,
        truncated: page.bodyTruncated,
        extractionPerformed: true,
        nodeLimitReached: references.nodeLimitReached,
        referenceLimitReached: references.referenceLimitReached,
      },
      headers: { inspected: responseHeaders },
      csp: { inspected: true, hostSources: cspHosts.length },
      manifest: {
        attempted: options.deep === true && references.manifestUrls.length > 0,
        discovered: references.manifestUrls.length,
        fetched: manifestsFetched,
        failures: manifestFailures,
      },
      javascript: {
        attempted: options.deep === true,
        scriptsDiscovered,
        scriptsAttempted,
        scriptsFetched,
        bytesFetched,
        failures: scriptFailures,
        limitReached: scriptLimitReached,
      },
      incompleteReasons,
    },
    inspected: {
      responseHeaders,
      redirects: page.redirectEvidence?.length ?? 0,
      htmlNodes: references.nodesVisited,
      scriptReferences: references.scriptUrls.length,
      resourceReferences: references.resourceUrls.length,
      cspHosts: cspHosts.length,
      inlineConfigUrls: references.inlineConfigUrls.length + manifestConfigUrls.size,
      manifestsFetched,
      jsAssetsFetched: scriptsFetched,
      dnsRecordsUsed: false,
      browserRuntime: false,
    },
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        results[index] = await operation(items[index]!);
      }
    }),
  );
  return results;
}
