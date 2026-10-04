export class WebsiteUrlInputError extends Error {
  constructor(
    readonly category: "invalid_url" | "unsafe_target",
    message: string,
  ) {
    super(message);
    this.name = "WebsiteUrlInputError";
  }
}

/** Canonical public website identity used by discovery, company persistence, and client prefill. */
export function canonicalizePublicWebsiteUrl(value: string): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new WebsiteUrlInputError("invalid_url", "Enter a valid company website.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new WebsiteUrlInputError("invalid_url", "Enter a valid company website.");
  }

  const input = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new WebsiteUrlInputError("invalid_url", "Enter a valid company website.");
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port !== "" &&
      !(
        (url.protocol === "http:" && url.port === "80") ||
        (url.protocol === "https:" && url.port === "443")
      ))
  ) {
    throw new WebsiteUrlInputError("unsafe_target", "This website address is not supported.");
  }

  // A company is identified by its public site origin, never by a route or query string.
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.href;
}
