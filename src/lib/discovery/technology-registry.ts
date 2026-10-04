import type { DiscoveryEvidence, DiscoverySurfaceType } from "@/lib/discovery/discovery";
import type { SignatureInput } from "@/lib/discovery/registry";

export const technologyRegistryVersion = "2026-10-04.1";

export type TechnologyCategory =
  | "framework"
  | "library"
  | "build_tool"
  | "hosting"
  | "monitoring"
  | "analytics"
  | "payments"
  | "identity"
  | "database"
  | "search"
  | "messaging"
  | "ai"
  | "other_service";

export type TechnologyEvidenceFamily =
  | "response_header"
  | "html_structure"
  | "script_asset"
  | "stylesheet_asset"
  | "javascript_bundle"
  | "runtime_network"
  | "public_config";

export type TechnologyObservation = {
  technologySlug: string;
  technologyName: string;
  category: TechnologyCategory;
  fingerprintId: string;
  registryVersion: string;
  evidenceFamily: TechnologyEvidenceFamily;
  strength: "strong" | "medium" | "weak";
  relationship:
    | "framework_for"
    | "built_with"
    | "hosted_on"
    | "optional_integration"
    | "provides_service"
    | "unknown";
  protectability: "protectable" | "non_protectable" | "unknown";
  status: "weak" | "supported" | "strong" | "conflicted" | "suppressed" | "unknown";
  disposition: "observed" | "suggested" | "suppressed";
  suppressionReason:
    | "SUPPRESSED_NON_PROTECTABLE"
    | "FRAMEWORK"
    | "LIBRARY"
    | "BUILD_TOOL"
    | "MARKETING_ONLY"
    | "GENERIC_CDN"
    | "WEAK_EVIDENCE"
    | "CORRELATED_EVIDENCE"
    | "OPTIONAL_INTEGRATION"
    | "INTEGRATION_DIRECTORY"
    | "UNSUPPORTED_PROVIDER"
    | "DERIVED_ONLY"
    | "CONFLICTED_EVIDENCE"
    | null;
  surfaceType: DiscoverySurfaceType;
  surfaceHost: string;
  sourceHost: string;
};

export type TechnologySignatureInput = SignatureInput & {
  markupMarkers?: string[];
};

type Fingerprint = {
  technologySlug: string;
  technologyName: string;
  category: TechnologyCategory;
  fingerprintId: string;
  evidenceFamily: TechnologyEvidenceFamily;
  strength: "strong" | "medium" | "weak";
  relationship: TechnologyObservation["relationship"];
  matches: (input: TechnologySignatureInput) => boolean;
};

function parsedUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isSiteUrl(value: string, siteOrigin: string, path: RegExp) {
  const url = parsedUrl(value);
  return url?.origin === siteOrigin && path.test(url.pathname);
}

function hasHost(values: string[] | undefined, host: string) {
  return (values ?? []).some((value) => parsedUrl(value)?.hostname.toLowerCase() === host);
}

