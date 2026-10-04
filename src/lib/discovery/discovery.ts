import "server-only";
import { performance } from "node:perf_hooks";
import { fetchHttpSource, SafeFetchError } from "@/lib/monitoring/fetcher";
import { StreamingHtmlReferenceExtractor } from "@/lib/discovery/streaming-html";
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
  maxHtmlBytes: 4 * 1024 * 1024,
  maxHtmlNodes: 20_000,
  maxReferenceUrls: 64,
  maxScriptReferences: 30,
  maxInlineConfigUrls: 32,
  maxInlineConfigBytes: 32 * 1024,
  maxManifests: 1,
  maxManifestBytes: 32 * 1024,
  maxDeepScripts: 4,
  maxScriptBytes: 96 * 1024,
  maxDeepBytes: 384 * 1024,
  maxParallelDeepAssets: 2,
  maxScanDurationMs: 45_000,
  maxRuntimeDurationMs: 8_000,
} as const;

export type DiscoveryEvidence = {
  providerSlug: string;
  providerName: string;
  signatureKey: string;
  signalType: DiscoverySignalType;
  strength: "strong" | "medium" | "weak";
  sourceOrigin: string;
  surfaceType: DiscoverySurfaceType;
  surfaceHost: string;
};

export type DiscoverySurfaceType =
  | "ROOT_MARKETING"
  | "PRODUCT_APP"
  | "AUTH_APP"
  | "DASHBOARD"
  | "CUSTOMER_PORTAL"
  | "FIRST_PARTY_API"
  | "DOCS"
  | "BLOG"
  | "STATUS"
  | "SUPPORT"
  | "INTEGRATION_DIRECTORY"
  | "UNKNOWN";

export type DiscoveryCandidate = {
  providerSlug: string;
  providerName: string;
  confidence: number;
  confidenceLabel: "low" | "medium" | "high";
  evidence: DiscoveryEvidence[];
};

export type RuntimeRequestObservation = {
  host: string;
  resourceType: "document" | "script" | "fetch" | "xhr";
};

export type RuntimeDiscoveryResult = {
  requests: RuntimeRequestObservation[];
  requestsObserved: number;
  requestsFulfilled?: number;
  requestsBlocked?: number;
  uniqueHosts: number;
  blockedUnsafeRequests: number;
  durationMs: number;
  status: "complete" | "partial" | "unavailable";
  memoryDeltaBytes: number | null;
};

export type DiscoveryRuntimeBudget = {
  deadlineAt: number | null;
  requests: number;
  hosts: Set<string>;
  responseBytes: number;
  wireBytes: number;
  reservedResponseBytes: number;
  reservedWireBytes: number;
  maxRequests: number;
  maxHosts: number;
  maxResponseBytes: number;
  maxWireBytes: number;
};

export type UrlDiscoveryResult = {
  normalizedUrl: string;
  status: "completed" | "partial" | "failed";
  outcome: "complete" | "partial" | "empty" | "failed";
  candidates: DiscoveryCandidate[];
  evidence: DiscoveryEvidence[];
  surfaceLinks?: Array<{ url: string; labelKind: "app_cta" | "auth_cta" | "other" }>;
  finalHost?: string;
  companyCoverage?: {
    surfacesObserved: number;
    surfacesClassified: number;
    surfacesSelected: number;
    surfacesScanned: number;
    surfaces: Array<{
      host: string;
      type: DiscoverySurfaceType;
      association: "submitted_url" | "root_link";
      selected: boolean;
      selectionReason:
        | "root_surface"
        | "high_discovery_value"
        | "low_value_or_excluded"
        | "integration_directory_excluded"
        | "surface_limit";
      status: "scanned" | "skipped" | "failed";
      staticBytes?: number;
      staticDurationMs?: number;
      scriptBytes?: number;
      runtimeDurationMs?: number;
      runtimeRequests?: number;
    }>;
    providersObserved: number;
    providersSuggested: number;
    providersSuppressed: number;
    suppressionReasonCounts: Record<string, number>;
    suppressedObservations: Array<{
      providerSlug: string;
      surfaceType: DiscoverySurfaceType;
      surfaceHost: string;
      sourceHost: string;
      sourceOrigin: string;
      signatureKey: string;
      evidenceFamily: string;
      reason: string;
    }>;
    totalDurationMs: number;
    totalStaticBytes: number;
    totalStaticWireBytes: number;
    totalScriptBytes: number;
    totalRuntimeBytes: number;
    totalRuntimeWireBytes: number;
    totalRuntimeDurationMs: number;
    totalRuntimeRequests: number;
    totalRuntimeHosts: number;
  };
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
      referencesExtracted: number;
      extractionPerformed: boolean;
      nodeLimitReached: boolean;
      referenceLimitReached: boolean;
    };
    staticCoverage: {
      quality: "strong" | "weak" | "partial";
      durationMs: number;
      signalFamilies: number;
      runtimeRequired: boolean;
      resourceGraph: {
        scriptsFirstParty: number;
        scriptsThirdParty: number;
        stylesheets: number;
        preloads: number;
        apiEndpoints: number;
        frames: number;
        manifests: number;
        formActions: number;
        otherResources: number;
      };
    };
    runtime: {
      attempted: boolean;
      durationMs: number;
      requestsObserved: number;
      requestsFulfilled?: number;
      requestsBlocked?: number;
      uniqueHosts: number;
      providerMatches: number;
      blockedUnsafeRequests: number;
      status: "skipped" | "complete" | "partial" | "unavailable";
      memoryDeltaBytes: number | null;
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
    browserRuntime: boolean;
  };
  failureCategory?: string;
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

