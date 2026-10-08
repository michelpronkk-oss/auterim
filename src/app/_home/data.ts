/**
 * Illustrative homepage content. These values describe the product story on the
 * marketing page only; they are not read from, or written to, any workspace.
 */

export type SourceKind = "P" | "C" | "A" | "D" | "L";
export type CatalogSource = readonly [label: string, kind: SourceKind, url?: string];
export type CatalogEntry = readonly [category: string, sources: readonly CatalogSource[]];

export const catalog: Record<string, CatalogEntry> = {
  OpenAI: [
    "AI",
    [
      ["Pricing", "P", "developers.openai.com/api/docs/pricing"],
      ["Changelog", "C", "platform.openai.com/docs/changelog"],
      ["API documentation", "A", "platform.openai.com/docs/api-reference"],
      ["Deprecations", "D", "platform.openai.com/docs/deprecations"],
      ["Rate limits", "L", "platform.openai.com/docs/guides/rate-limits"],
    ],
  ],
  Anthropic: [
    "AI",
    [
      ["Pricing", "P"],
      ["Release notes", "C"],
      ["API documentation", "A"],
      ["Deprecations", "D"],
    ],
  ],
  Vercel: [
    "Infrastructure",
    [
      ["Pricing", "P"],
      ["Changelog", "C"],
      ["Documentation", "A"],
      ["Limits", "L"],
    ],
  ],
  Supabase: [
    "Databases",
    [
      ["Changelog", "C"],
      ["Documentation", "A"],
      ["Pricing", "P"],
      ["Limits", "L"],
    ],
  ],
  Cloudflare: [
    "Infrastructure",
    [
      ["Changelog", "C"],
      ["Pricing", "P"],
      ["Documentation", "A"],
      ["Terms", "L"],
    ],
  ],
  Resend: [
    "Email",
    [
      ["Changelog", "C"],
      ["API documentation", "A"],
      ["Pricing", "P"],
    ],
  ],
  Postmark: [
    "Email",
    [
      ["Changelog", "C"],
      ["Pricing", "P"],
      ["API documentation", "A"],
    ],
  ],
  PostHog: [
    "Analytics",
    [
      ["Changelog", "C"],
      ["Pricing", "P"],
      ["Documentation", "A"],
    ],
  ],
  Stripe: [
    "Payments",
    [
      ["API changelog", "C"],
      ["Pricing", "P"],
      ["API documentation", "A"],
      ["Deprecations", "D"],
      ["Terms", "L"],
    ],
  ],
  Dodo: [
    "Payments",
    [
      ["Changelog", "C"],
      ["Pricing", "P"],
      ["Terms", "L"],
    ],
  ],
  Clerk: [
    "Authentication",
    [
      ["Changelog", "C"],
      ["Pricing", "P"],
      ["Documentation", "A"],
    ],
  ],
  "Supabase Auth": [
    "Authentication",
    [
      ["Changelog", "C"],
      ["Documentation", "A"],
      ["Limits", "L"],
    ],
  ],
  GitHub: [
    "Developer platforms",
    [
      ["Changelog", "C"],
      ["Pricing", "P"],
      ["Policies", "L"],
    ],
  ],
  AWS: [
    "Cloud services",
    [
      ["Pricing", "P"],
      ["What's new", "C"],
      ["Service terms", "L"],
    ],
  ],
  "Google APIs": [
    "Cloud services",
    [
      ["Deprecations", "D"],
      ["Pricing", "P"],
      ["Documentation", "A"],
      ["Terms", "L"],
    ],
  ],
};

/** Case-insensitive catalog lookup, so scan results like "supabase" still map. */
export function catalogEntry(name: string): readonly [string, CatalogEntry] | null {
  if (catalog[name]) return [name, catalog[name]];
  const key = Object.keys(catalog).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? [key, catalog[key]] : null;
}

export const demoDefs = [
  ["Vercel", "high", "response headers"],
  ["Supabase", "high", "API endpoint"],
  ["Resend", "possible", "embedded URL"],
  ["OpenAI", "possible", "not detected"],
] as const;

export const suggestedProviders = ["OpenAI", "Anthropic", "Dodo", "GitHub", "AWS"];

export const stream = [
  ["Cloudflare", "Dashboard navigation updated", "09:12", "changelog"],
  ["GitHub", "Editor refinements shipped", "09:40", "changelog"],
  ["Vercel", "Docs code example corrected", "10:05", "docs"],
  ["Supabase", "Community post published", "10:31", "blog"],
  ["Resend", "Status page layout changed", "11:02", "status"],
  ["AWS", "New region announced", "11:48", "what's new"],
  ["Anthropic", "Docs pages restructured", "12:20", "docs"],
  ["Google APIs", "Console redesign preview", "13:15", "blog"],
  ["Dodo", "Help center article edited", "13:44", "docs"],
  ["Cloudflare", "Terms formatting edits", "14:30", "terms"],
] as const;

