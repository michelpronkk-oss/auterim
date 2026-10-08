import type { ProviderCandidate } from "./types.js";

export const PROVIDER_PACKAGE_MAP_VERSION = "m15.6-provider-map-1";

type Provider = { slug: string; name: string };
const provider = (slug: string, name: string): Provider => ({ slug, name });

// Every slug below is present in the canonical dependency_catalog seed migrations.
// Unlisted packages remain unknown observations; this file never creates providers.
const packageProviders: Record<string, Provider> = {
  "@anthropic-ai/sdk": provider("anthropic", "Anthropic"),
  "@auth0/nextjs-auth0": provider("auth0", "Auth0"),
  "@clerk/clerk-react": provider("clerk", "Clerk"),
  "@clerk/nextjs": provider("clerk", "Clerk"),
  "@google-cloud/storage": provider("google-cloud-storage", "Google Cloud Storage"),
  "@google/generative-ai": provider("gemini-api", "Gemini API"),
  "@linear/sdk": provider("linear", "Linear"),
  "@octokit/rest": provider("github", "GitHub"),
  "@posthog/nextjs": provider("posthog", "PostHog"),
  "@posthog/react": provider("posthog", "PostHog"),
  "@sentry/browser": provider("sentry", "Sentry"),
  "@sentry/nextjs": provider("sentry", "Sentry"),
  "@sentry/node": provider("sentry", "Sentry"),
  "@sentry/react": provider("sentry", "Sentry"),
  "@sendgrid/mail": provider("sendgrid", "Twilio SendGrid"),
  "@slack/web-api": provider("slack", "Slack"),
  "@stripe/stripe-js": provider("stripe", "Stripe"),
  "@supabase/ssr": provider("supabase", "Supabase"),
  "@supabase/supabase-js": provider("supabase", "Supabase"),
  "@upstash/redis": provider("upstash", "Upstash"),
  "@upstash/ratelimit": provider("upstash", "Upstash"),
  "@vercel/analytics": provider("vercel", "Vercel"),
  "@vercel/blob": provider("vercel", "Vercel"),
  "@vercel/kv": provider("vercel", "Vercel"),
  "@vercel/postgres": provider("vercel", "Vercel"),
  "@vercel/speed-insights": provider("vercel", "Vercel"),
  "@workos-inc/authkit-nextjs": provider("workos", "WorkOS"),
  anthropic: provider("anthropic", "Anthropic"),
  "auth0-js": provider("auth0", "Auth0"),
  "firebase-admin": provider("firebase", "Firebase"),
  "firebase-functions": provider("firebase", "Firebase"),
  firebase: provider("firebase", "Firebase"),
  "google-auth-library": provider("google-cloud", "Google Cloud"),
  googleapis: provider("google-cloud", "Google Cloud"),
  "mailgun.js": provider("mailgun", "Mailgun"),
  openai: provider("openai", "OpenAI"),
  "posthog-js": provider("posthog", "PostHog"),
  posthog: provider("posthog", "PostHog"),
  resend: provider("resend", "Resend"),
  sentry: provider("sentry", "Sentry"),
  "sentry-sdk": provider("sentry", "Sentry"),
  slack: provider("slack", "Slack"),
  stripe: provider("stripe", "Stripe"),
  "supabase-js": provider("supabase", "Supabase"),
  twilio: provider("twilio", "Twilio"),
};

