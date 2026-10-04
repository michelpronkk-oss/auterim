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
  failureCategory?: string;
};

type HtmlNode = {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
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

function collectReferences(html: string, baseUrl: string) {
  const tree = parse(html) as unknown as HtmlNode;
  const scripts: string[] = [];
  const resources: string[] = [];
  const firstBaseHref = findFirstBaseHref(tree);
  let effectiveBase = baseUrl;
  if (firstBaseHref) {
    try {
      const base = new URL(firstBaseHref, baseUrl);
      if (
        (base.protocol === "https:" || base.protocol === "http:") &&
        !base.username &&
        !base.password &&
        (base.port === "" || base.port === "80" || base.port === "443")
      ) {
        effectiveBase = base.href;
      }
    } catch {
      // Invalid base tags fall back to the fetched document URL.
    }
  }
  const stack = [tree];
  while (stack.length > 0 && resources.length < 64) {
    const node = stack.pop()!;
    const attrs = new Map((node.attrs ?? []).map((attribute) => [attribute.name, attribute.value]));
    const tagName = node.tagName?.toLowerCase();
    let resourceValue: string | undefined;
    if (tagName === "script") {
      const source = attrs.get("src");
      if (source && scripts.length < 30) {
        try {
          const url = new URL(source, effectiveBase);
          if (
            (url.protocol === "https:" || url.protocol === "http:") &&
            !url.username &&
            !url.password
          ) {
            url.search = "";
            url.hash = "";
            scripts.push(url.href);
            resources.push(url.href);
          }
        } catch {
          // Malformed external script references do not produce discovery evidence.
        }
      }
    } else if (tagName === "link") {
      const rel = attrs.get("rel")?.toLowerCase().split(/\s+/) ?? [];
      if (
        rel.some((value) =>
          ["stylesheet", "preconnect", "preload", "modulepreload", "icon"].includes(value),
        )
      ) {
        resourceValue = attrs.get("href");
      }
    } else if (["img", "iframe", "source"].includes(tagName ?? "")) {
      resourceValue = attrs.get("src");
    } else if (tagName === "video") {
      resourceValue = attrs.get("poster");
    }
    if (resourceValue) {
      try {
        const url = new URL(resourceValue, effectiveBase);
        if (
          (url.protocol === "https:" || url.protocol === "http:") &&
          !url.username &&
          !url.password
        ) {
          url.search = "";
          url.hash = "";
          resources.push(url.href);
        }
      } catch {
        // Malformed resource references do not produce discovery evidence.
      }
    }
    // Reverse-push so traversal and the 30-script cap preserve document order.
    for (const child of [...(node.childNodes ?? [])].reverse()) stack.push(child);
  }
  return { scriptUrls: [...new Set(scripts)], resourceUrls: [...new Set(resources)] };
}

function findFirstBaseHref(tree: HtmlNode): string | null {
  const stack = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.tagName === "base") {
      const href = node.attrs?.find((attribute) => attribute.name === "href")?.value;
      if (href !== undefined) return href;
    }
    for (const child of [...(node.childNodes ?? [])].reverse()) stack.push(child);
  }
  return null;
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
        !url.password
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

function scoreStrength(strength: DiscoveryEvidence["strength"]) {
  return strength === "strong" ? 0.72 : strength === "medium" ? 0.42 : 0.18;
}

function confidenceLabel(confidence: number): DiscoveryCandidate["confidenceLabel"] {
  if (confidence >= 0.8) return "high";
  if (confidence >= 0.5) return "medium";
  return "low";
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
      const strongestBySignal = new Map<DiscoverySignalType, number>();
      for (const item of items) {
        strongestBySignal.set(
          item.signalType,
          Math.max(strongestBySignal.get(item.signalType) ?? 0, scoreStrength(item.strength)),
        );
      }
      const confidence = Number(
        (
          1 -
          [...strongestBySignal.values()].reduce((remainder, score) => remainder * (1 - score), 1)
        ).toFixed(3),
      );
      return {
        providerSlug,
        providerName: items[0]!.providerName,
        confidence,
        confidenceLabel: confidenceLabel(confidence),
        evidence: items,
      };
    })
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
    page = await fetcher(normalizedUrl, {}, { restrictToStandardPorts: true });
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
      failureCategory: "unsafe_target",
    };
  }

  const html = page.body.toString("utf8");
  const { scriptUrls, resourceUrls } = collectReferences(html, page.finalUrl);
  const evidence: DiscoveryEvidence[] = [];
  const seen = new Set<string>();
  matchEvidence(
    {
      headers: page.safeHeaders,
      scriptUrls,
      resourceUrls,
      embeddedUrls: [],
      siteOrigin: pageOrigin,
    },
    pageOrigin,
    seen,
    evidence,
  );

  let scriptsFetched = 0;
  let bytesFetched = 0;
  if (options.deep) {
    const sameOrigin = scriptUrls.filter((scriptUrl) => {
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
              "text/plain",
            ],
            maxResponseBytes: Math.min(discoveryLimits.maxScriptBytes, remaining),
          },
        );
        if (script.body.byteLength > Math.min(discoveryLimits.maxScriptBytes, remaining)) continue;
        scriptsFetched += 1;
        bytesFetched += script.body.byteLength;
        const scriptOrigin = sanitizeSourceOrigin(script.finalUrl);
        if (scriptOrigin) {
          matchEvidence(
            {
              headers: script.safeHeaders,
              scriptUrls: [],
              resourceUrls: [],
              embeddedUrls: collectEmbeddedUrls(script.body.toString("utf8")),
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

  return {
    normalizedUrl,
    status: "completed",
    candidates: makeCandidates(evidence),
    evidence,
    deepPass: { requested: options.deep === true, scriptsFetched, bytesFetched },
  };
}
