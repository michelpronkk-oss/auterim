import type { DiscoveryEvidence, DiscoverySurfaceType } from "@/lib/discovery/discovery";
import type { SignatureInput } from "@/lib/discovery/registry";

export const technologyRegistryVersion = "2026-10-04.2";

export const technologyCategories = [
  "framework",
  "ui_framework",
  "library",
  "build_tool",
  "css_framework",
  "hosting_infrastructure",
  "cdn",
  "database",
  "auth",
  "payments",
  "observability",
  "analytics",
  "customer_messaging",
  "search",
  "ai_api",
  "messaging",
  "email",
  "storage",
  "queue",
  "dev_platform",
  "advertising",
  "captcha",
  "cms",
  "other_external_service",
  "unknown",
] as const;
export type TechnologyCategory = (typeof technologyCategories)[number];

export const technologyEvidenceFamilies = [
  "response_header",
  "cookie_name",
  "html_marker",
  "meta_marker",
  "script_url",
  "asset_path",
  "javascript_bundle",
  "css_bundle",
  "csp_host",
  "public_config",
  "runtime_global",
  "runtime_dom",
  "runtime_script_host",
  "runtime_api_host",
  "runtime_fetch_host",
  "derived_tech_relationship",
] as const;
export type TechnologyEvidenceFamily = (typeof technologyEvidenceFamilies)[number];

