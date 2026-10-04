export type DiscoverySignalType =
  | "response_header"
  | "script_host"
  | "script_path"
  | "document_host"
  | "embedded_url"
  | "markup_marker"
  | "resource_host"
  | "csp_host"
  | "api_endpoint"
  | "js_sdk"
  | "redirect_host"
  | "runtime_host"
  | "runtime_script_host"
  | "runtime_api_host";

export type ProviderSignature = {
  providerSlug: string;
  providerName: string;
  signalType: DiscoverySignalType;
  signatureKey: string;
  strength: "strong" | "medium" | "weak";
  matches: (input: SignatureInput) => boolean;
};

export type SignatureInput = {
  headers: Record<string, string>;
  scriptUrls: string[];
  resourceUrls: string[];
  stylesheetUrls?: string[];
  iframeUrls?: string[];
  formActionUrls?: string[];
  inlineConfigUrls?: string[];
  javascriptUrls?: string[];
  cspHosts?: string[];
  redirectOrigins?: string[];
  javascriptSources?: string[];
  runtimeRequests?: Array<{ host: string; resourceType: string }>;
  embeddedUrls: string[];
  siteOrigin: string;
};

const headerValue = (input: SignatureInput, name: string) =>
  input.headers[name]?.toLowerCase() ?? "";

function urlHost(value: string) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

function hostMatches(host: string, suffix: string) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

const anyUrlHost = (values: string[] | undefined, suffix: string) =>
  (values ?? []).some((value) => hostMatches(urlHost(value), suffix));
const anyCspHost = (values: string[] | undefined, suffix: string) =>
  (values ?? []).some((value) => hostMatches(value.toLowerCase(), suffix));
const anyRedirectHost = (values: string[] | undefined, suffix: string) =>
  (values ?? []).some((value) => hostMatches(urlHost(value), suffix));
const anyScriptHost = (input: SignatureInput, suffix: string) =>
  anyUrlHost(input.scriptUrls, suffix);
const anyRuntimeHost = (input: SignatureInput, suffix: string, resourceTypes: readonly string[]) =>
  (input.runtimeRequests ?? []).some(
    ({ host, resourceType }) =>
      hostMatches(host.toLowerCase(), suffix) && resourceTypes.includes(resourceType),
  );
const anyScriptHostAndPath = (input: SignatureInput, hostSuffix: string, path: string) =>
  input.scriptUrls.some((value) => {
    try {
      const url = new URL(value);
      return hostMatches(url.hostname.toLowerCase(), hostSuffix) && url.pathname.startsWith(path);
    } catch {
      return false;
    }
  });
const anySameOriginScriptPath = (input: SignatureInput, path: string) =>
  input.scriptUrls.some((value) => {
    try {
      const url = new URL(value);
      return url.origin === input.siteOrigin && url.pathname.startsWith(path);
    } catch {
      return false;
    }
  });
const anyJavaScriptSource = (input: SignatureInput, pattern: RegExp) =>
  (input.javascriptSources ?? []).some((source) => pattern.test(source));

