export type DiscoverySignalType =
  | "response_header"
  | "script_host"
  | "script_path"
  | "document_host"
  | "embedded_url"
  | "markup_marker";

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
  embeddedUrls: string[];
  siteOrigin: string;
};

const headerValue = (input: SignatureInput, name: string) =>
  input.headers[name]?.toLowerCase() ?? "";
const hasScriptHost = (input: SignatureInput, suffix: string) =>
  input.scriptUrls.some((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === suffix || host.endsWith(`.${suffix}`);
    } catch {
      return false;
    }
  });
const hasScriptHostAndPath = (input: SignatureInput, hostSuffix: string, path: string) =>
  input.scriptUrls.some((value) => {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return (
        (host === hostSuffix || host.endsWith(`.${hostSuffix}`)) && url.pathname.startsWith(path)
      );
    } catch {
      return false;
    }
  });
const hasSameOriginScriptPath = (input: SignatureInput, path: string) =>
  input.scriptUrls.some((value) => {
    try {
      const url = new URL(value);
      return url.origin === input.siteOrigin && url.pathname.startsWith(path);
    } catch {
      return false;
    }
  });
const hasResourceHost = (input: SignatureInput, suffix: string) =>
  input.resourceUrls.some((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === suffix || host.endsWith(`.${suffix}`);
    } catch {
      return false;
    }
  });
const hasEmbeddedHost = (input: SignatureInput, suffix: string) =>
  input.embeddedUrls.some((value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === suffix || host.endsWith(`.${suffix}`);
    } catch {
      return false;
    }
  });

// Each rule is a public, deterministic marker. Arbitrary provider-name mentions in visible copy
// are intentionally not considered evidence.
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
    matches: (input) => hasSameOriginScriptPath(input, "/_vercel/insights/"),
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
    signalType: "document_host",
    signatureKey: "cloudflare-insights-host",
    strength: "medium",
    matches: (input) => hasResourceHost(input, "static.cloudflareinsights.com"),
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
    signalType: "document_host",
    signatureKey: "netlify-app-host",
    strength: "medium",
    matches: (input) => hasResourceHost(input, "netlify.app"),
  },
  {
    providerSlug: "aws",
    providerName: "Amazon Web Services",
    signalType: "document_host",
    signatureKey: "cloudfront-host",
    strength: "weak",
    matches: (input) => hasResourceHost(input, "cloudfront.net"),
  },
  {
    providerSlug: "supabase",
    providerName: "Supabase",
    signalType: "document_host",
    signatureKey: "supabase-public-host",
    strength: "medium",
    matches: (input) => hasResourceHost(input, "supabase.co"),
  },
  {
    providerSlug: "supabase",
    providerName: "Supabase",
    signalType: "embedded_url",
    signatureKey: "supabase-sdk-endpoint-literal",
    strength: "weak",
    matches: (input) => hasEmbeddedHost(input, "supabase.co"),
  },
  {
    providerSlug: "firebase",
    providerName: "Firebase",
    signalType: "document_host",
    signatureKey: "firebase-public-host",
    strength: "medium",
    matches: (input) =>
      hasResourceHost(input, "firebaseapp.com") || hasResourceHost(input, "firebasedatabase.app"),
  },
  {
    providerSlug: "stripe",
    providerName: "Stripe",
    signalType: "script_host",
    signatureKey: "stripe-js-v3",
    strength: "strong",
    matches: (input) => hasScriptHostAndPath(input, "js.stripe.com", "/v3/"),
  },
  {
    providerSlug: "clerk",
    providerName: "Clerk",
    signalType: "script_host",
    signatureKey: "clerk-frontend-api",
    strength: "strong",
    matches: (input) =>
      hasScriptHost(input, "clerk.com") || hasScriptHost(input, "clerk.accounts.dev"),
  },
  {
    providerSlug: "auth0",
    providerName: "Auth0",
    signalType: "script_host",
    signatureKey: "auth0-cdn-sdk",
    strength: "strong",
    matches: (input) => hasScriptHost(input, "cdn.auth0.com"),
  },
  {
    providerSlug: "sentry",
    providerName: "Sentry",
    signalType: "script_host",
    signatureKey: "sentry-browser-sdk",
    strength: "strong",
    matches: (input) => hasScriptHost(input, "browser.sentry-cdn.com"),
  },
  {
    providerSlug: "posthog",
    providerName: "PostHog",
    signalType: "script_host",
    signatureKey: "posthog-js-cdn",
    strength: "strong",
    matches: (input) =>
      hasScriptHost(input, "us.i.posthog.com") || hasScriptHost(input, "app.posthog.com"),
  },
  {
    providerSlug: "segment",
    providerName: "Segment",
    signalType: "script_host",
    signatureKey: "segment-analytics-cdn",
    strength: "strong",
    matches: (input) => hasScriptHost(input, "cdn.segment.com"),
  },
  {
    providerSlug: "intercom",
    providerName: "Intercom",
    signalType: "script_host",
    signatureKey: "intercom-widget-cdn",
    strength: "strong",
    matches: (input) =>
      hasScriptHost(input, "widget.intercom.io") || hasScriptHost(input, "intercomcdn.com"),
  },
  {
    providerSlug: "algolia",
    providerName: "Algolia",
    signalType: "document_host",
    signatureKey: "algolia-search-host",
    strength: "medium",
    matches: (input) =>
      hasResourceHost(input, "algolia.net") || hasResourceHost(input, "algolianet.com"),
  },
  {
    providerSlug: "shopify",
    providerName: "Shopify",
    signalType: "document_host",
    signatureKey: "shopify-cdn-host",
    strength: "medium",
    matches: (input) => hasResourceHost(input, "cdn.shopify.com"),
  },
];
