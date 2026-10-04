import "server-only";
import { parse } from "parse5";
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
  status: "completed" | "failed";
  candidates: DiscoveryCandidate[];
  evidence: DiscoveryEvidence[];
  deepPass: { requested: boolean; scriptsFetched: number; bytesFetched: number };
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
  budget: { remaining: number },
  depth = 0,
) {
  if (depth > 8 || budget.remaining <= 0) return;
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
  if (Buffer.byteLength(value, "utf8") > 32 * 1024) return;
  try {
    collectConfigUrls(JSON.parse(value), urls, { remaining: 500 });
  } catch {
    // A malformed public config block is ignored; its source text is never retained.
  }
}

function collectNodeText(node: HtmlNode, maxBytes: number) {
  const values: string[] = [];
  const stack = [node];
  let size = 0;
  while (stack.length && size < maxBytes) {
    const current = stack.pop()!;
    if (current.value) {
      const remaining = maxBytes - size;
      const value = current.value.slice(0, remaining);
      values.push(value);
      size += Buffer.byteLength(value, "utf8");
    }
    for (const child of [...(current.childNodes ?? [])].reverse()) stack.push(child);
  }
  return values.join("");
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
      if (source && scripts.length < 30) {
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
        parseConfigJson(collectNodeText(node, 32 * 1024), inlineConfigUrls);
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
    for (const child of [...(node.childNodes ?? [])].reverse()) stack.push(child);
  }
  return {
    scriptUrls: [...new Set(scripts)].slice(0, 30),
    resourceUrls: [...new Set(resources)].slice(0, discoveryLimits.maxReferenceUrls),
    stylesheetUrls: [...new Set(stylesheets)].slice(0, discoveryLimits.maxReferenceUrls),
    iframeUrls: [...new Set(iframes)].slice(0, discoveryLimits.maxReferenceUrls),
    formActionUrls: [...new Set(formActions)].slice(0, discoveryLimits.maxReferenceUrls),
    manifestUrls: [...new Set(manifests)].slice(0, discoveryLimits.maxManifests),
    inlineConfigUrls: [...inlineConfigUrls].slice(0, discoveryLimits.maxInlineConfigUrls),
    nodesVisited: nodesVisited + baseSearch.nodesVisited,
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
      if (href !== undefined) return { href, nodesVisited };
    }
    for (const child of [...(node.childNodes ?? [])].reverse()) stack.push(child);
  }
  return { href: null, nodesVisited };
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
  let page;
  try {
    page = await fetcher(
      normalizedUrl,
      {},
      {
        restrictToStandardPorts: true,
        maxResponseBytes: discoveryLimits.maxHtmlBytes,
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
      candidates: [],
      evidence: [],
      deepPass: { requested: options.deep === true, scriptsFetched: 0, bytesFetched: 0 },
      inspected: emptyInspection(),
      failureCategory: error instanceof SafeFetchError ? error.category : "fetch_failed",
    };
  }
  const pageOrigin = sanitizeSourceOrigin(page.finalUrl);
  if (!pageOrigin) {
    return {
      normalizedUrl,
      status: "failed",
      candidates: [],
      evidence: [],
      deepPass: { requested: options.deep === true, scriptsFetched: 0, bytesFetched: 0 },
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
  let bytesFetched = 0;
  let manifestsFetched = 0;
  const manifestConfigUrls = new Set<string>();
  if (options.deep) {
    for (const manifestUrl of references.manifestUrls) {
      if (manifestsFetched >= discoveryLimits.maxManifests) break;
      try {
        if (new URL(manifestUrl).origin !== pageOrigin) continue;
        const manifest = await fetcher(
          manifestUrl,
          {},
          {
            allowedOrigins: [pageOrigin],
            restrictToStandardPorts: true,
            acceptedContentTypes: ["application/manifest+json", "application/json"],
            maxResponseBytes: discoveryLimits.maxManifestBytes,
          },
        );
        manifestsFetched += 1;
        bytesFetched += manifest.body.byteLength;
        parseConfigJson(manifest.body.toString("utf8"), manifestConfigUrls);
      } catch {
        // Manifests are optional public metadata and cannot fail the homepage scan.
      }
    }
  }

  if (options.deep) {
    const sameOrigin = references.scriptUrls.filter((scriptUrl) => {
      try {
        return new URL(scriptUrl).origin === pageOrigin;
      } catch {
        return false;
      }
    });
    for (const scriptUrl of sameOrigin.slice(0, discoveryLimits.maxDeepScripts)) {
      const remaining = discoveryLimits.maxDeepBytes - bytesFetched;
      if (remaining <= 0) break;
      try {
        const script = await fetcher(
          scriptUrl,
          {},
          {
            allowedOrigins: [pageOrigin],
            restrictToStandardPorts: true,
            acceptedContentTypes: [
              "text/javascript",
              "application/javascript",
              "application/x-javascript",
            ],
            maxResponseBytes: Math.min(discoveryLimits.maxScriptBytes, remaining),
          },
        );
        if (
          !["text/javascript", "application/javascript", "application/x-javascript"].includes(
            script.contentType ?? "",
          )
        ) {
          continue;
        }
        if (script.body.byteLength > Math.min(discoveryLimits.maxScriptBytes, remaining)) continue;
        scriptsFetched += 1;
        bytesFetched += script.body.byteLength;
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
      } catch {
        // Deep evidence is optional; an inaccessible or unsuitable asset cannot fail fast discovery.
      }
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

  return {
    normalizedUrl,
    status: "completed",
    candidates: makeCandidates(evidence),
    evidence,
    deepPass: { requested: options.deep === true, scriptsFetched, bytesFetched },
    inspected: {
      responseHeaders:
        Object.keys(page.safeHeaders).length +
        (page.redirectEvidence ?? []).reduce(
          (count, redirect) => count + Object.keys(redirect.safeHeaders).length,
          0,
        ),
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