function countByOrigin(urls: string[], origin: string, firstParty: boolean) {
  return urls.filter((value) => {
    try {
      return (new URL(value).origin === origin) === firstParty;
    } catch {
      return false;
    }
  }).length;
}

function emptyStaticResourceGraph() {
  return {
    scriptsFirstParty: 0,
    scriptsThirdParty: 0,
    stylesheets: 0,
    preloads: 0,
    apiEndpoints: 0,
    frames: 0,
    manifests: 0,
    formActions: 0,
    otherResources: 0,
  };
}

function staticResourceGraph(
  references: ReturnType<StreamingHtmlReferenceExtractor["finish"]>,
  pageOrigin: string,
) {
  const scripts = new Set(references.scriptUrls);
  const resources = new Set(references.resourceUrls);
  return {
    scriptsFirstParty: countByOrigin(references.scriptUrls, pageOrigin, true),
    scriptsThirdParty: countByOrigin(references.scriptUrls, pageOrigin, false),
    stylesheets: references.stylesheetUrls.length,
    preloads: references.preloadUrls.length,
    apiEndpoints: references.inlineConfigUrls.length,
    frames: references.iframeUrls.length,
    manifests: references.manifestUrls.length,
    formActions: references.formActionUrls.length,
    otherResources: [...resources].filter((url) => !scripts.has(url)).length,
  };
}

function scoreStrength(strength: DiscoveryEvidence["strength"]) {
  return strength === "strong" ? 0.68 : strength === "medium" ? 0.4 : 0.18;
}

export function evidenceFamily(signalType: DiscoverySignalType) {
  if (["script_host", "script_path", "js_sdk", "runtime_script_host"].includes(signalType))
    return "sdk";
  if (["api_endpoint", "runtime_api_host"].includes(signalType)) return "provider_endpoint";
  if (["response_header", "redirect_host"].includes(signalType)) return "hosting_infrastructure";
  if (signalType === "csp_host") return "policy_allowlist";
  if (signalType === "runtime_host") return "runtime_host";
  return "context_reference";
}

function isRuntimeSignal(signalType: DiscoverySignalType) {
  return signalType.startsWith("runtime_");
}

function matchEvidence(
  input: SignatureInput,
  sourceOrigin: string,
  seen: Set<string>,
  target: DiscoveryEvidence[],
  surfaceType: DiscoverySurfaceType,
  surfaceHost = new URL(sourceOrigin).hostname.toLowerCase(),
) {
  for (const signature of providerSignatureRegistry) {
    if (!signature.matches(input)) continue;
    const key = `${surfaceType}:${surfaceHost}:${signature.providerSlug}:${signature.signatureKey}:${sourceOrigin}`;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push({
      providerSlug: signature.providerSlug,
      providerName: signature.providerName,
      signatureKey: signature.signatureKey,
      signalType: signature.signalType,
      strength: signature.strength,
      sourceOrigin,
      surfaceType,
      surfaceHost,
    });
  }
}

