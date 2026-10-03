import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 10_000;
const USER_AGENT = "AuterimMonitor/1.0 (+https://auterim.com/monitoring)";

export type FetchResult = {
  status: number;
  body: Buffer;
  contentType: string | null;
  safeHeaders: Record<string, string>;
  etag: string | null;
  lastModified: string | null;
  finalUrl: string;
};

export class SafeFetchError extends Error {
  constructor(
    readonly category: string,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

type WireResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
};

type FetchDependencies = {
  resolveHost?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  request?: (
    url: URL,
    headers: Record<string, string>,
    addresses: Array<{ address: string; family: number }>,
    timeoutMs: number,
  ) => Promise<WireResponse>;
  acceptedContentTypes?: readonly string[];
  maxResponseBytes?: number;
  allowedOrigins?: readonly string[];
  restrictToStandardPorts?: boolean;
};

function parseIPv4(value: string): number[] {
  return value.split(".").map(Number);
}

function ipv6Groups(value: string): number[] | null {
  let input = value.toLowerCase().split("%", 1)[0];
  if (input.includes(".")) {
    const lastColon = input.lastIndexOf(":");
    const ipv4 = parseIPv4(input.slice(lastColon + 1));
    if (ipv4.length !== 4 || ipv4.some((part) => part < 0 || part > 255)) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null;
  return groups.map((part) => Number.parseInt(part, 16));
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = parseIPv4(address);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const allZeroPrefix = groups.slice(0, 5).every((part) => part === 0);
  if (allZeroPrefix && groups[5] === 0xffff) {
    const hi = groups[6]!;
    const lo = groups[7]!;
    return isPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = groups[0]!;
  const unspecified = groups.every((part) => part === 0);
  const loopback = groups.slice(0, 7).every((part) => part === 0) && groups[7] === 1;
  const isDocumentation = first === 0x2001 && groups[1] === 0x0db8;
  const nat64 = first === 0x0064 && groups[1] === 0xff9b;
  return !(
    unspecified ||
    loopback ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xff00) === 0xff00 ||
    isDocumentation ||
    nat64 ||
    first === 0x2002 ||
    (allZeroPrefix && groups[5] === 0)
  );
}

function safeHeader(value: string | null | undefined): string | null {
  if (!value || value.length > 512 || /[\r\n\0]/.test(value)) return null;
  return value;
}

async function resolvePublic(host: string) {
  const normalized = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    !normalized ||
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata"
  ) {
    throw new SafeFetchError("unsafe_target", "The source host is not publicly routable.");
  }
  const family = isIP(normalized);
  const addresses = family
    ? [{ address: normalized, family }]
    : await lookup(normalized, { all: true, verbatim: true }).catch(() => {
        throw new SafeFetchError("dns_error", "The source hostname could not be resolved.");
      });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new SafeFetchError(
      "unsafe_target",
      "The source hostname resolves to a non-public address.",
    );
  }
  return addresses;
}

function nodeRequest(
  url: URL,
  headers: Record<string, string>,
  addresses: Array<{ address: string; family: number }>,
  timeoutMs: number,
) {
  return new Promise<WireResponse>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error, response?: WireResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else if (response) resolve(response);
    };
    const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
    let addressIndex = 0;
    const req = transport(
      url,
      {
        method: "GET",
        headers,
        agent: false,
        signal: AbortSignal.timeout(timeoutMs),
        lookup: (_host, options, callback) => {
          const all =
            typeof options === "object" && options !== null && "all" in options && options.all;
          if (all) callback(null, addresses);
          else {
            const address = addresses[addressIndex++ % addresses.length]!;
            callback(null, address.address, address.family);
          }
        },
      },
      (response) => {
        const responseHeaders: Record<string, string | string[] | undefined> = response.headers;
        done(undefined, {
          status: response.statusCode ?? 0,
          headers: responseHeaders,
          body: response,
        });
      },
    );
    req.once("error", (error) => done(error));
    req.end();
  });
}

async function readBounded(response: WireResponse, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new SafeFetchError(
        "response_too_large",
        "The source response exceeded the configured size limit.",
        response.status,
      );
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "timeout" || error.name === "TimeoutError") return true;
  const cause = "cause" in error ? error.cause : undefined;
  return error.name === "AbortError" && cause instanceof Error && cause.name === "TimeoutError";
}