export const relevanceFilters = [
  { k: "Used by you", v: "7 / 12" },
  { k: "Affects behavior or cost", v: "3 / 7" },
  { k: "Needs a decision", v: "2 / 3" },
];

export const surfaced = [
  {
    p: "Stripe",
    t: "Webhook signature version deprecated",
    tag: "▲ ACTION REQUIRED",
    tone: "action",
    meta: "API changelog · 14:02 · affects checkout",
    delay: "0ms",
  },
  {
    p: "OpenAI",
    t: "Pricing updated for a model you use",
    tag: "◆ REVIEW",
    tone: "review",
    meta: "pricing · 11:20 · affects AI costs",
    delay: "150ms",
  },
] as const;

export const publicSignals = [
  { k: "Response headers", v: "server: Vercel · cf-ray", delay: "0s" },
  { k: "Script sources", v: "us.posthog.com/static", delay: ".6s" },
  { k: "Embedded URLs", v: "*.supabase.co endpoint", delay: "1.2s" },
  { k: "Security policy", v: "connect-src api.stripe.com", delay: "1.8s" },
];

export const discoverTable = [
  {
    name: "Vercel",
    disc: "High confidence",
    discTone: "high",
    conf: "Confirmed",
    glyph: "✓",
    state: "confirmed",
  },
  {
    name: "Supabase",
    disc: "High confidence",
    discTone: "high",
    conf: "Confirmed",
    glyph: "✓",
    state: "confirmed",
  },
  {
    name: "Resend",
    disc: "Medium confidence",
    discTone: "possible",
    conf: "Confirmed",
    glyph: "✓",
    state: "confirmed",
  },
  {
    name: "PostHog",
    disc: "Medium confidence",
    discTone: "possible",
    conf: "Not used",
    glyph: "–",
    state: "rejected",
  },
  {
    name: "OpenAI",
    disc: "Not detected",
    discTone: "hidden",
    conf: "Added manually",
    glyph: "+",
    state: "added",
  },
] as const;

export const sourceIcon: Record<SourceKind, string> = { P: "$", C: "±", A: "{}", D: "⌛", L: "≡" };
export const sourceChecked = ["2m ago", "4m ago", "6m ago", "9m ago", "12m ago"];

export const pricingDiff = [
  { n: 112, t: '<div class="pricing-row">', kind: "ctx" },
  { n: 113, t: "-  <span>$2.50 / 1M input</span>", kind: "del" },
  { n: 113, t: "+  <span>$3.00 / 1M input</span>", kind: "add" },
  { n: 114, t: "-  <span>$10.00 / 1M output</span>", kind: "del" },
  { n: 114, t: "+  <span>$12.00 / 1M output</span>", kind: "add" },
  { n: 115, t: "</div>", kind: "ctx" },
  { n: 208, t: '+  <footer class="v2">', kind: "add" },
] as const;

export type MapStatus = "protected" | "watching" | "change" | "review";

export const mapStatusStyle: Record<
  MapStatus,
  { glyph: string; label: string; color: string; dark: string }
> = {
  protected: { glyph: "●", label: "Protected", color: "#2F7358", dark: "#5FA88A" },
  watching: { glyph: "○", label: "Watching", color: "#3A4558", dark: "#C9D1DE" },
  change: { glyph: "◆", label: "Change detected", color: "#8A5F12", dark: "#D9A54A" },
  review: { glyph: "▲", label: "Review needed", color: "#A8402D", dark: "#E07A66" },
};

export const mapStatus: Record<string, MapStatus> = {
  OpenAI: "change",
  Anthropic: "review",
  Vercel: "watching",
  Cloudflare: "protected",
  Supabase: "protected",
  Resend: "watching",
  Dodo: "protected",
};

export const mapGroups = [
  { name: "AI", items: ["OpenAI", "Anthropic"], left: 17, top: 22 },
  { name: "INFRASTRUCTURE", items: ["Vercel", "Cloudflare"], left: 83, top: 22 },
  { name: "DATA", items: ["Supabase"], left: 15, top: 80 },
  { name: "COMMUNICATION", items: ["Resend"], left: 50, top: 86 },
  { name: "BILLING", items: ["Dodo"], left: 85, top: 80 },
];

export const quietStats = [
  { v: "36", k: "dependencies protected" },
  { v: "142", k: "sources monitored" },
  { v: "1,841", k: "checks completed" },
  { v: "0", k: "unresolved critical changes" },
];

export const coverageCategories = [
  "AI",
  "Infrastructure",
  "Databases",
  "Payments",
  "Email",
  "Authentication",
  "Developer platforms",
  "Cloud services",
];

export const ctaPreview = [
  { name: "Vercel", meta: "high confidence", delay: "0ms" },
  { name: "Supabase", meta: "high confidence", delay: "120ms" },
  { name: "OpenAI", meta: "add manually", delay: "240ms" },
  { name: "Resend", meta: "possible", delay: "360ms" },
];