export type TechnologyObservation = {
  technologySlug: string;
  technologyName: string;
  category: TechnologyCategory;
  fingerprintId: string;
  registryVersion: string;
  evidenceFamily: TechnologyEvidenceFamily;
  strength: "strong" | "medium" | "weak" | "derived";
  relationship:
    | "framework_for"
    | "built_with"
    | "hosted_on"
    | "optional_integration"
    | "provides_service"
    | "derived_from"
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

export type TechnologyBundle = { url: string; code: string; stringLiterals?: string[] };
export type TechnologyRuntimeFingerprint = {
  fingerprintId: string;
  technologySlug: string;
  technologyName: string;
  category: TechnologyCategory;
  family: "runtime_global" | "runtime_dom";
  strength: "medium" | "strong";
  rationale: string;
  positiveFixture: string;
  negativeFixture: string;
  relationship: TechnologyObservation["relationship"];
  expression: string;
  expectedPrimitive: "function" | "object" | "array" | "present";
  maxLength: number;
  propertyKey?: string;
  selector?: string;
};

export type TechnologySignatureInput = SignatureInput & {
  markupMarkers?: string[];
  javascriptBundles?: TechnologyBundle[];
  cssBundles?: TechnologyBundle[];
  runtimeFingerprintIds?: string[];
};

type Fingerprint = {
  registryVersion: string;
  technologySlug: string;
  technologyName: string;
  category: TechnologyCategory;
  fingerprintId: string;
  evidenceFamily: TechnologyEvidenceFamily;
  strength: "strong" | "medium" | "weak";
  relationship: TechnologyObservation["relationship"];
  rationale: string;
  positiveFixture: string;
  negativeFixture: string;
  matches: (input: TechnologySignatureInput) => boolean;
  protectability?: TechnologyObservation["protectability"];
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

function bundleHasAll(code: string, groups: readonly (readonly string[])[]) {
  return groups.every((group) => group.some((token) => code.includes(token)));
}

function hasBundle(input: TechnologySignatureInput, groups: readonly (readonly string[])[]) {
  return (input.javascriptBundles ?? []).some(({ code, stringLiterals }) =>
    groups.every((group) =>
      group.some(
        (token) =>
          code.includes(token) || (stringLiterals ?? []).some((value) => value.includes(token)),
      ),
    ),
  );
}

function cssHasAll(code: string, groups: readonly (readonly string[])[]) {
  return bundleHasAll(code, groups);
}

// Each content signature uses conjunctions of package/runtime markers, never a lone package name.
// Rationale and fixture labels are machine checked by technology-observation tests.
const fingerprintDefinitions: Omit<Fingerprint, "registryVersion">[] = [
  {
    technologySlug: "nextjs",
    technologyName: "Next.js",
    category: "framework",
    fingerprintId: "nextjs-static-script",
    evidenceFamily: "script_url",
    strength: "strong",
    relationship: "framework_for",
    rationale:
      "A same-origin Next.js build namespace is emitted by the framework runtime, not generic page copy.",
    positiveFixture: "nextjs-static-script",
    negativeFixture: "next-image-optimizer-only",
    matches: (input) =>
      input.scriptUrls.some((url) =>
        isSiteUrl(url, input.siteOrigin, /^\/_next\/static\/.+\.m?js$/i),
      ),
  },
  {
    technologySlug: "react",
    technologyName: "React",
    category: "ui_framework",
    fingerprintId: "react-explicit-cdn-script",
    evidenceFamily: "script_url",
    strength: "strong",
    relationship: "framework_for",
    rationale:
      "Versioned React package paths on exact unpkg/jsDelivr hosts are explicit package assets.",
    positiveFixture: "react-cdn-positive",
    negativeFixture: "react-cdn-lookalike",
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
    technologySlug: "react",
    technologyName: "React",
    category: "ui_framework",
    fingerprintId: "react-dom-bundle-pair",
    evidenceFamily: "javascript_bundle",
    strength: "medium",
    relationship: "built_with",
    rationale:
      "The paired React DOM client import and root API are substantially more specific than either common token alone; bundle presence remains non-protective.",
    positiveFixture: "react-dom-bundle-pair",
    negativeFixture: "react-single-token-bundle",
    matches: (input) => hasBundle(input, [["react-dom/client"], ["createRoot"]]),
  },
  {
    technologySlug: "tailwindcss",
    technologyName: "Tailwind CSS",
    category: "css_framework",
    fingerprintId: "tailwind-browser-cdn",
    evidenceFamily: "script_url",
    strength: "strong",
    relationship: "built_with",
    rationale:
      "The exact Tailwind browser CDN hostname is a provider-specific URL; class names alone are deliberately ignored.",
    positiveFixture: "tailwind-cdn-positive",
    negativeFixture: "tailwind-cdn-lookalike",
    matches: (input) => hasHost(input.scriptUrls, "cdn.tailwindcss.com"),
  },
  {
    technologySlug: "tailwindcss",
    technologyName: "Tailwind CSS",
    category: "css_framework",
    fingerprintId: "tailwind-generated-css-pair",
    evidenceFamily: "css_bundle",
    strength: "strong",
    relationship: "built_with",
    rationale:
      "The paired Tailwind theme variable family and generated utility-layer marker identify compiled Tailwind output; arbitrary utility-like HTML classes are not consulted.",
    positiveFixture: "tailwind-generated-css-pair",
    negativeFixture: "tailwind-css-single-generic-marker",
    matches: (input) =>
      (input.cssBundles ?? []).some(({ code }) =>
        cssHasAll(code, [["--tw-ring-offset-shadow"], ["--tw-ring-shadow"], ["--tw-shadow"]]),
      ),
  },
  {
    technologySlug: "vite",
    technologyName: "Vite",
    category: "build_tool",
    fingerprintId: "vite-client-script",
    evidenceFamily: "script_url",
    strength: "strong",
    relationship: "built_with",
    rationale: "The exact same-origin /@vite/client endpoint is Vite's development client route.",
    positiveFixture: "vite-client-positive",
    negativeFixture: "vite-client-near-miss",
    matches: (input) =>
      input.scriptUrls.some((url) => isSiteUrl(url, input.siteOrigin, /^\/@vite\/client$/)),
  },
  {
    technologySlug: "wordpress",
    technologyName: "WordPress",
    category: "cms",
    fingerprintId: "wordpress-generator-and-content-path",
    evidenceFamily: "html_marker",
    strength: "strong",
    relationship: "framework_for",
    rationale:
      "Requires both a recognized generator marker and a same-origin wp-content/wp-includes asset path.",
    positiveFixture: "wordpress-generator-and-path",
    negativeFixture: "wordpress-generator-only",
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
    technologySlug: "wordpress",
    technologyName: "WordPress",
    category: "cms",
    fingerprintId: "wordpress-path-only-weak",
    evidenceFamily: "asset_path",
    strength: "weak",
    relationship: "unknown",
    rationale:
      "A WordPress namespace can be copied, proxied, or archived; without its paired generator marker this is only a weak observation.",
    positiveFixture: "wordpress-path-only",
    negativeFixture: "wordpress-comment-path-only",
    matches: (input) =>
      !input.markupMarkers?.includes("wordpress-generator") &&
      (input.resourceUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return (
          url?.origin === input.siteOrigin && /^\/(?:wp-content|wp-includes)\//i.test(url.pathname)
        );
      }),
  },
  {
    technologySlug: "wordpress",
    technologyName: "WordPress",
    category: "cms",
    fingerprintId: "wordpress-generator-only-weak",
    evidenceFamily: "meta_marker",
    strength: "weak",
    relationship: "unknown",
    rationale:
      "Generator metadata alone can be stale or copied and cannot support a confident CMS identification.",
    positiveFixture: "wordpress-generator-only",
    negativeFixture: "wordpress-prose-only",
    matches: (input) =>
      input.markupMarkers?.includes("wordpress-generator") === true &&
      !(input.resourceUrls ?? []).some((value) => {
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
    evidenceFamily: "script_url",
    strength: "medium",
    relationship: "built_with",
    rationale:
      "A package-shaped core-js script path is stronger than prose, while remaining a suppressed library observation.",
    positiveFixture: "core-js-script-positive",
    negativeFixture: "core-js-path-lookalike",
    matches: (input) =>
      (input.scriptUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return url !== null && /(?:^|\/)core-js(?:\/|(?:\.min)?\.js$)/i.test(url.pathname);
      }),
  },
  {
    technologySlug: "core-js",
    technologyName: "core-js",
    category: "library",
    fingerprintId: "core-js-bundle-pair",
    evidenceFamily: "javascript_bundle",
    strength: "medium",
    relationship: "built_with",
    rationale:
      "The shared core-js runtime sentinel paired with its module namespace avoids a single package-name match.",
    positiveFixture: "core-js-bundle-pair",
    negativeFixture: "core-js-single-token-bundle",
    matches: (input) => hasBundle(input, [["__core-js_shared__"], ["core-js/modules/"]]),
  },
  {
    technologySlug: "rxjs",
    technologyName: "RxJS",
    category: "library",
    fingerprintId: "rxjs-script-asset",
    evidenceFamily: "script_url",
    strength: "medium",
    relationship: "built_with",
    rationale:
      "A package-shaped RxJS path is more specific than the common Observable token and is suppressed as a library.",
    positiveFixture: "rxjs-script-positive",
    negativeFixture: "rxjs-path-lookalike",
    matches: (input) =>
      (input.scriptUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return url !== null && /(?:^|\/)rxjs(?:\/|(?:\.umd(?:\.min)?\.js$))/i.test(url.pathname);
      }),
  },
  {
    technologySlug: "rxjs",
    technologyName: "RxJS",
    category: "library",
    fingerprintId: "rxjs-bundle-pair",
    evidenceFamily: "javascript_bundle",
    strength: "medium",
    relationship: "built_with",
    rationale:
      "The paired RxJS internal class and subscription protocol marker are less likely to occur together in unrelated application code.",
    positiveFixture: "rxjs-bundle-pair",
    negativeFixture: "rxjs-single-token-bundle",
    matches: (input) => hasBundle(input, [["Subscriber"], ["rxjs/internal", "rxjs/operators"]]),
  },
  {
    technologySlug: "bootstrap",
    technologyName: "Bootstrap",
    category: "css_framework",
    fingerprintId: "bootstrap-css-named-asset",
    evidenceFamily: "asset_path",
    strength: "weak",
    relationship: "built_with",
    rationale:
      "A filename alone can be renamed or unrelated; it is intentionally weak and never protectable.",
    positiveFixture: "bootstrap-css-named-asset",
    negativeFixture: "bootstrap-css-lookalike",
    matches: (input) =>
      (input.stylesheetUrls ?? []).some((value) => {
        const url = parsedUrl(value);
        return url !== null && /(?:^|\/)bootstrap(?:\.min)?\.css$/i.test(url.pathname);
      }),
  },
  {
    technologySlug: "bootstrap",
    technologyName: "Bootstrap",
    category: "css_framework",
    fingerprintId: "bootstrap-css-content-pair",
    evidenceFamily: "css_bundle",
    strength: "medium",
    relationship: "built_with",
    rationale:
      "Bootstrap's reboot plus component-specific button, form, and grid tokens distinguish its generated CSS from generic reset rules.",
    positiveFixture: "bootstrap-css-content-pair",
    negativeFixture: "bootstrap-css-single-generic-marker",
    matches: (input) =>
      (input.cssBundles ?? []).some(({ code }) =>
        cssHasAll(code, [
          ["box-sizing: border-box"],
          ["--bs-btn-"],
          [".form-control"],
          ["--bs-gutter-x"],
        ]),
      ),
  },
  bundleFingerprint({
    slug: "sentry",
    name: "Sentry",
    category: "observability",
    id: "sentry-browser-bundle-pair",
    groups: [
      ["@sentry/browser", "@sentry/nextjs", "@sentry/react"],
      ["captureException", "captureMessage"],
    ],
    rationale:
      "An exact Sentry browser package marker paired with its capture API is more specific than either common string alone; bundle presence is still not active use.",
    positiveFixture: "sentry-bundle-package-and-api",
    negativeFixture: "sentry-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "posthog",
    name: "PostHog",
    category: "analytics",
    id: "posthog-browser-bundle-pair",
    groups: [["posthog-js"], ["capture", "identify"]],
    rationale:
      "The package identifier and client operation must both occur in the same bounded bundle; runtime network evidence is needed for active-use confidence.",
    positiveFixture: "posthog-bundle-package-and-api",
    negativeFixture: "posthog-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "segment",
    name: "Segment",
    category: "analytics",
    id: "segment-browser-bundle-pair",
    groups: [
      ["@segment/analytics", "analytics.js"],
      ["identify", "track"],
    ],
    rationale:
      "A Segment loader/package token paired with an analytics operation narrows the match; it remains suppressed without active provider evidence.",
    positiveFixture: "segment-bundle-package-and-api",
    negativeFixture: "segment-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "intercom",
    name: "Intercom",
    category: "customer_messaging",
    id: "intercom-browser-bundle-pair",
    groups: [
      ["@intercom/messenger-js-sdk", "intercomSettings"],
      ["Intercom", "boot"],
    ],
    rationale:
      "An Intercom-specific SDK/bootstrap marker must pair with its boot operation; the observation alone cannot create a dependency candidate.",
    positiveFixture: "intercom-bundle-bootstrap-pair",
    negativeFixture: "intercom-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "algolia",
    name: "Algolia",
    category: "search",
    id: "algolia-browser-bundle-pair",
    groups: [
      ["algoliasearch", "@algolia/client-search"],
      ["instantsearch", "searchClient"],
    ],
    rationale:
      "Package-specific Algolia client naming plus a search client marker avoids generic search prose; active runtime/provider evidence remains separate.",
    positiveFixture: "algolia-bundle-client-pair",
    negativeFixture: "algolia-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "stripe",
    name: "Stripe",
    category: "payments",
    id: "stripe-browser-bundle-pair",
    groups: [
      ["@stripe/stripe-js", "js.stripe.com"],
      ["loadStripe", "Stripe"],
    ],
    rationale:
      "The official loader package/host marker paired with its loader API indicates bundle support, not active payment usage; only the independent provider candidate pipeline can suggest it.",
    positiveFixture: "stripe-bundle-loader-pair",
    negativeFixture: "stripe-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "clerk",
    name: "Clerk",
    category: "auth",
    id: "clerk-browser-bundle-pair",
    groups: [
      ["@clerk/", "clerk.browser"],
      ["ClerkProvider", "useAuth"],
    ],
    rationale:
      "The namespaced Clerk package marker is paired with an SDK API marker; docs links and a lone Clerk string do not match.",
    positiveFixture: "clerk-bundle-provider-pair",
    negativeFixture: "clerk-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "supabase",
    name: "Supabase",
    category: "database",
    id: "supabase-client-bundle-pair",
    groups: [["@supabase/supabase-js", "supabase-js"], ["createClient"]],
    rationale:
      "The official client package marker and client factory must coexist in one bundle; bundle presence is not proof of backend use or active traffic.",
    positiveFixture: "supabase-bundle-client-pair",
    negativeFixture: "supabase-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "firebase",
    name: "Firebase",
    category: "database",
    id: "firebase-client-bundle-pair",
    groups: [["firebase/app"], ["initializeApp"]],
    rationale:
      "The Firebase app module marker paired with its initialization API is stronger than generic firebase mentions.",
    positiveFixture: "firebase-bundle-app-pair",
    negativeFixture: "firebase-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "datadog",
    name: "Datadog",
    category: "observability",
    id: "datadog-rum-bundle-pair",
    groups: [
      ["@datadog/browser-rum"],
      ["startSessionReplayRecording", "setRumGlobalContext", "init"],
    ],
    rationale:
      "The browser RUM package namespace is required together with an RUM-specific client method; the result remains suppressed absent independent active evidence.",
    positiveFixture: "datadog-bundle-rum-pair",
    negativeFixture: "datadog-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "auth0",
    name: "Auth0",
    category: "auth",
    id: "auth0-spa-bundle-pair",
    groups: [["@auth0/auth0-spa-js"], ["createAuth0Client"]],
    rationale:
      "The official SPA package marker paired with its factory distinguishes SDK code from Auth0 prose.",
    positiveFixture: "auth0-bundle-spa-pair",
    negativeFixture: "auth0-bundle-single-token",
  }),
  bundleFingerprint({
    slug: "webpack",
    name: "Webpack",
    category: "build_tool",
    id: "webpack-runtime-pair",
    groups: [["__webpack_require__"], ["webpackChunk", "webpackJsonpCallback"]],
    rationale:
      "Webpack's module runtime function paired with its chunk-registration global is a specific runtime signature; it is suppressed as build tooling.",
    positiveFixture: "webpack-runtime-pair",
    negativeFixture: "webpack-single-runtime-token",
    protectability: "non_protectable",
  }),
];

export const technologyFingerprintRegistry: readonly Fingerprint[] = fingerprintDefinitions.map(
  (fingerprint) => ({ ...fingerprint, registryVersion: technologyRegistryVersion }),
);

function bundleFingerprint(input: {
  slug: string;
  name: string;
  category: TechnologyCategory;
  id: string;
  groups: readonly (readonly string[])[];
  rationale: string;
  positiveFixture: string;
  negativeFixture: string;
  protectability?: TechnologyObservation["protectability"];
}): Omit<Fingerprint, "registryVersion"> {
  return {
    technologySlug: input.slug,
    technologyName: input.name,
    category: input.category,
    fingerprintId: input.id,
    evidenceFamily: "javascript_bundle",
    strength: "medium",
    relationship: "optional_integration",
    rationale: input.rationale,
    positiveFixture: input.positiveFixture,
    negativeFixture: input.negativeFixture,
    protectability: input.protectability ?? "protectable",
    matches: (signatureInput) => hasBundle(signatureInput, input.groups),
  };
}

export const technologyRuntimeFingerprints: readonly TechnologyRuntimeFingerprint[] = [
  {
    fingerprintId: "runtime-next-data-global",
    technologySlug: "nextjs",
    technologyName: "Next.js",
    category: "framework",
    family: "runtime_global",
    strength: "medium",
    rationale:
      "The known Next.js bootstrap global is a framework runtime marker; only its presence is sampled.",
    positiveFixture: "runtime-next-global-present",
    negativeFixture: "runtime-next-global-absent",
    relationship: "framework_for",
    expression: "typeof window.__NEXT_DATA__ === 'object'",
    expectedPrimitive: "object",
    maxLength: 0,
    propertyKey: "__NEXT_DATA__",
  },
  {
    fingerprintId: "runtime-sentry-global",
    technologySlug: "sentry",
    technologyName: "Sentry",
    category: "observability",
    family: "runtime_global",
    strength: "medium",
    rationale:
      "The recognized public Sentry global name is sampled by primitive type only; its medium signal remains suppressed unless other evidence supports the integration.",
    positiveFixture: "runtime-sentry-global-present",
    negativeFixture: "runtime-sentry-global-absent",
    relationship: "provides_service",
    expression: "typeof window.Sentry === 'object'",
    expectedPrimitive: "object",
    maxLength: 0,
    propertyKey: "Sentry",
  },
  {
    fingerprintId: "runtime-posthog-global",
    technologySlug: "posthog",
    technologyName: "PostHog",
    category: "analytics",
    family: "runtime_global",
    strength: "medium",
    rationale:
      "The public PostHog client object is checked by primitive type only, not serialized.",
    positiveFixture: "runtime-posthog-global-present",
    negativeFixture: "runtime-posthog-global-absent",
    relationship: "provides_service",
    expression: "typeof window.posthog === 'object'",
    expectedPrimitive: "object",
    maxLength: 0,
    propertyKey: "posthog",
  },
  {
    fingerprintId: "runtime-intercom-global",
    technologySlug: "intercom",
    technologyName: "Intercom",
    category: "customer_messaging",
    family: "runtime_global",
    strength: "medium",
    rationale:
      "The documented callable Intercom bootstrap global is sampled as a boolean presence check.",
    positiveFixture: "runtime-intercom-global-present",
    negativeFixture: "runtime-intercom-global-absent",
    relationship: "provides_service",
    expression: "typeof window.Intercom === 'function'",
    expectedPrimitive: "function",
    maxLength: 0,
    propertyKey: "Intercom",
  },
  {
    fingerprintId: "runtime-tailwind-global",
    technologySlug: "tailwindcss",
    technologyName: "Tailwind CSS",
    category: "css_framework",
    family: "runtime_global",
    strength: "medium",
    rationale:
      "The exact browser-CDN runtime global provides a second signal for the same framework observation.",
    positiveFixture: "runtime-tailwind-global-present",
    negativeFixture: "runtime-tailwind-global-absent",
    relationship: "built_with",
    expression: "typeof window.tailwind === 'object'",
    expectedPrimitive: "object",
    maxLength: 0,
    propertyKey: "tailwind",
  },
  {
    fingerprintId: "runtime-next-dom-root",
    technologySlug: "nextjs",
    technologyName: "Next.js",
    category: "framework",
    family: "runtime_dom",
    strength: "medium",
    rationale:
      "The exact app root selector is framework-specific structure; no attributes or DOM content are retained.",
    positiveFixture: "runtime-next-dom-root-present",
    negativeFixture: "runtime-next-dom-root-absent",
    relationship: "framework_for",
    expression: "document.querySelector('#__next') !== null",
    expectedPrimitive: "present",
    maxLength: 0,
    selector: "#__next",
  },
  {
    fingerprintId: "runtime-hcaptcha-frame",
    technologySlug: "hcaptcha",
    technologyName: "hCaptcha",
    category: "captcha",
    family: "runtime_dom",
    strength: "strong",
    rationale:
      "A rendered iframe on the exact hCaptcha host is a provider-specific DOM resource signal.",
    positiveFixture: "runtime-hcaptcha-frame-present",
    negativeFixture: "runtime-captcha-lookalike-frame",
    relationship: "provides_service",
    expression:
      "document.querySelector('iframe[src^=\\\"https://newassets.hcaptcha.com/\\\"]') !== null",
    expectedPrimitive: "present",
    maxLength: 0,
    selector: 'iframe[src^="https://newassets.hcaptcha.com/"]',
  },
  {
    fingerprintId: "runtime-recaptcha-frame",
    technologySlug: "recaptcha",
    technologyName: "reCAPTCHA",
    category: "captcha",
    family: "runtime_dom",
    strength: "strong",
    rationale:
      "A rendered iframe on Google's exact recaptcha host is provider-specific; arbitrary iframe URLs do not match.",
    positiveFixture: "runtime-recaptcha-frame-present",
    negativeFixture: "runtime-captcha-lookalike-frame",
    relationship: "provides_service",
    expression:
      "document.querySelector('iframe[src^=\\\"https://www.google.com/recaptcha/\\\"]') !== null",
    expectedPrimitive: "present",
    maxLength: 0,
    selector: 'iframe[src^="https://www.google.com/recaptcha/"]',
  },
];

const providerCategories: Record<string, TechnologyCategory> = {
  vercel: "hosting_infrastructure",
  cloudflare: "hosting_infrastructure",
  netlify: "hosting_infrastructure",
  aws: "hosting_infrastructure",
  supabase: "database",
  firebase: "database",
  stripe: "payments",
  clerk: "auth",
  auth0: "auth",
  sentry: "observability",
  datadog: "observability",
  posthog: "analytics",
  segment: "analytics",
  intercom: "customer_messaging",
  algolia: "search",
  shopify: "other_external_service",
  openai: "ai_api",
  anthropic: "ai_api",
  paddle: "payments",
  lemonsqueezy: "payments",
  plausible: "analytics",
  googletagmanager: "analytics",
  googleanalytics: "analytics",
  customerio: "customer_messaging",
  hcaptcha: "captcha",
  recaptcha: "captcha",
};

export function providerEvidenceFamily(signalType: string): TechnologyEvidenceFamily {
  const families: Record<string, TechnologyEvidenceFamily> = {
    response_header: "response_header",
    csp_host: "csp_host",
    script_host: "script_url",
    script_path: "script_url",
    js_sdk: "javascript_bundle",
    api_endpoint: "public_config",
    redirect_host: "html_marker",
    resource_host: "asset_path",
    document_host: "html_marker",
    embedded_url: "html_marker",
    markup_marker: "html_marker",
    runtime_host: "runtime_fetch_host",
    runtime_script_host: "runtime_script_host",
    runtime_api_host: "runtime_api_host",
  };
  return families[signalType] ?? "public_config";
}

function reasonForCategory(
  category: TechnologyCategory,
): NonNullable<TechnologyObservation["suppressionReason"]> {
  if (category === "framework" || category === "ui_framework") return "FRAMEWORK";
  if (category === "build_tool") return "BUILD_TOOL";
  if (category === "library" || category === "css_framework") return "LIBRARY";
  return "SUPPRESSED_NON_PROTECTABLE";
}

function makeObservation(
  input: Omit<TechnologyObservation, "registryVersion">,
): TechnologyObservation {
  return { ...input, registryVersion: technologyRegistryVersion };
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
      fingerprint.strength === "weak"
        ? "WEAK_EVIDENCE"
        : fingerprint.protectability === "protectable"
          ? "OPTIONAL_INTEGRATION"
          : reasonForCategory(fingerprint.category);
    observations.push(
      makeObservation({
        technologySlug: fingerprint.technologySlug,
        technologyName: fingerprint.technologyName,
        category: fingerprint.category,
        fingerprintId: fingerprint.fingerprintId,
        evidenceFamily: fingerprint.evidenceFamily,
        strength: fingerprint.strength,
        relationship: fingerprint.relationship,
        protectability: fingerprint.protectability ?? "non_protectable",
        status:
          fingerprint.strength === "weak"
            ? "weak"
            : fingerprint.strength === "strong"
              ? "strong"
              : "supported",
        disposition: "suppressed",
        suppressionReason: reason,
        surfaceType: input.surfaceType,
        surfaceHost: input.surfaceHost,
        sourceHost: input.surfaceHost,
      }),
    );
  }

  const hasWordPressPath = (input.signatureInput.resourceUrls ?? []).some((value) => {
    const url = parsedUrl(value);
    return (
      url?.origin === input.signatureInput.siteOrigin &&
      /^\/(?:wp-content|wp-includes)\//i.test(url.pathname)
    );
  });
  const conflictingCmsGenerator = (input.signatureInput.markupMarkers ?? []).some(
    (marker) => marker.startsWith("cms-generator-") && marker !== "cms-generator-wordpress",
  );
  if (hasWordPressPath && conflictingCmsGenerator) {
    observations.push(
      makeObservation({
        technologySlug: "wordpress",
        technologyName: "WordPress",
        category: "cms",
        fingerprintId: "wordpress-conflicting-cms-markers",
        evidenceFamily: "html_marker",
        strength: "weak",
        relationship: "unknown",
        protectability: "non_protectable",
        status: "conflicted",
        disposition: "suppressed",
        suppressionReason: "CONFLICTED_EVIDENCE",
        surfaceType: input.surfaceType,
        surfaceHost: input.surfaceHost,
        sourceHost: input.surfaceHost,
      }),
    );
  }

  const runtimeIds = new Set(input.signatureInput.runtimeFingerprintIds ?? []);
  for (const fingerprint of technologyRuntimeFingerprints) {
    if (!runtimeIds.has(fingerprint.fingerprintId)) continue;
    observations.push(
      makeObservation({
        technologySlug: fingerprint.technologySlug,
        technologyName: fingerprint.technologyName,
        category: fingerprint.category,
        fingerprintId: fingerprint.fingerprintId,
        evidenceFamily: fingerprint.family,
        strength: fingerprint.strength,
        relationship: fingerprint.relationship,
        protectability: providerCategories[fingerprint.technologySlug]
          ? "protectable"
          : "non_protectable",
        status: "supported",
        disposition: "suppressed",
        suppressionReason: providerCategories[fingerprint.technologySlug]
          ? "OPTIONAL_INTEGRATION"
          : "SUPPRESSED_NON_PROTECTABLE",
        surfaceType: input.surfaceType,
        surfaceHost: input.surfaceHost,
        sourceHost: input.surfaceHost,
      }),
    );
  }

  for (const evidence of input.providerEvidence) {
    const category = providerCategories[evidence.providerSlug];
    if (!category) continue;
    const suggested = input.candidates.has(evidence.providerSlug);
    const marketingOnly =
      evidence.surfaceType === "ROOT_MARKETING" && category !== "hosting_infrastructure";
    const weak = !suggested && evidence.strength === "weak";
    observations.push(
      makeObservation({
        technologySlug: evidence.providerSlug,
        technologyName: evidence.providerName,
        category,
        fingerprintId: `provider-${evidence.signatureKey}`,
        evidenceFamily: providerEvidenceFamily(evidence.signalType),
        strength: evidence.strength,
        relationship: category === "hosting_infrastructure" ? "hosted_on" : "provides_service",
        protectability: "protectable",
        status: suggested
          ? "supported"
          : weak
            ? "weak"
            : marketingOnly
              ? "suppressed"
              : "supported",
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
      }),
    );
  }

  const nextDetected = observations.some(
    (item) => item.technologySlug === "nextjs" && item.strength === "strong",
  );
  const reactObserved = observations.some((item) => item.technologySlug === "react");
  if (nextDetected && !reactObserved) {
    observations.push(
      makeObservation({
        technologySlug: "react",
        technologyName: "React",
        category: "ui_framework",
        fingerprintId: "derived-react-from-nextjs",
        evidenceFamily: "derived_tech_relationship",
        strength: "derived",
        relationship: "derived_from",
        protectability: "non_protectable",
        status: "supported",
        disposition: "suppressed",
        suppressionReason: "DERIVED_ONLY",
        surfaceType: input.surfaceType,
        surfaceHost: input.surfaceHost,
        sourceHost: input.surfaceHost,
      }),
    );
  }

  return dedupe(observations).slice(0, 250);
}