const environmentPrefixes: Array<{ prefix: string; provider: Provider }> = [
  { prefix: "ANTHROPIC_", provider: provider("anthropic", "Anthropic") },
  { prefix: "AUTH0_", provider: provider("auth0", "Auth0") },
  { prefix: "CLERK_", provider: provider("clerk", "Clerk") },
  { prefix: "DODO_", provider: provider("dodo-payments", "Dodo Payments") },
  { prefix: "FIREBASE_", provider: provider("firebase", "Firebase") },
  { prefix: "GITHUB_", provider: provider("github", "GitHub") },
  { prefix: "LINEAR_", provider: provider("linear", "Linear") },
  { prefix: "OPENAI_", provider: provider("openai", "OpenAI") },
  { prefix: "POSTHOG_", provider: provider("posthog", "PostHog") },
  { prefix: "RESEND_", provider: provider("resend", "Resend") },
  { prefix: "SENTRY_", provider: provider("sentry", "Sentry") },
  { prefix: "SLACK_", provider: provider("slack", "Slack") },
  { prefix: "STRIPE_", provider: provider("stripe", "Stripe") },
  { prefix: "SUPABASE_", provider: provider("supabase", "Supabase") },
  { prefix: "VERCEL_", provider: provider("vercel", "Vercel") },
];

export function resolvePackageProvider(identifier: string): ProviderCandidate {
  const found = packageProviders[identifier.toLowerCase()];
  return found
    ? { status: "known", providerSlug: found.slug, providerName: found.name }
    : { status: "unknown", providerSlug: null, providerName: null };
}

export function resolveEnvironmentProvider(identifier: string): ProviderCandidate | null {
  const normalized = identifier.toUpperCase();
  const found = environmentPrefixes.find((candidate) => normalized.startsWith(candidate.prefix));
  return found
    ? {
        status: "known",
        providerSlug: found.provider.slug,
        providerName: found.provider.name,
      }
    : null;
}

const providerHosts: Array<{ suffix: string; provider: Provider }> = [
  { suffix: "anthropic.com", provider: provider("anthropic", "Anthropic") },
  { suffix: "auth0.com", provider: provider("auth0", "Auth0") },
  { suffix: "clerk.com", provider: provider("clerk", "Clerk") },
  { suffix: "cloudflare.com", provider: provider("cloudflare", "Cloudflare") },
  { suffix: "cloudflareworkers.com", provider: provider("cloudflare", "Cloudflare") },
  { suffix: "firebase.google.com", provider: provider("firebase", "Firebase") },
  { suffix: "googleapis.com", provider: provider("google-cloud", "Google Cloud") },
  { suffix: "github.com", provider: provider("github", "GitHub") },
  { suffix: "linear.app", provider: provider("linear", "Linear") },
  { suffix: "openai.com", provider: provider("openai", "OpenAI") },
  { suffix: "posthog.com", provider: provider("posthog", "PostHog") },
  { suffix: "resend.com", provider: provider("resend", "Resend") },
  { suffix: "sentry.io", provider: provider("sentry", "Sentry") },
  { suffix: "slack.com", provider: provider("slack", "Slack") },
  { suffix: "stripe.com", provider: provider("stripe", "Stripe") },
  { suffix: "supabase.com", provider: provider("supabase", "Supabase") },
  { suffix: "supabase.co", provider: provider("supabase", "Supabase") },
  { suffix: "vercel.com", provider: provider("vercel", "Vercel") },
];

export function resolveProviderHost(hostname: string): ProviderCandidate | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const found = providerHosts.find(
    (candidate) => host === candidate.suffix || host.endsWith(`.${candidate.suffix}`),
  );
  return found
    ? { status: "known", providerSlug: found.provider.slug, providerName: found.provider.name }
    : null;
}

const providerModels: Array<{ pattern: RegExp; provider: Provider }> = [
  { pattern: /^(?:gpt-|o[134](?:-|$))/i, provider: provider("openai", "OpenAI") },
  { pattern: /^claude-/i, provider: provider("anthropic", "Anthropic") },
  { pattern: /^gemini-/i, provider: provider("gemini-api", "Gemini API") },
  { pattern: /^command(?:-|$)/i, provider: provider("cohere", "Cohere") },
  { pattern: /^mistral-/i, provider: provider("mistral-ai", "Mistral AI") },
];

export function resolveModelProvider(identifier: string): ProviderCandidate | null {
  const found = providerModels.find((candidate) => candidate.pattern.test(identifier));
  return found
    ? { status: "known", providerSlug: found.provider.slug, providerName: found.provider.name }
    : null;
}