export async function fetchHttpSource(
  rawUrl: string,
  validators: { etag?: string | null; lastModified?: string | null } = {},
  dependencies: FetchDependencies = {},
): Promise<FetchResult> {
  let current: URL;
  try {
    current = new URL(rawUrl);
  } catch {
    throw new SafeFetchError("invalid_url", "The source URL is invalid.");
  }
  const originalProtocol = current.protocol;
  const originalOrigin = current.origin;
  const visited = new Set<string>();
  const resolveHost = dependencies.resolveHost ?? resolvePublic;
  const request = dependencies.request ?? nodeRequest;
  const conditional = new Map<string, string>();
  const etag = safeHeader(validators.etag);
  const lastModified = safeHeader(validators.lastModified);
  if (etag) conditional.set("If-None-Match", etag);
  if (lastModified) conditional.set("If-Modified-Since", lastModified);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new SafeFetchError("invalid_scheme", "Only HTTP and HTTPS sources are supported.");
    }
    if (current.username || current.password) {
      throw new SafeFetchError("unsafe_target", "Source URLs cannot contain embedded credentials.");
    }
    if (originalProtocol === "https:" && current.protocol !== "https:") {
      throw new SafeFetchError("unsafe_redirect", "HTTPS sources cannot redirect to HTTP.");
    }
    if (dependencies.allowedOrigins && !dependencies.allowedOrigins.includes(current.origin)) {
      throw new SafeFetchError(
        "unsafe_redirect",
        "The source redirected outside the approved origin.",
      );
    }
    if (
      dependencies.restrictToStandardPorts &&
      current.port !== "" &&
      current.port !== "80" &&
      current.port !== "443"
    ) {
      throw new SafeFetchError("unsafe_redirect", "The source uses a non-standard public port.");
    }
    current.hash = "";
    if (visited.has(current.href))
      throw new SafeFetchError("redirect_loop", "The source redirected in a loop.");
    visited.add(current.href);

    let addresses: Array<{ address: string; family: number }>;
    try {
      addresses = await resolveHost(current.hostname);
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      throw new SafeFetchError("dns_error", "The source hostname could not be validated.");
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new SafeFetchError(
        "unsafe_target",
        "The source hostname resolves to a non-public address.",
      );
    }

    let response: WireResponse;
    try {
      response = await request(
        current,
        {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
          ...(current.origin === originalOrigin ? Object.fromEntries(conditional) : {}),
        },
        addresses,
        REQUEST_TIMEOUT_MS,
      );
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      if (isTimeout(error)) {
        throw new SafeFetchError("timeout", "The source request timed out.");
      }
      throw new SafeFetchError("network_error", "The source request failed.");
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const locationValue = response.headers.location;
      const location = Array.isArray(locationValue) ? locationValue[0] : locationValue;
      if (!location || redirectCount === MAX_REDIRECTS) {
        throw new SafeFetchError(
          "redirect_limit",
          "The source exceeded the redirect limit.",
          response.status,
        );
      }
      try {
        current = new URL(location, current);
      } catch {
        throw new SafeFetchError(
          "unsafe_redirect",
          "The source returned an invalid redirect URL.",
          response.status,
        );
      }
      continue;
    }

    const contentTypeHeader = response.headers["content-type"];
    const contentTypeRaw = Array.isArray(contentTypeHeader)
      ? contentTypeHeader[0]
      : contentTypeHeader;
    const contentType = contentTypeRaw?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
    const etagHeader = response.headers.etag;
    const modifiedHeader = response.headers["last-modified"];
    const returnedEtag = safeHeader(Array.isArray(etagHeader) ? etagHeader[0] : etagHeader);
    const returnedModified = safeHeader(
      Array.isArray(modifiedHeader) ? modifiedHeader[0] : modifiedHeader,
    );

    if (response.status === 304) {
      return {
        status: 304,
        body: Buffer.alloc(0),
        contentType,
        safeHeaders: {},
        etag: returnedEtag,
        lastModified: returnedModified,
        finalUrl: current.href,
      };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new SafeFetchError(
        "http_error",
        `The source returned HTTP ${response.status}.`,
        response.status,
      );
    }
    const acceptedContentTypes = dependencies.acceptedContentTypes ?? [
      "text/html",
      "application/xhtml+xml",
      "text/plain",
    ];
    if (!contentType || !acceptedContentTypes.includes(contentType)) {
      throw new SafeFetchError(
        "invalid_content_type",
        "The source did not return HTML or plain text.",
        response.status,
      );
    }

    let body: Buffer;
    try {
      body = await readBounded(response, dependencies.maxResponseBytes ?? MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof SafeFetchError) throw error;
      if (isTimeout(error)) throw new SafeFetchError("timeout", "The source response timed out.");
      throw new SafeFetchError("network_error", "The source response could not be read.");
    }
    return {
      status: response.status,
      body,
      contentType,
      safeHeaders: Object.fromEntries(
        [
          "server",
          "x-powered-by",
          "x-vercel-id",
          "x-vercel-cache",
          "cf-ray",
          "x-nf-request-id",
          "x-served-by",
        ].flatMap((name) => {
          const value = response.headers[name];
          const header = safeHeader(Array.isArray(value) ? value[0] : value);
          return header ? [[name, header]] : [];
        }),
      ),
      etag: returnedEtag,
      lastModified: returnedModified,
      finalUrl: current.href,
    };
  }
  throw new SafeFetchError("redirect_limit", "The source exceeded the redirect limit.");
}