// Exact technical markers only. This registry observes technologies; it never creates candidates.
export const technologyFingerprintRegistry: readonly Fingerprint[] = [
  {
    technologySlug: "nextjs",
    technologyName: "Next.js",
    category: "framework",
    fingerprintId: "nextjs-static-script",
    evidenceFamily: "script_asset",
    strength: "strong",
    relationship: "framework_for",
    matches: (input) =>
      input.scriptUrls.some((url) =>
        isSiteUrl(url, input.siteOrigin, /^\/_next\/static\/.+\.m?js$/i),
      ),
  },
  {
    technologySlug: "react",
    technologyName: "React",
    category: "library",
    fingerprintId: "react-explicit-cdn-script",
    evidenceFamily: "script_asset",
    strength: "strong",
    relationship: "framework_for",
    matches: (input) =>
      (input.scriptUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return (
          (url?.hostname.toLowerCase() === "unpkg.com" &&
            /^\/react(?:-dom)?@[^/]+\//.test(url.pathname)) ||
          (url?.hostname.toLowerCase() === "cdn.jsdelivr.net" &&
            /^\/npm\/react(?:-dom)?@[^/]+\//.test(url.pathname))
        );
      }),
  },
  {
    technologySlug: "tailwindcss",
    technologyName: "Tailwind CSS",
    category: "library",
    fingerprintId: "tailwind-browser-cdn",
    evidenceFamily: "script_asset",
    strength: "strong",
    relationship: "built_with",
    matches: (input) => hasHost(input.scriptUrls, "cdn.tailwindcss.com"),
  },
  {
    technologySlug: "vite",
    technologyName: "Vite",
    category: "build_tool",
    fingerprintId: "vite-client-script",
    evidenceFamily: "script_asset",
    strength: "strong",
    relationship: "built_with",
    matches: (input) =>
      input.scriptUrls.some((url) => isSiteUrl(url, input.siteOrigin, /^\/@vite\/client$/)),
  },
  {
    technologySlug: "wordpress",
    technologyName: "WordPress",
    category: "framework",
    fingerprintId: "wordpress-generator-and-content-path",
    evidenceFamily: "html_structure",
    strength: "strong",
    relationship: "framework_for",
    matches: (input) =>
      input.markupMarkers?.includes("wordpress-generator") === true &&
      (input.resourceUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return (
          url?.origin === input.siteOrigin && /^\/(?:wp-content|wp-includes)\//i.test(url.pathname)
        );
      }),
  },
  {
    technologySlug: "core-js",
    technologyName: "core-js",
    category: "library",
    fingerprintId: "core-js-script-asset",
    evidenceFamily: "script_asset",
    strength: "medium",
    relationship: "built_with",
    matches: (input) =>
      (input.scriptUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return url !== null && /(?:^|\/)core-js(?:\/|(?:\.min)?\.js$)/i.test(url.pathname);
      }),
  },
  {
    technologySlug: "rxjs",
    technologyName: "RxJS",
    category: "library",
    fingerprintId: "rxjs-script-asset",
    evidenceFamily: "script_asset",
    strength: "medium",
    relationship: "built_with",
    matches: (input) =>
      (input.scriptUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return url !== null && /(?:^|\/)rxjs(?:\/|(?:\.umd(?:\.min)?\.js$))/i.test(url.pathname);
      }),
  },
  {
    technologySlug: "bootstrap",
    technologyName: "Bootstrap",
    category: "library",
    fingerprintId: "bootstrap-css-named-asset",
    evidenceFamily: "stylesheet_asset",
    strength: "weak",
    relationship: "built_with",
    matches: (input) =>
      (input.stylesheetUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return url !== null && /(?:^|\/)bootstrap(?:\.min)?\.css$/i.test(url.pathname);
      }),
  },
];

const providerCategories: Record<string, TechnologyCategory> = {
  vercel: "hosting",
  cloudflare: "hosting",
  netlify: "hosting",
  aws: "hosting",
  supabase: "database",
  firebase: "database",
  stripe: "payments",
  clerk: "identity",
  auth0: "identity",
  sentry: "monitoring",
  posthog: "analytics",
  segment: "analytics",
  intercom: "messaging",
  algolia: "search",
  shopify: "payments",
  openai: "ai",
};

function providerFamily(signalType: string): TechnologyEvidenceFamily {
  if (signalType.includes("runtime")) return "runtime_network";
  if (signalType === "response_header") return "response_header";
  if (signalType === "api_endpoint" || signalType === "js_sdk") return "public_config";
  if (signalType === "csp_host") return "response_header";
  if (signalType === "script_path" || signalType === "script_host") return "script_asset";
  return "public_config";
}

