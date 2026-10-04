import { describe, expect, it } from "vitest";
import { StreamingHtmlReferenceExtractor } from "@/lib/discovery/streaming-html";

const limits = {
  maxNodes: 200,
  maxReferences: 64,
  maxScripts: 30,
  maxInlineConfigBytes: 32 * 1024,
  maxInlineConfigUrls: 32,
};
const normalize = (value: string, base: string) => {
  try {
    const url = new URL(value, base);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
};
const parseConfig = (value: string, target: Set<string>) => {
  try {
    const config = JSON.parse(value) as { apiUrl?: string };
    if (config.apiUrl) target.add(config.apiUrl);
  } catch {
    // Invalid bounded config is ignored.
  }
  return false;
};

describe("incremental public HTML extraction", () => {
  it("extracts tags and attributes split across chunks and resolves the first base URL", () => {
    const parser = new StreamingHtmlReferenceExtractor(
      limits,
      parseConfig,
      normalize,
      "https://site.example/",
    );
    const html = `<html><head><script src='bundle.js?x=1&amp;y=2'></script><base href="https://js.stripe.com/v3/"></head><body><link rel=modulepreload href=module.js></body></html>`;
    const bytes = Buffer.from(html);
    for (let offset = 0; offset < bytes.length; offset += 3)
      parser.write(bytes.subarray(offset, offset + 3));
    expect(parser.finish()).toMatchObject({
      scriptUrls: ["https://js.stripe.com/v3/bundle.js", "https://js.stripe.com/v3/module.js"],
      resourceUrls: ["https://js.stripe.com/v3/bundle.js", "https://js.stripe.com/v3/module.js"],
      scriptReferenceLimitReached: false,
    });
  });

  it("finds script references beyond the former 2 MiB retained-prefix boundary", () => {
    const parser = new StreamingHtmlReferenceExtractor(
      limits,
      parseConfig,
      normalize,
      "https://site.example/",
    );
    const prefix = Buffer.alloc(2 * 1024 * 1024, 0x61);
    parser.write(prefix);
    parser.write(Buffer.from('<script src="/late-bundle.js"></script>'));
    expect(parser.finish().scriptUrls).toEqual(["https://site.example/late-bundle.js"]);
  });

  it("decodes split HTML entities, quoted greater-than characters, and split inline config", () => {
    const parser = new StreamingHtmlReferenceExtractor(
      limits,
      parseConfig,
      normalize,
      "https://site.example/",
    );
    const html = `<div data-note="x > y"></div><meta name="api-url" content="https://tenant.supabase.co/project?ignored=1"><script id="public-config" type="application/json">{"apiUrl":"https://tenant.supabase.co/project"}</script><script src="/app.js"></script>`;
    const bytes = Buffer.from(html);
    for (let offset = 0; offset < bytes.length; offset += 7)
      parser.write(bytes.subarray(offset, offset + 7));
    expect(parser.finish()).toMatchObject({
      scriptUrls: ["https://site.example/app.js"],
      inlineConfigUrls: ["https://tenant.supabase.co/project"],
    });
  });

  it("ignores an unfinished tag on truncated input without throwing", () => {
    const parser = new StreamingHtmlReferenceExtractor(
      limits,
      parseConfig,
      normalize,
      "https://site.example/",
    );
    parser.write(Buffer.from('<html><script src="/incomplete.js"'));
    expect(() => parser.finish()).not.toThrow();
    expect(parser.finish().scriptUrls).toEqual([]);
  });

  it("keeps script discovery independent from the general resource budget", () => {
    const parser = new StreamingHtmlReferenceExtractor(
      { ...limits, maxReferences: 1 },
      parseConfig,
      normalize,
      "https://site.example/",
    );
    parser.write(Buffer.from('<img src="/logo.png"><script src="/bundle.js"></script>'));
    expect(parser.finish()).toMatchObject({
      scriptUrls: ["https://site.example/bundle.js"],
      referenceLimitReached: true,
    });
  });

  it("stops tokenizing once the node budget is reached", () => {
    const parser = new StreamingHtmlReferenceExtractor(
      { ...limits, maxNodes: 10 },
      parseConfig,
      normalize,
      "https://site.example/",
    );
    const dense = `${"<div></div>".repeat(50_000)}<script src="/beyond-budget.js"></script>`;
    parser.write(Buffer.from(dense));
    const result = parser.finish();

    expect(result.nodeLimitReached).toBe(true);
    expect(result.nodesVisited).toBe(11);
    expect(result.scriptUrls).toEqual([]);
  });
});
