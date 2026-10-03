export const publicConversionEvents = [
  "homepage_view",
  "stack_scan_started",
  "stack_scan_completed",
  "scan_result_continue",
  "signup_started",
  "signup_completed",
  "protection_activation",
  "github_connect_started",
  "github_connected",
  "trial_started",
] as const;

export type PublicConversionEvent = (typeof publicConversionEvents)[number];

export type PublicAttribution = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  landingPath?: string;
};

const safeAttributionValue = (value: string | null) =>
  value && /^[\p{L}\p{N}._ -]{1,100}$/u.test(value) ? value : undefined;

export function readPublicAttribution(
  search: URLSearchParams,
  landingPath: string,
): PublicAttribution {
  return {
    utmSource: safeAttributionValue(search.get("utm_source")),
    utmMedium: safeAttributionValue(search.get("utm_medium")),
    utmCampaign: safeAttributionValue(search.get("utm_campaign")),
    landingPath: /^\/[a-z0-9/_-]{1,160}$/i.test(landingPath) ? landingPath : "/",
  };
}

/** A local event contract for first-party instrumentation; no third-party analytics is loaded. */
export function emitPublicConversionEvent(
  event: PublicConversionEvent,
  attribution: PublicAttribution = {},
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("auterim:public-conversion", {
      detail: { event, attribution },
    }),
  );
}