function dedupe(observations: TechnologyObservation[]) {
  return [
    ...new Map(
      observations.map((item) => [
        `${item.surfaceType}:${item.surfaceHost}:${item.technologySlug}:${item.fingerprintId}:${item.sourceHost}`,
        item,
      ]),
    ).values(),
  ];
}

export function fuseTechnologyObservations(
  observations: TechnologyObservation[],
  suggestedProviders: ReadonlySet<string>,
): TechnologyObservation[] {
  const unique = dedupe(observations);
  const byTechnologyAndSurface = new Map<string, TechnologyObservation[]>();
  for (const item of unique) {
    const key = `${item.technologySlug}:${item.surfaceType}:${item.surfaceHost}`;
    byTechnologyAndSurface.set(key, [...(byTechnologyAndSurface.get(key) ?? []), item]);
  }
  return unique.slice(0, 250).map((item) => {
    const key = `${item.technologySlug}:${item.surfaceType}:${item.surfaceHost}`;
    const group = byTechnologyAndSurface.get(key) ?? [item];
    const realFamilies = new Set(
      group
        .filter((observation) => observation.strength !== "derived")
        .map((observation) => observation.evidenceFamily),
    );
    const hasConflict = group.some((observation) => observation.status === "conflicted");
    const independentSupport = realFamilies.size >= 2;
    const sameFamilyCopies = group.filter(
      (observation) => observation.evidenceFamily === item.evidenceFamily,
    ).length;
    const correlatedCopy = sameFamilyCopies > 1;
    const providerCandidate =
      item.protectability === "protectable" && suggestedProviders.has(item.technologySlug);
    const marketingOnly =
      item.surfaceType === "ROOT_MARKETING" && item.category !== "hosting_infrastructure";
    const suggested =
      providerCandidate && !marketingOnly && item.surfaceType !== "INTEGRATION_DIRECTORY";
    const status: TechnologyObservation["status"] = hasConflict
      ? "conflicted"
      : suggested
        ? "supported"
        : item.strength === "weak"
          ? "weak"
          : item.strength === "derived"
            ? "supported"
            : independentSupport
              ? "strong"
              : item.status === "strong"
                ? "strong"
                : "supported";
    const suppressionReason = suggested
      ? null
      : hasConflict
        ? "CONFLICTED_EVIDENCE"
        : correlatedCopy
          ? "CORRELATED_EVIDENCE"
          : (item.suppressionReason ??
            (item.protectability === "protectable"
              ? marketingOnly
                ? "MARKETING_ONLY"
                : item.strength === "weak"
                  ? "WEAK_EVIDENCE"
                  : "OPTIONAL_INTEGRATION"
              : "SUPPRESSED_NON_PROTECTABLE"));
    return {
      ...item,
      status,
      disposition: suggested
        ? "suggested"
        : item.strength === "derived"
          ? "suppressed"
          : "suppressed",
      suppressionReason,
    };
  });
}
