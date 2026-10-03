import { describe, expect, it } from "vitest";
import { deterministicDiff, hashContent, normalizeContent } from "@/lib/monitoring/content";
import { fetchHttpSource, SafeFetchError } from "@/lib/monitoring/fetcher";

const publicAddresses = async () => [{ address: "93.184.216.34", family: 4 }];
const wire = (status: number, body = "", headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: (async function* () {
    if (body) yield Buffer.from(body);
  })(),
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
    expect(result.etag).toBe('"v2"');
    expect(seenHeaders).toMatchObject({
      "If-None-Match": '"v1"',
      "If-Modified-Since": "Thu, 01 Jan 2026 00:00:00 GMT",
    });
    expect(seenHeaders["User-Agent"]).toMatch(/^AuterimMonitor\//);
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
});
