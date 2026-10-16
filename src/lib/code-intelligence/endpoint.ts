const HTTP_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

export type NormalizedChangedEntity =
  | { kind: "endpoint"; value: string; method: string | null; original: string }
  | { kind: "text"; value: string; method: null; original: string }
  | { kind: "invalid"; value: null; method: null; original: string };

/**
 * Canonicalize only URL components that are case-insensitive. Keep path and
 * query identity intact; a trailing slash is a distinct endpoint.
 */
export function normalizeHttpEndpointIdentity(raw: string): string | null {
  if (!raw || raw !== raw.trim() || /\s/.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (!(["http:", "https:"] as string[]).includes(url.protocol) || !url.hostname) return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** Parse an endpoint candidate only when the whole value is a URL or METHOD + URL. */
export function normalizeChangedEntity(value: string): NormalizedChangedEntity {
  const original = value;
  const candidate = value.trim();
  const methodUrl = /^([a-z]+)\s+(https?:\/\/\S+)$/i.exec(candidate);
  if (methodUrl) {
    const method = methodUrl[1]!.toUpperCase();
    const endpoint = normalizeHttpEndpointIdentity(methodUrl[2]!);
    if (!HTTP_METHODS.has(method) || !endpoint)
      return { kind: "invalid", value: null, method: null, original };
    return { kind: "endpoint", value: endpoint, method, original };
  }

  if (/^https?:\/\//i.test(candidate)) {
    const endpoint = normalizeHttpEndpointIdentity(candidate);
    return endpoint
      ? { kind: "endpoint", value: endpoint, method: null, original }
      : { kind: "invalid", value: null, method: null, original };
  }

  // Malformed method/URL-like candidates must not fall back to fuzzy text.
  if (/^[a-z]+\s+https?:\/\//i.test(candidate))
    return { kind: "invalid", value: null, method: null, original };

  return {
    kind: "text",
    value: candidate.toLocaleLowerCase("en-US").replace(/\s+/g, " "),
    method: null,
    original,
  };
}