export function observeTechnologies(input: {
  signatureInput: TechnologySignatureInput;
  providerEvidence: DiscoveryEvidence[];
  surfaceType: DiscoverySurfaceType;
  surfaceHost: string;
  candidates: ReadonlySet<string>;
}): TechnologyObservation[] {
  const observations: TechnologyObservation[] = [];
  for (const fingerprint of technologyFingerprintRegistry) {
    if (!fingerprint.matches(input.signatureInput)) continue;
    const reason =
      fingerprint.category === "framework"
        ? "FRAMEWORK"
        : fingerprint.category === "library"
          ? "LIBRARY"
          : "BUILD_TOOL";
    observations.push({
      technologySlug: fingerprint.technologySlug,
      technologyName: fingerprint.technologyName,
      category: fingerprint.category,
      fingerprintId: fingerprint.fingerprintId,
      registryVersion: technologyRegistryVersion,
      evidenceFamily: fingerprint.evidenceFamily,
      strength: fingerprint.strength,
      relationship: fingerprint.relationship,
      protectability: "non_protectable",
      status: fingerprint.strength === "weak" ? "weak" : "strong",
      disposition: "suppressed",
      suppressionReason: reason,
      surfaceType: input.surfaceType,
      surfaceHost: input.surfaceHost,
      sourceHost: input.surfaceHost,
    });
  }

  for (const evidence of input.providerEvidence) {
    const category = providerCategories[evidence.providerSlug];
    if (!category) continue;
    const suggested = input.candidates.has(evidence.providerSlug);
    const marketingOnly = evidence.surfaceType === "ROOT_MARKETING" && category !== "hosting";
    const weak = !suggested && evidence.strength === "weak";
    observations.push({
      technologySlug: evidence.providerSlug,
      technologyName: evidence.providerName,
      category,
      fingerprintId: `provider-${evidence.signatureKey}`,
      registryVersion: technologyRegistryVersion,
      evidenceFamily: providerFamily(evidence.signalType),
      strength: evidence.strength,
      relationship: category === "hosting" ? "hosted_on" : "optional_integration",
      protectability: "protectable",
      status: suggested ? "supported" : weak ? "weak" : marketingOnly ? "suppressed" : "strong",
      disposition: suggested ? "suggested" : "suppressed",
      suppressionReason: suggested
        ? null
        : evidence.surfaceType === "INTEGRATION_DIRECTORY"
          ? "INTEGRATION_DIRECTORY"
          : marketingOnly
            ? "MARKETING_ONLY"
            : weak
              ? "WEAK_EVIDENCE"
              : "OPTIONAL_INTEGRATION",
      surfaceType: evidence.surfaceType,
      surfaceHost: evidence.surfaceHost,
      sourceHost: parsedUrl(evidence.sourceOrigin)?.hostname.toLowerCase() ?? "unknown.invalid",
    });
  }

  return [
    ...new Map(
      observations.map((item) => [
        `${item.surfaceType}:${item.surfaceHost}:${item.technologySlug}:${item.fingerprintId}:${item.sourceHost}`,
        item,
      ]),
    ).values(),
  ].slice(0, 250);
}

export function fuseTechnologyObservations(
  observations: TechnologyObservation[],
  suggestedProviders: ReadonlySet<string>,
): TechnologyObservation[] {
  const fused = new Map<string, TechnologyObservation>();
  for (const item of observations) {
    const isProtectable = item.protectability === "protectable";
    const marketingOnly = item.surfaceType === "ROOT_MARKETING" && item.category !== "hosting";
    const suggested =
      isProtectable &&
      !marketingOnly &&
      item.surfaceType !== "INTEGRATION_DIRECTORY" &&
      suggestedProviders.has(item.technologySlug);
    const suppressionReason = suggested
      ? null
      : !isProtectable
        ? (item.suppressionReason ?? "SUPPRESSED_NON_PROTECTABLE")
        : item.surfaceType === "INTEGRATION_DIRECTORY"
          ? "INTEGRATION_DIRECTORY"
          : marketingOnly
            ? "MARKETING_ONLY"
            : item.strength === "weak"
              ? "WEAK_EVIDENCE"
              : "OPTIONAL_INTEGRATION";
    const next = {
      ...item,
      status: suggested
        ? ("supported" as const)
        : !isProtectable
          ? item.status
          : marketingOnly
            ? ("suppressed" as const)
            : item.strength === "weak"
              ? ("weak" as const)
              : ("strong" as const),
      disposition: suggested ? ("suggested" as const) : ("suppressed" as const),
      suppressionReason,
    };
    const key = `${next.surfaceType}:${next.surfaceHost}:${next.technologySlug}:${next.fingerprintId}:${next.sourceHost}`;
    const previous = fused.get(key);
    if (!previous || (next.disposition === "suggested" && previous.disposition !== "suggested"))
      fused.set(key, next);
  }
  return [...fused.values()].slice(0, 250);
}
