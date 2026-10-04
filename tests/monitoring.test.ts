import { describe, expect, it } from "vitest";
import { performance } from "node:perf_hooks";
import { gzipSync } from "node:zlib";
import { deterministicDiff, hashContent, normalizeContent } from "@/lib/monitoring/content";
import { fetchHttpSource, isPublicAddress, SafeFetchError } from "@/lib/monitoring/fetcher";

const publicAddresses = async () => [{ address: "93.184.216.34", family: 4 }];
const wire = (
  status: number,
  body: string | Buffer = "",
  headers: Record<string, string> = {},
  cancel?: () => void,
) => ({
  status,
  headers,
  body: (async function* () {
    if (body.length) yield Buffer.isBuffer(body) ? body : Buffer.from(body);
  })(),
  cancel,
});

describe("deterministic content pipeline", () => {
  it("normalizes layout noise while preserving meaningful text order", () => {
    const first = normalizeContent(
      "<html><head><title>ignored</title></head><body><h1>Pricing</h1><p>One   API</p><script>noise</script></body></html>",
    );
    const second = normalizeContent("<h1> Pricing </h1>\n<p>One API</p>");
    expect(first).toBe("Pricing\nOne API");
    expect(second).toBe(first);
    expect(normalizeContent("<p>One API</p><p>Two API</p>")).not.toBe(first);
  });

  it("hashes normalized content deterministically", () => {
    expect(hashContent("stable")).toBe(hashContent("stable"));
    expect(hashContent("stable")).not.toBe(hashContent("changed"));
  });

  it("creates a bounded deterministic line diff with counts", () => {
    const diff = deterministicDiff("alpha\nold", "alpha\nnew\nextra");
    expect(diff.text).toContain("-old");
    expect(diff.text).toContain("+new");
    expect(diff.addedLines).toBe(2);
    expect(diff.removedLines).toBe(1);
    expect(Buffer.byteLength(diff.text)).toBeLessThanOrEqual(16 * 1024);
    expect(deterministicDiff("a", "a")).toMatchObject({ addedLines: 0, removedLines: 0 });
  });
});