export function makeCandidates(evidence: DiscoveryEvidence[]): DiscoveryCandidate[] {
  const grouped = new Map<string, DiscoveryEvidence[]>();
  for (const item of evidence)
    grouped.set(item.providerSlug, [...(grouped.get(item.providerSlug) ?? []), item]);
  return [...grouped.entries()]
    .map(([providerSlug, items]) => {
      if (items.every((item) => item.strength === "weak")) return null;
      const bySurface = new Map<string, DiscoveryEvidence[]>();
      for (const item of items)
        bySurface.set(item.surfaceHost, [...(bySurface.get(item.surfaceHost) ?? []), item]);
      const scores = [...bySurface.values()].map((surfaceEvidence) => {
        const strongestByFamily = new Map<string, number>();
        for (const item of surfaceEvidence) {
          const family = evidenceFamily(item.signalType);
          strongestByFamily.set(
            family,
            Math.max(strongestByFamily.get(family) ?? 0, scoreStrength(item.strength)),
          );
        }
        const rawConfidence = Number(
          (
            1 -
            [...strongestByFamily.values()].reduce((remainder, score) => remainder * (1 - score), 1)
          ).toFixed(3),
        );
        const surfaceFamilies = new Set(
          surfaceEvidence
            .filter((item) => item.strength === "strong")
            .map((item) => evidenceFamily(item.signalType)),
        );
        const surfaceHasDirectUse = surfaceEvidence.some(
          (item) =>
            item.strength === "strong" &&
            ["sdk", "provider_endpoint"].includes(evidenceFamily(item.signalType)),
        );
        const runtimeEvidence = surfaceEvidence.filter(
          (item) => item.strength === "strong" && isRuntimeSignal(item.signalType),
        );
        const runtimeHosts = new Set(
          runtimeEvidence.map((item) => {
            try {
              return new URL(item.sourceOrigin).hostname.toLowerCase();
            } catch {
              return item.sourceOrigin;
            }
          }),
        );
        const runtimeFamilies = new Set(
          runtimeEvidence.map((item) => evidenceFamily(item.signalType)),
        );
        return {
          rawConfidence,
          high:
            surfaceFamilies.size >= 2 &&
            surfaceHasDirectUse &&
            rawConfidence >= 0.85 &&
            runtimeHosts.size >= 2 &&
            runtimeFamilies.size >= 2,
        };
      });
      const rawConfidence = Math.max(...scores.map((score) => score.rawConfidence));
      const confidence = rawConfidence;
      const independentlyHighOnOneSurface = scores.some((score) => score.high);
      const label = independentlyHighOnOneSurface
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
  options: {
    deep?: boolean;
    fetcher?: typeof fetchHttpSource;
    runtimeFetcher?: typeof fetchHttpSource;
    runtimeEnabled?: boolean;
    surfaceType?: DiscoverySurfaceType;
    globalDeadlineAt?: number;
    runtimeDeadlineAt?: number;
    runtimeBudget?: DiscoveryRuntimeBudget;
    runtimeRunner?: (
      url: string,
      options: { deadlineAt: number; signal?: AbortSignal },
      dependencies?: {
        initialDocument: Pick<
          Awaited<ReturnType<typeof fetchHttpSource>>,
          | "status"
          | "body"
          | "bytesRead"
          | "wireBytesRead"
          | "bodyTruncated"
          | "contentType"
          | "finalUrl"
        >;
        fetcher?: typeof fetchHttpSource;
        sharedBudget?: DiscoveryRuntimeBudget;
      },
    ) => Promise<RuntimeDiscoveryResult>;
    signal?: AbortSignal;
  } = {},
): Promise<UrlDiscoveryResult> {
  const normalizedUrl = normalizePublicWebsiteUrl(rawUrl);
  const surfaceType = options.surfaceType ?? "ROOT_MARKETING";
  const fetcher = options.fetcher ?? fetchHttpSource;
  const startedAt = performance.now();
  const deadlineAt = Math.min(
    startedAt + discoveryLimits.maxScanDurationMs,
    options.globalDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  const fetchBounds = () => {
    const remainingMs = Math.floor(deadlineAt - performance.now());
    if (remainingMs <= 0)
      throw new SafeFetchError("scan_deadline", "The discovery time budget ended.");
    return {
      timeoutMs: Math.min(10_000, remainingMs),
      dnsTimeoutMs: Math.min(3_000, remainingMs),
      deadlineAt,
      signal: options.signal,
    };
  };
  const throwIfCancelled = () => {
    if (options.signal?.aborted)
      throw new SafeFetchError("timeout", "The discovery task was cancelled.");
  };
  const referenceExtractor = new StreamingHtmlReferenceExtractor(
    {
      maxNodes: discoveryLimits.maxHtmlNodes,
      maxReferences: discoveryLimits.maxReferenceUrls,
      maxScripts: discoveryLimits.maxScriptReferences,
      maxInlineConfigBytes: discoveryLimits.maxInlineConfigBytes,
      maxInlineConfigUrls: discoveryLimits.maxInlineConfigUrls,
    },
    parseConfigJson,
    normalizeReference,
    normalizedUrl,
  );
  let page;
  try {
    page = await fetcher(
      normalizedUrl,
      {},
      {
        restrictToStandardPorts: true,
        maxResponseBytes: discoveryLimits.maxHtmlBytes,
        allowTruncatedResponse: true,
        onDecodedChunk: (chunk) => referenceExtractor.write(chunk),
        retainBody: options.runtimeEnabled === true,
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
      finalHost: new URL(normalizedUrl).hostname.toLowerCase(),
      status: "failed",
      outcome: "failed",
      candidates: [],
      evidence: [],
      surfaceLinks: [],
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
          referencesExtracted: 0,
          extractionPerformed: false,
          nodeLimitReached: false,
          referenceLimitReached: false,
        },
        staticCoverage: {
          quality: "partial",
          durationMs: Math.ceil(performance.now() - startedAt),
          signalFamilies: 0,
          runtimeRequired: false,
          resourceGraph: emptyStaticResourceGraph(),
        },
        runtime: {
          attempted: false,
          durationMs: 0,
          requestsObserved: 0,
          requestsFulfilled: 0,
          requestsBlocked: 0,
          uniqueHosts: 0,
          providerMatches: 0,
          blockedUnsafeRequests: 0,
          status: "skipped",
          memoryDeltaBytes: null,
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
      finalHost: new URL(page.finalUrl).hostname.toLowerCase(),
      status: "failed",
      outcome: "failed",
      candidates: [],
      evidence: [],
      surfaceLinks: [],
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
          referencesExtracted: 0,
          extractionPerformed: false,
          nodeLimitReached: false,
          referenceLimitReached: false,
        },
        staticCoverage: {
          quality: "partial",
          durationMs: Math.ceil(performance.now() - startedAt),
          signalFamilies: 0,
          runtimeRequired: false,
          resourceGraph: emptyStaticResourceGraph(),
        },
        runtime: {
          attempted: false,
          durationMs: 0,
          requestsObserved: 0,
          requestsFulfilled: 0,
          requestsBlocked: 0,
          uniqueHosts: 0,
          providerMatches: 0,
          blockedUnsafeRequests: 0,
          status: "skipped",
          memoryDeltaBytes: null,
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

  // Injected test fetchers and older adapters may still return a retained body without invoking
  // the streaming callback. Production fetchHttpSource uses the no-retention streaming path.
  if (!referenceExtractor.hasReceivedBytes && page.body.byteLength > 0) {
    referenceExtractor.write(page.body);
  }
  const references = referenceExtractor.finish(page.finalUrl);
  throwIfCancelled();
  const cspHosts = parseContentSecurityPolicy(page.safeHeaders);
  const redirectOrigins = page.redirectEvidence?.length ? [pageOrigin] : [];
  const evidence: DiscoveryEvidence[] = [];
  const seen = new Set<string>();
  const scannedHost = new URL(normalizedUrl).hostname.toLowerCase();
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
    surfaceType,
    scannedHost,
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
      surfaceType,
      scannedHost,
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
  throwIfCancelled();

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
  throwIfCancelled();
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
        surfaceType,
        scannedHost,
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
      surfaceType,
      scannedHost,
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
  const staticSignalFamilies = new Set(
    evidence
      .filter(
        (item) =>
          item.strength === "strong" &&
          !isRuntimeSignal(item.signalType) &&
          !["hosting_infrastructure", "policy_allowlist", "context_reference"].includes(
            evidenceFamily(item.signalType),
          ),
      )
      .map((item) => evidenceFamily(item.signalType)),
  ).size;
  const staticIncomplete = incompleteReasons.length > 0;
  const staticQuality = staticIncomplete
    ? "partial"
    : staticSignalFamilies >= 2 && references.scriptUrls.length > 0
      ? "strong"
      : "weak";
  const staticDurationMs = Math.ceil(performance.now() - startedAt);
  const runtimeRequired = options.runtimeEnabled === true && staticQuality !== "strong";
  let runtimeSummary: UrlDiscoveryResult["coverage"]["runtime"] = {
    attempted: false,
    durationMs: 0,
    requestsObserved: 0,
    requestsFulfilled: 0,
    requestsBlocked: 0,
    uniqueHosts: 0,
    providerMatches: 0,
    blockedUnsafeRequests: 0,
    status: "skipped",
    memoryDeltaBytes: null,
  };
  if (runtimeRequired && new URL(normalizedUrl).protocol === "https:") {
    const runtimeStartedAt = performance.now();
    runtimeSummary = { ...runtimeSummary, attempted: true, status: "unavailable" };
    try {
      if (options.runtimeBudget && options.runtimeBudget.deadlineAt === null) {
        options.runtimeBudget.deadlineAt = Math.min(
          performance.now() + discoveryLimits.maxRuntimeDurationMs,
          options.globalDeadlineAt ?? Number.POSITIVE_INFINITY,
        );
      }
      const deadlineAt = Math.min(
        startedAt + discoveryLimits.maxScanDurationMs,
        performance.now() + discoveryLimits.maxRuntimeDurationMs,
        options.runtimeBudget?.deadlineAt ?? options.runtimeDeadlineAt ?? Number.POSITIVE_INFINITY,
      );
      const runner =
        options.runtimeRunner ??
        (await import("@/lib/discovery/runtime-browser")).inspectPublicLandingPage;
      const runtimeResult = await runner(
        page.finalUrl,
        { deadlineAt, signal: options.signal },
        {
          initialDocument: page,
          fetcher: options.runtimeFetcher ?? fetcher,
          sharedBudget: options.runtimeBudget,
        },
      );
      if (options.signal?.aborted)
        throw new SafeFetchError("timeout", "The discovery task was cancelled.");
      const requests = [
        ...new Map(
          runtimeResult.requests.map((request) => [
            `${request.host}:${request.resourceType}`,
            request,
          ]),
        ).values(),
      ];
      const before = evidence.length;
      for (const request of requests) {
        matchEvidence(
          {
            headers: {},
            scriptUrls: [],
            resourceUrls: [],
            embeddedUrls: [],
            siteOrigin: pageOrigin,
            runtimeRequests: [request],
          },
          `https://${request.host}`,
          seen,
          evidence,
          surfaceType,
          scannedHost,
        );
      }
      runtimeSummary = {
        attempted: true,
        durationMs: runtimeResult.durationMs,
        requestsObserved: runtimeResult.requestsObserved,
        requestsFulfilled: runtimeResult.requestsFulfilled ?? 0,
        requestsBlocked: runtimeResult.requestsBlocked ?? 0,
        uniqueHosts: runtimeResult.uniqueHosts,
        providerMatches: evidence.length - before,
        blockedUnsafeRequests: runtimeResult.blockedUnsafeRequests,
        status: runtimeResult.status,
        memoryDeltaBytes: runtimeResult.memoryDeltaBytes,
      };
      if (runtimeResult.status === "partial") incompleteReasons.push("runtime_partial");
      if (runtimeResult.status === "unavailable") incompleteReasons.push("runtime_unavailable");
    } catch {
      if (options.signal?.aborted)
        throw new SafeFetchError("timeout", "The discovery task was cancelled.");
      runtimeSummary = {
        ...runtimeSummary,
        durationMs: Math.ceil(performance.now() - runtimeStartedAt),
      };
      incompleteReasons.push("runtime_unavailable");
    }
  } else if (runtimeRequired) {
    incompleteReasons.push("runtime_https_required");
  }
  throwIfCancelled();
  const partial = incompleteReasons.length > 0;
  const candidates = makeCandidates(evidence);
  const outcome = partial ? "partial" : candidates.length === 0 ? "empty" : "complete";
  const durationMs = Math.ceil(performance.now() - startedAt);
  return {
    normalizedUrl,
    finalHost: new URL(page.finalUrl).hostname.toLowerCase(),
    status: partial ? "partial" : "completed",
    outcome,
    candidates,
    evidence,
    surfaceLinks: references.surfaceLinks,
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
        referencesExtracted: new Set([...references.resourceUrls, ...references.scriptUrls]).size,
        extractionPerformed: true,
        nodeLimitReached: references.nodeLimitReached,
        referenceLimitReached: references.referenceLimitReached,
      },
      staticCoverage: {
        quality: staticQuality,
        durationMs: staticDurationMs,
        signalFamilies: staticSignalFamilies,
        runtimeRequired,
        resourceGraph: staticResourceGraph(references, pageOrigin),
      },
      runtime: runtimeSummary,
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
      browserRuntime: runtimeSummary.attempted,
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