// Provider-specific technical markers only. Generic page copy, icons, social links, and arbitrary
// media resources do not qualify as provider evidence.
export const providerSignatureRegistry: readonly ProviderSignature[] = [
  {
    providerSlug: "vercel",
    providerName: "Vercel",
    signalType: "response_header",
    signatureKey: "server-vercel",
    strength: "strong",
    matches: (input) => /(^|\s)vercel($|\s)/i.test(headerValue(input, "server")),
  },
  {
    providerSlug: "vercel",
    providerName: "Vercel",
    signalType: "response_header",
    signatureKey: "x-vercel-id",
    strength: "strong",
    matches: (input) => Boolean(headerValue(input, "x-vercel-id")),
  },
  {
    providerSlug: "vercel",
    providerName: "Vercel",
    signalType: "script_path",
    signatureKey: "vercel-insights-script",
    strength: "medium",
    matches: (input) => anySameOriginScriptPath(input, "/_vercel/insights/"),
  },
  {
    providerSlug: "vercel",
    providerName: "Vercel",
    signalType: "redirect_host",
    signatureKey: "vercel-app-redirect",
    strength: "medium",
    matches: (input) => anyRedirectHost(input.redirectOrigins, "vercel.app"),
  },
  {
    providerSlug: "cloudflare",
    providerName: "Cloudflare",
    signalType: "response_header",
    signatureKey: "cf-ray",
    strength: "strong",
    matches: (input) => Boolean(headerValue(input, "cf-ray")),
  },
  {
    providerSlug: "cloudflare",
    providerName: "Cloudflare",
    signalType: "script_host",
    signatureKey: "cloudflare-insights-script",
    strength: "weak",
    matches: (input) => anyScriptHost(input, "static.cloudflareinsights.com"),
  },
  {
    providerSlug: "netlify",
    providerName: "Netlify",
    signalType: "response_header",
    signatureKey: "x-nf-request-id",
    strength: "strong",
    matches: (input) => Boolean(headerValue(input, "x-nf-request-id")),
  },
  {
    providerSlug: "netlify",
    providerName: "Netlify",
    signalType: "redirect_host",
    signatureKey: "netlify-app-redirect",
    strength: "medium",
    matches: (input) => anyRedirectHost(input.redirectOrigins, "netlify.app"),
  },
  {
    providerSlug: "aws",
    providerName: "Amazon Web Services",
    signalType: "resource_host",
    signatureKey: "cloudfront-resource",
    strength: "weak",
    matches: (input) => anyUrlHost(input.resourceUrls, "cloudfront.net"),
  },
  {
    providerSlug: "supabase",
    providerName: "Supabase",
    signalType: "api_endpoint",
    signatureKey: "supabase-public-api-config",
    strength: "strong",
    matches: (input) => anyUrlHost(input.inlineConfigUrls, "supabase.co"),
  },
  {
    providerSlug: "supabase",
    providerName: "Supabase",
    signalType: "api_endpoint",
    signatureKey: "supabase-public-api-reference",
    strength: "weak",
    matches: (input) => anyUrlHost(input.javascriptUrls, "supabase.co"),
  },
  {
    providerSlug: "supabase",
    providerName: "Supabase",
    signalType: "csp_host",
    signatureKey: "supabase-csp-endpoint",
    strength: "weak",
    matches: (input) => anyCspHost(input.cspHosts, "supabase.co"),
  },
  {
    providerSlug: "supabase",
    providerName: "Supabase",
    signalType: "js_sdk",
    signatureKey: "supabase-create-client",
    strength: "medium",
    matches: (input) =>
      anyJavaScriptSource(input, /createClient\s*\(\s*["'`]https?:\/\/[^"'`]+\.supabase\.co/i),
  },
  {
    providerSlug: "supabase",
    providerName: "Supabase",
    signalType: "runtime_api_host",
    signatureKey: "supabase-runtime-api",
    strength: "strong",
    matches: (input) => anyRuntimeHost(input, "supabase.co", ["fetch", "xhr"]),
  },
  {
    providerSlug: "firebase",
    providerName: "Firebase",
    signalType: "script_host",
    signatureKey: "firebase-sdk-script",
    strength: "strong",
    matches: (input) =>
      anyScriptHost(input, "www.gstatic.com") &&
      input.scriptUrls.some((value) => /\/firebasejs\//i.test(value)),
  },
  {
    providerSlug: "firebase",
    providerName: "Firebase",
    signalType: "api_endpoint",
    signatureKey: "firebase-api-config",
    strength: "strong",
    matches: (input) =>
      ["firebaseio.com", "firebasedatabase.app", "firebaseapp.com"].some((host) =>
        anyUrlHost(input.inlineConfigUrls, host),
      ),
  },
  {
    providerSlug: "firebase",
    providerName: "Firebase",
    signalType: "csp_host",
    signatureKey: "firebase-csp-endpoint",
    strength: "weak",
    matches: (input) =>
      ["firebaseio.com", "firebasedatabase.app", "firebaseapp.com"].some((host) =>
        anyCspHost(input.cspHosts, host),
      ),
  },
  {
    providerSlug: "stripe",
    providerName: "Stripe",
    signalType: "script_host",
    signatureKey: "stripe-js-v3",
    strength: "strong",
    matches: (input) => anyScriptHostAndPath(input, "js.stripe.com", "/v3/"),
  },
  {
    providerSlug: "stripe",
    providerName: "Stripe",
    signalType: "api_endpoint",
    signatureKey: "stripe-checkout-endpoint",
    strength: "strong",
    matches: (input) =>
      anyUrlHost(input.formActionUrls, "checkout.stripe.com") ||
      anyUrlHost(input.inlineConfigUrls, "api.stripe.com"),
  },
  {
    providerSlug: "stripe",
    providerName: "Stripe",
    signalType: "runtime_script_host",
    signatureKey: "stripe-runtime-script",
    strength: "strong",
    matches: (input) => anyRuntimeHost(input, "js.stripe.com", ["script"]),
  },
  {
    providerSlug: "stripe",
    providerName: "Stripe",
    signalType: "runtime_api_host",
    signatureKey: "stripe-runtime-api",
    strength: "strong",
    matches: (input) =>
      anyRuntimeHost(input, "api.stripe.com", ["fetch", "xhr"]) ||
      anyRuntimeHost(input, "checkout.stripe.com", ["document", "fetch", "xhr"]),
  },
  {
    providerSlug: "stripe",
    providerName: "Stripe",
    signalType: "csp_host",
    signatureKey: "stripe-csp-sdk",
    strength: "weak",
    matches: (input) => anyCspHost(input.cspHosts, "js.stripe.com"),
  },
  {
    providerSlug: "clerk",
    providerName: "Clerk",
    signalType: "script_host",
    signatureKey: "clerk-frontend-api",
    strength: "strong",
    matches: (input) =>
      anyScriptHost(input, "clerk.com") || anyScriptHost(input, "clerk.accounts.dev"),
  },
  {
    providerSlug: "clerk",
    providerName: "Clerk",
    signalType: "api_endpoint",
    signatureKey: "clerk-api-config",
    strength: "strong",
    matches: (input) =>
      anyUrlHost(input.inlineConfigUrls, "clerk.com") ||
      anyUrlHost(input.inlineConfigUrls, "clerk.accounts.dev"),
  },
  {
    providerSlug: "auth0",
    providerName: "Auth0",
    signalType: "script_host",
    signatureKey: "auth0-cdn-sdk",
    strength: "strong",
    matches: (input) => anyScriptHost(input, "cdn.auth0.com"),
  },
  {
    providerSlug: "auth0",
    providerName: "Auth0",
    signalType: "api_endpoint",
    signatureKey: "auth0-api-config",
    strength: "medium",
    matches: (input) => anyUrlHost(input.inlineConfigUrls, "auth0.com"),
  },
  {
    providerSlug: "sentry",
    providerName: "Sentry",
    signalType: "script_host",
    signatureKey: "sentry-browser-sdk",
    strength: "strong",
    matches: (input) => anyScriptHost(input, "browser.sentry-cdn.com"),
  },
  {
    providerSlug: "sentry",
    providerName: "Sentry",
    signalType: "api_endpoint",
    signatureKey: "sentry-dsn-config",
    strength: "strong",
    matches: (input) => anyUrlHost(input.inlineConfigUrls, "ingest.sentry.io"),
  },
  {
    providerSlug: "sentry",
    providerName: "Sentry",
    signalType: "csp_host",
    signatureKey: "sentry-csp-endpoint",
    strength: "weak",
    matches: (input) => anyCspHost(input.cspHosts, "ingest.sentry.io"),
  },
  {
    providerSlug: "sentry",
    providerName: "Sentry",
    signalType: "js_sdk",
    signatureKey: "sentry-init",
    strength: "medium",
    matches: (input) => anyJavaScriptSource(input, /Sentry\.init\s*\(/i),
  },
  {
    providerSlug: "sentry",
    providerName: "Sentry",
    signalType: "runtime_script_host",
    signatureKey: "sentry-runtime-script",
    strength: "strong",
    matches: (input) => anyRuntimeHost(input, "browser.sentry-cdn.com", ["script"]),
  },
  {
    providerSlug: "sentry",
    providerName: "Sentry",
    signalType: "runtime_api_host",
    signatureKey: "sentry-runtime-ingest",
    strength: "strong",
    matches: (input) => anyRuntimeHost(input, "ingest.sentry.io", ["fetch", "xhr"]),
  },
  {
    providerSlug: "posthog",
    providerName: "PostHog",
    signalType: "script_host",
    signatureKey: "posthog-js-cdn",
    strength: "strong",
    matches: (input) =>
      anyScriptHost(input, "us.i.posthog.com") ||
      anyScriptHost(input, "eu.i.posthog.com") ||
      anyScriptHost(input, "app.posthog.com"),
  },
  {
    providerSlug: "posthog",
    providerName: "PostHog",
    signalType: "runtime_script_host",
    signatureKey: "posthog-runtime-script",
    strength: "strong",
    matches: (input) =>
      [
        "us.i.posthog.com",
        "eu.i.posthog.com",
        "app.posthog.com",
        "us-assets.i.posthog.com",
        "eu-assets.i.posthog.com",
      ].some((host) => anyRuntimeHost(input, host, ["script"])),
  },
  {
    providerSlug: "posthog",
    providerName: "PostHog",
    signalType: "runtime_api_host",
    signatureKey: "posthog-runtime-api",
    strength: "strong",
    matches: (input) =>
      ["us.i.posthog.com", "eu.i.posthog.com", "us.posthog.com", "eu.posthog.com"].some((host) =>
        anyRuntimeHost(input, host, ["fetch", "xhr"]),
      ),
  },
  {
    providerSlug: "posthog",
    providerName: "PostHog",
    signalType: "api_endpoint",
    signatureKey: "posthog-api-config",
    strength: "medium",
    matches: (input) =>
      ["us.i.posthog.com", "eu.i.posthog.com", "us.posthog.com", "eu.posthog.com"].some((host) =>
        anyUrlHost(input.inlineConfigUrls, host),
      ),
  },
  {
    providerSlug: "posthog",
    providerName: "PostHog",
    signalType: "csp_host",
    signatureKey: "posthog-csp-endpoint",
    strength: "weak",
    matches: (input) =>
      ["us.i.posthog.com", "eu.i.posthog.com", "us.posthog.com", "eu.posthog.com"].some((host) =>
        anyCspHost(input.cspHosts, host),
      ),
  },
  {
    providerSlug: "posthog",
    providerName: "PostHog",
    signalType: "js_sdk",
    signatureKey: "posthog-init",
    strength: "medium",
    matches: (input) => anyJavaScriptSource(input, /posthog\.init\s*\(/i),
  },
  {
    providerSlug: "segment",
    providerName: "Segment",
    signalType: "script_host",
    signatureKey: "segment-analytics-cdn",
    strength: "strong",
    matches: (input) => anyScriptHost(input, "cdn.segment.com"),
  },
  {
    providerSlug: "segment",
    providerName: "Segment",
    signalType: "js_sdk",
    signatureKey: "segment-analytics-load",
    strength: "medium",
    matches: (input) => anyJavaScriptSource(input, /analytics\.load\s*\(/i),
  },
  {
    providerSlug: "intercom",
    providerName: "Intercom",
    signalType: "script_host",
    signatureKey: "intercom-widget-cdn",
    strength: "strong",
    matches: (input) =>
      anyScriptHost(input, "widget.intercom.io") || anyScriptHost(input, "intercomcdn.com"),
  },
  {
    providerSlug: "intercom",
    providerName: "Intercom",
    signalType: "api_endpoint",
    signatureKey: "intercom-api-config",
    strength: "medium",
    matches: (input) => anyUrlHost(input.inlineConfigUrls, "intercom.io"),
  },
  {
    providerSlug: "intercom",
    providerName: "Intercom",
    signalType: "js_sdk",
    signatureKey: "intercom-init",
    strength: "medium",
    matches: (input) => anyJavaScriptSource(input, /Intercom\s*\(/i),
  },
  {
    providerSlug: "algolia",
    providerName: "Algolia",
    signalType: "api_endpoint",
    signatureKey: "algolia-api-config",
    strength: "medium",
    matches: (input) =>
      anyUrlHost(input.inlineConfigUrls, "algolia.net") ||
      anyUrlHost(input.inlineConfigUrls, "algolianet.com"),
  },
  {
    providerSlug: "shopify",
    providerName: "Shopify",
    signalType: "script_path",
    signatureKey: "shopify-storefront-script",
    strength: "medium",
    matches: (input) => anyScriptHostAndPath(input, "cdn.shopify.com", "/shopifycloud/"),
  },
  {
    providerSlug: "openai",
    providerName: "OpenAI",
    signalType: "api_endpoint",
    signatureKey: "openai-api-config",
    strength: "medium",
    matches: (input) => anyUrlHost(input.inlineConfigUrls, "api.openai.com"),
  },
  {
    providerSlug: "openai",
    providerName: "OpenAI",
    signalType: "csp_host",
    signatureKey: "openai-csp-api",
    strength: "weak",
    matches: (input) => anyCspHost(input.cspHosts, "api.openai.com"),
  },
];