describe("safe HTTP fetcher", () => {
  it.each([
    ["192.88.99.1", false],
    ["192.0.2.10", false],
    ["203.0.113.10", false],
    ["93.184.216.34", true],
    ["2001:4860:4860::8888", true],
    ["2001:db8::1", false],
    ["2001::1", false],
    ["3ffe::1", false],
    ["3fff::1", false],
    ["3fff:0fff::1", false],
    ["3fff:1000::1", true],
    ["fc00::1", false],
    ["fe80::1", false],
    ["::ffff:192.0.2.1", false],
  ])("classifies public-routability for %s", (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  it("fetches HTML and sends a bounded conditional request with controlled user agent", async () => {
    let seenHeaders: Record<string, string> = {};
    const result = await fetchHttpSource(
      "https://docs.example.com/pricing",
      { etag: '"v1"', lastModified: "Thu, 01 Jan 2026 00:00:00 GMT" },
      {
        resolveHost: publicAddresses,
        request: async (_url, headers) => {
          seenHeaders = headers;
          return wire(200, "<p>Pricing</p>", {
            "content-type": "text/html; charset=utf-8",
            etag: '"v2"',
          });
        },
      },
    );
    expect(result.body.toString()).toBe("<p>Pricing</p>");
    expect(result).toMatchObject({
      bytesRead: Buffer.byteLength("<p>Pricing</p>"),
      bodyTruncated: false,
    });
    expect(result.etag).toBe('"v2"');
    expect(seenHeaders).toMatchObject({
      "If-None-Match": '"v1"',
      "If-Modified-Since": "Thu, 01 Jan 2026 00:00:00 GMT",
    });
    expect(seenHeaders["User-Agent"]).toMatch(/^AuterimMonitor\//);
  });

  it("streams bounded decoded bytes to a consumer without retaining the response body", async () => {
    const decoded: Buffer[] = [];
    const html = "<html><script src='/late.js'></script></html>";
    const result = await fetchHttpSource(
      "https://docs.example.com/",
      {},
      {
        resolveHost: publicAddresses,
        request: async () =>
          wire(200, gzipSync(Buffer.from(html)), {
            "content-type": "text/html",
            "content-encoding": "gzip",
          }),
        maxResponseBytes: 1024,
        maxWireBytes: 1024,
        allowTruncatedResponse: true,
        retainBody: false,
        onDecodedChunk: (chunk) => decoded.push(Buffer.from(chunk)),
      },
    );
    expect(result.body).toEqual(Buffer.alloc(0));
    expect(Buffer.concat(decoded).toString("utf8")).toBe(html);
    expect(result.bytesRead).toBe(Buffer.byteLength(html));
    expect(result.wireBytesRead).toBe(gzipSync(Buffer.from(html)).byteLength);
  });

  it("validates each redirect destination and rejects HTTPS downgrade", async () => {
    const hosts: string[] = [];
    const result = await fetchHttpSource(
      "https://start.example.com",
      {},
      {
        resolveHost: async (host) => {
          hosts.push(host);
          return publicAddresses();
        },
        request: async (url) =>
          url.hostname === "start.example.com"
            ? wire(302, "", { location: "https://end.example.com/new" })
            : wire(200, "ok", { "content-type": "text/plain" }),
      },
    );
    expect(hosts).toEqual(["start.example.com", "end.example.com"]);
    expect(result.finalUrl).toBe("https://end.example.com/new");
    await expect(
      fetchHttpSource(
        "https://start.example.com",
        {},
        {
          resolveHost: publicAddresses,
          request: async () => wire(302, "", { location: "http://end.example.com/" }),
        },
      ),
    ).rejects.toMatchObject({ category: "unsafe_redirect" });
    await expect(
      fetchHttpSource(
        "https://start.example.com",
        {},
        {
          resolveHost: async (host) =>
            host === "end.example.com" ? [{ address: "127.0.0.1", family: 4 }] : publicAddresses(),
          request: async (url) =>
            url.hostname === "start.example.com"
              ? wire(302, "", { location: "https://end.example.com/" })
              : wire(200, "unsafe"),
        },
      ),
    ).rejects.toMatchObject({ category: "unsafe_target" });
  });

  it("bounds public redirect chains and rejects loops and chains over the limit", async () => {
    const requests: string[] = [];
    const result = await fetchHttpSource(
      "https://redirect-0.example/",
      {},
      {
        resolveHost: publicAddresses,
        request: async (url) => {
          requests.push(url.hostname);
          const index = Number(url.hostname.match(/redirect-(\d+)/)?.[1] ?? "0");
          return index < 3
            ? wire(302, "", { location: `https://redirect-${index + 1}.example/` })
            : wire(200, "safe", { "content-type": "text/plain" });
        },
      },
    );
    expect(result.body.toString()).toBe("safe");
    expect(requests).toHaveLength(4);

    await expect(
      fetchHttpSource(
        "https://loop-a.example/",
        {},
        {
          resolveHost: publicAddresses,
          request: async (url) =>
            wire(302, "", {
              location:
                url.hostname === "loop-a.example"
                  ? "https://loop-b.example/"
                  : "https://loop-a.example/",
            }),
        },
      ),
    ).rejects.toMatchObject({ category: "redirect_loop" });

    let overLimitRequests = 0;
    await expect(
      fetchHttpSource(
        "https://over-limit-0.example/",
        {},
        {
          resolveHost: publicAddresses,
          request: async (url) => {
            overLimitRequests += 1;
            const index = Number(url.hostname.match(/over-limit-(\d+)/)?.[1] ?? "0");
            return wire(302, "", { location: `https://over-limit-${index + 1}.example/` });
          },
        },
      ),
    ).rejects.toMatchObject({ category: "redirect_limit" });
    expect(overLimitRequests).toBe(4);
  });

  it("uses the validated public DNS answer for the connection without a second lookup", async () => {
    let resolveCalls = 0;
    let pinnedAddresses: Array<{ address: string; family: number }> = [];
    const result = await fetchHttpSource(
      "https://rebind.example/",
      {},
      {
        resolveHost: async () => {
          resolveCalls += 1;
          return resolveCalls === 1
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "127.0.0.1", family: 4 }];
        },
        request: async (_url, _headers, addresses) => {
          pinnedAddresses = addresses;
          return wire(200, "public", { "content-type": "text/plain" });
        },
      },
    );

    expect(result.body.toString()).toBe("public");
    expect(resolveCalls).toBe(1);
    expect(pinnedAddresses).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("rejects a discovery redirect to a non-standard port before requesting it", async () => {
    let requestCount = 0;
    await expect(
      fetchHttpSource(
        "https://start.example.com/",
        {},
        {
          resolveHost: publicAddresses,
          restrictToStandardPorts: true,
          request: async () => {
            requestCount += 1;
            return wire(302, "", { location: "https://end.example.com:8443/" });
          },
        },
      ),
    ).rejects.toMatchObject({ category: "unsafe_redirect" });
    expect(requestCount).toBe(1);
  });

  it.each(["https://end.example.com:80/", "http://end.example.com:443/"])(
    "rejects a discovery redirect with a mismatched scheme and standard port: %s",
    async (location) => {
      let requestCount = 0;
      await expect(
        fetchHttpSource(
          "https://start.example.com/",
          {},
          {
            resolveHost: publicAddresses,
            restrictToStandardPorts: true,
            request: async () => {
              requestCount += 1;
              return wire(302, "", { location });
            },
          },
        ),
      ).rejects.toMatchObject({ category: "unsafe_redirect" });
      expect(requestCount).toBe(1);
    },
  );

  it("keeps the optional deep pass on the approved origin after redirects", async () => {
    let requestCount = 0;
    await expect(
      fetchHttpSource(
        "https://start.example.com/app.js",
        {},
        {
          resolveHost: publicAddresses,
          allowedOrigins: ["https://start.example.com"],
          request: async () => {
            requestCount += 1;
            return wire(302, "", { location: "https://third-party.example/app.js" });
          },
        },
      ),
    ).rejects.toMatchObject({ category: "unsafe_redirect" });
    expect(requestCount).toBe(1);
  });

  it("returns only allowlisted provider headers and never cookies", async () => {
    const result = await fetchHttpSource(
      "https://start.example.com/",
      {},
      {
        resolveHost: publicAddresses,
        request: async () =>
          wire(200, "ok", {
            "content-type": "text/html",
            server: "Vercel",
            "x-powered-by": "Next.js",
            "set-cookie": "session=secret",
            authorization: "Bearer secret",
          }),
      },
    );
    expect(result.safeHeaders).toEqual({ server: "Vercel", "x-powered-by": "Next.js" });
  });

  it("supports 304 and rejects timeout, content type, oversize and private destinations", async () => {
    const options = { resolveHost: publicAddresses };
    await expect(
      fetchHttpSource("https://example.com", {}, { ...options, request: async () => wire(304) }),
    ).resolves.toMatchObject({ status: 304, body: Buffer.alloc(0) });
    await expect(
      fetchHttpSource(
        "https://example.com",
        {},
        {
          ...options,
          request: async () => {
            throw new Error("timeout");
          },
        },
      ),
    ).rejects.toMatchObject({ category: "timeout" });
    await expect(
      fetchHttpSource(
        "https://example.com",
        {},
        { ...options, request: async () => wire(200, "x", { "content-type": "application/json" }) },
      ),
    ).rejects.toMatchObject({ category: "invalid_content_type" });
    await expect(
      fetchHttpSource(
        "https://example.com",
        {},
        {
          ...options,
          request: async () =>
            wire(200, "x".repeat(2 * 1024 * 1024 + 1), { "content-type": "text/plain" }),
        },
      ),
    ).rejects.toMatchObject({ category: "response_too_large" });
    await expect(
      fetchHttpSource("http://127.0.0.1/", {}, { request: async () => wire(200) }),
    ).rejects.toBeInstanceOf(SafeFetchError);
    await expect(
      fetchHttpSource(
        "https://example.com",
        {},
        {
          resolveHost: async () => [{ address: "10.1.2.3", family: 4 }],
          request: async () => wire(200),
        },
      ),
    ).rejects.toMatchObject({ category: "unsafe_target" });
  });

  it("retains a bounded prefix when an eligible response exceeds its body budget", async () => {
    let cancelled = false;
    const result = await fetchHttpSource(
      "https://example.com/",
      {},
      {
        resolveHost: publicAddresses,
        maxResponseBytes: 8,
        allowTruncatedResponse: true,
        request: async () =>
          wire(200, "abcdefghijk", { "content-type": "text/html", "content-length": "999" }, () => {
            cancelled = true;
          }),
      },
    );
    expect(result.body.toString()).toBe("abcdefgh");
    expect(result).toMatchObject({ bytesRead: 8, bodyTruncated: true });
    expect(cancelled).toBe(true);
  });

  it("applies the byte limit to actual chunked bytes when Content-Length is missing or low", async () => {
    for (const contentLength of [undefined, "2"]) {
      const headers: Record<string, string> = { "content-type": "text/html" };
      if (contentLength) headers["content-length"] = contentLength;
      const result = await fetchHttpSource(
        "https://example.com/",
        {},
        {
          resolveHost: publicAddresses,
          maxResponseBytes: 6,
          allowTruncatedResponse: true,
          request: async () => ({
            status: 200,
            headers,
            body: (async function* () {
              yield Buffer.from("abc");
              yield Buffer.from("defghi");
            })(),
          }),
        },
      );
      expect(result.body.toString()).toBe("abcdef");
      expect(result).toMatchObject({ bytesRead: 6, bodyTruncated: true });
    }
  });

  it("enforces the decompressed byte budget for compressed responses", async () => {
    const expanded = Buffer.from(`<head><script src="/app.js"></script>${"x".repeat(200_000)}`);
    const compressed = gzipSync(expanded);
    const result = await fetchHttpSource(
      "https://example.com/",
      {},
      {
        resolveHost: publicAddresses,
        maxResponseBytes: 128,
        allowTruncatedResponse: true,
        request: async () =>
          wire(200, compressed, {
            "content-type": "text/html",
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
          }),
      },
    );
    expect(result.body.toString()).toContain('<script src="/app.js">');
    expect(result.body.byteLength).toBe(128);
    expect(result.bodyTruncated).toBe(true);
  });

  it("bounds encoded wire bytes and cancels oversized bodies", async () => {
    let cancelled = false;
    const result = await fetchHttpSource(
      "https://example.com/",
      {},
      {
        resolveHost: publicAddresses,
        maxResponseBytes: 100,
        maxWireBytes: 4,
        allowTruncatedResponse: true,
        request: async () =>
          wire(200, "abcdefgh", { "content-type": "text/html" }, () => {
            cancelled = true;
          }),
      },
    );
    expect(result).toMatchObject({ bytesRead: 4, bodyTruncated: true });
    expect(result.body.toString()).toBe("abcd");
    expect(cancelled).toBe(true);
  });

  it("applies one absolute deadline across redirect hops", async () => {
    let requests = 0;
    await expect(
      fetchHttpSource(
        "https://start.example.com/",
        {},
        {
          resolveHost: publicAddresses,
          timeoutMs: 1_000,
          dnsTimeoutMs: 1_000,
          deadlineAt: performance.now() + 20,
          request: async () => {
            requests += 1;
            await new Promise((resolve) => setTimeout(resolve, 30));
            return wire(302, "", { location: "https://end.example.com/" });
          },
        },
      ),
    ).rejects.toMatchObject({ category: "timeout" });
    expect(requests).toBe(1);
  });

  it("cancels early response bodies for redirects and rejected content types", async () => {
    let redirectCancelled = false;
    await fetchHttpSource(
      "https://start.example.com/",
      {},
      {
        resolveHost: publicAddresses,
        request: async (url) =>
          url.hostname === "start.example.com"
            ? wire(302, "body", { location: "https://end.example.com/" }, () => {
                redirectCancelled = true;
              })
            : wire(200, "ok", { "content-type": "text/html" }),
      },
    );
    expect(redirectCancelled).toBe(true);
    let typeCancelled = false;
    await expect(
      fetchHttpSource(
        "https://example.com/",
        {},
        {
          resolveHost: publicAddresses,
          request: async () =>
            wire(200, "{}", { "content-type": "application/json" }, () => {
              typeCancelled = true;
            }),
        },
      ),
    ).rejects.toMatchObject({ category: "invalid_content_type" });
    expect(typeCancelled).toBe(true);
  });

  it("bounds DNS resolution before starting the HTTP request", async () => {
    let requestCount = 0;
    await expect(
      fetchHttpSource(
        "https://slow-dns.example/",
        {},
        {
          dnsTimeoutMs: 5,
          resolveHost: () => new Promise(() => undefined),
          request: async () => {
            requestCount += 1;
            return wire(200, "ok", { "content-type": "text/html" });
          },
        },
      ),
    ).rejects.toMatchObject({ category: "dns_error" });
    expect(requestCount).toBe(0);
  });
});
