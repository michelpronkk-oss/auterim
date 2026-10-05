/** Labels and grouping for live catalog data shown by the tools. */

const SOURCE_TYPES: Record<string, string> = {
  documentation: "Documentation",
  changelog: "Changelog",
  api: "API reference",
  deprecation: "Deprecation notices",
  status: "Status page",
  announcement: "Announcements",
  pricing: "Pricing",
  limits: "Limits",
  terms: "Terms",
};

/** Ink first, then blues fading to mist: largest source type gets the darkest swatch. */
const SWATCHES = [
  "#0E1B2E",
  "#2F5BD8",
  "#6E93EE",
  "#A9C0F5",
  "#8FA3C2",
  "#C9D1DE",
  "#5A6577",
  "#DCE5FA",
  "#E4E0D5",
];

export function sourceTypeLabel(type: string) {
  return SOURCE_TYPES[type] ?? type.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

export function coverageTypes(byType: Record<string, number>) {
  return Object.entries(byType)
    .filter(([, count]) => count > 0)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([key, count], i) => ({
      key,
      count,
      label: sourceTypeLabel(key),
      color: SWATCHES[i % SWATCHES.length]!,
    }));
}

export function isDeprecationChange(change: { label: string; headline: string; summary: string }) {
  return /deprecat|sunset|retir|end.of.life|deadline/i.test(
    `${change.label} ${change.headline} ${change.summary}`,
  );
}

const SIGNAL_TYPES: Record<string, string> = {
  response_header: "response header",
  hosting_infrastructure: "hosting",
  redirect_host: "redirect",
  script_host: "script source",
  script_path: "script source",
  runtime_script_host: "script source",
  js_sdk: "JavaScript SDK",
  sdk: "SDK",
  api_endpoint: "API call",
  provider_endpoint: "API call",
  runtime_api_host: "API call",
  runtime_host: "network host",
  resource_host: "linked resource",
  csp_host: "security policy",
  policy_allowlist: "security policy",
  public_config: "page config",
};

/** "Response header, script source": deduplicated, sentence case. */
export function signalTypesLabel(types: string[]) {
  const labels = [...new Set(types.map((type) => SIGNAL_TYPES[type] ?? type.replaceAll("_", " ")))];
  const text = labels.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
