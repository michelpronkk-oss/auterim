import { describe, expect, it } from "vitest";
import {
  discoveryLimits,
  discoverWebsiteDependencies,
  normalizePublicWebsiteUrl,
  type UrlDiscoveryResult,
} from "@/lib/discovery/discovery";
import { runWebsiteDependencyDiscovery } from "@/lib/discovery/run";
import { discoveryWebsiteUrlSchema } from "@/lib/discovery/schema";
import { fetchHttpSource, SafeFetchError, type FetchResult } from "@/lib/monitoring/fetcher";

const page = (html: string, safeHeaders: Record<string, string> = {}): FetchResult => ({
  status: 200,
  body: Buffer.from(html),
  bytesRead: Buffer.byteLength(html),
  bodyTruncated: false,
  contentType: "text/html",
  safeHeaders,
  etag: null,
  lastModified: null,
  finalUrl: "https://company.example/",
});

const cases: Array<{
  name: string;
  html?: string;
  headers?: Record<string, string>;
  slug: string;
}> = [
  { name: "Vercel server header", headers: { server: "Vercel" }, slug: "vercel" },
  { name: "Vercel response id", headers: { "x-vercel-id": "sfo1::abc" }, slug: "vercel" },
  {
    name: "Vercel insights script",
    html: '<script src="/_vercel/insights/script.js"></script>',
    slug: "vercel",
  },
  { name: "Cloudflare ray header", headers: { "cf-ray": "abc" }, slug: "cloudflare" },
  { name: "Netlify request header", headers: { "x-nf-request-id": "abc" }, slug: "netlify" },
  {
    name: "Supabase inline public API config",
    html: '<script type="application/json" id="runtime-config">{"apiUrl":"https://project.supabase.co"}</script>',
    slug: "supabase",
  },
  {
    name: "Firebase SDK script",
    html: '<script src="https://www.gstatic.com/firebasejs/10.0.0/firebase-app.js"></script>',
    slug: "firebase",
  },
  {
    name: "Stripe JS v3",
    html: '<script src="https://js.stripe.com/v3/"></script>',
    slug: "stripe",
  },
  {
    name: "Clerk frontend host",
    html: '<script src="https://clerk.accounts.dev/npm/@clerk/clerk-js"></script>',
    slug: "clerk",
  },
  {
    name: "Auth0 SDK host",
    html: '<script src="https://cdn.auth0.com/js/auth0/9.0/auth0.min.js"></script>',
    slug: "auth0",
  },
  {
    name: "Sentry browser SDK",
    html: '<script src="https://browser.sentry-cdn.com/7.0/bundle.min.js"></script>',
    slug: "sentry",
  },
  {
    name: "PostHog public host",
    html: '<script src="https://us.i.posthog.com/static/array.js"></script>',
    slug: "posthog",
  },
  {
    name: "Segment analytics host",
    html: '<script src="https://cdn.segment.com/analytics.js/v1/example/analytics.min.js"></script>',
    slug: "segment",
  },
  {
    name: "Intercom widget host",
    html: '<script src="https://widget.intercom.io/widget/example"></script>',
    slug: "intercom",
  },
  {
    name: "Algolia search host",
    html: '<script type="application/json" id="app-config">{"searchEndpoint":"https://123-dsn.algolia.net/1/indexes"}</script>',
    slug: "algolia",
  },
  {
    name: "Shopify CDN host",
    html: '<script src="https://cdn.shopify.com/shopifycloud/storefront.js"></script>',
    slug: "shopify",
  },
  {
    name: "Firebase database host",
    html: '<script type="application/json" id="app-config">{"apiUrl":"https://project.firebasedatabase.app"}</script>',
    slug: "firebase",
  },
];

async function discover(
  html: string,
  headers: Record<string, string> = {},
  deep = false,
  responseForUrl?: (url: string) => FetchResult,
): Promise<UrlDiscoveryResult> {
  return discoverWebsiteDependencies("https://company.example/", {
    deep,
    fetcher: async (url) =>
      url === "https://company.example/"
        ? page(html, headers)
        : (responseForUrl?.(url) ?? page(html, headers)),
  });
}

describe("offline URL dependency evaluation", () => {
  it.each(cases)("detects $name from its registered public signature", async (fixture) => {
    const result = await discover(fixture.html ?? "", fixture.headers);
    expect(result.status).toBe("completed");
    expect(result.candidates.map((candidate) => candidate.providerSlug)).toContain(fixture.slug);
  });

  it("normalizes to the public origin and strips route, query, and fragment", () => {
    expect(
      normalizePublicWebsiteUrl("https://example.com/private/customer?token=secret#page"),
    ).toBe("https://example.com/");
  });

  it.each([
    ["example.com", "https://example.com/"],
    ["  www.example.com/path?q=1  ", "https://www.example.com/"],
    ["http://example.com/path", "http://example.com/"],
  ])("normalizes a company website input %s", (input, expected) => {
    expect(normalizePublicWebsiteUrl(input)).toBe(expected);
  });

  it.each([
    "file:///etc/passwd",
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com:80/",
    "http://example.com:443/",
    "not a URL",
  ])("rejects unsafe or malformed website input: %s", (url) => {
    expect(() => normalizePublicWebsiteUrl(url)).toThrow();
  });

  it.each([
    "ftp://example.com/",
    "https://user:password@example.com/",
    "https://example.com:8443/",
    "https://example.com:80/",
    "http://example.com:443/",
    "not a URL",
  ])("rejects a permanently invalid task URL before task execution: %s", (url) => {
    expect(discoveryWebsiteUrlSchema.safeParse(url).success).toBe(false);
  });

  it("does not infer a provider from a company name in visible copy", async () => {
    const result = await discover("<p>We love Stripe and Cloudflare products.</p>");
    expect(result.candidates).toEqual([]);
  });

  it.each([
    ["Next.js", '<script src="/_next/static/chunks/app-a1.js"></script>', "nextjs"],
    [
      "React CDN",
      '<script src="https://unpkg.com/react@19.0.0/umd/react.production.min.js"></script>',
      "react",
    ],
    ["Tailwind CDN", '<script src="https://cdn.tailwindcss.com"></script>', "tailwindcss"],
    ["Vite client", '<script type="module" src="/@vite/client"></script>', "vite"],
    [
      "WordPress generator + platform asset",
      '<meta name="generator" content="WordPress 6.8"><link rel="stylesheet" href="/wp-content/themes/example/style.css">',
      "wordpress",
    ],
  ])(
    "records %s as technology observation, not a dependency suggestion",
    async (_name, html, slug) => {
      const result = await discover(html);
      expect(result.technologyObservations?.map(({ technologySlug }) => technologySlug)).toContain(
        slug,
      );
      expect(result.candidates).toEqual([]);
    },
  );

  it.each([
    "<p>Built with Next.js, React and Tailwind CSS.</p>",
    '<script src="/_next/image?url=%2Fhero.png"></script>',
    '<script src="https://cdn.tailwindcss.com.attacker.example"></script>',
    '<script src="/not-next/static/chunks/app.js"></script>',
  ])("does not infer a strong framework/library fingerprint from a near miss: %s", async (html) => {
    const result = await discover(html);
    expect(result.technologyObservations ?? []).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("keeps a named Bootstrap stylesheet as weak, suppressed evidence", async () => {
    const result = await discover('<link rel="stylesheet" href="/assets/bootstrap.css">');
    expect(result.technologyObservations).toMatchObject([
      {
        technologySlug: "bootstrap",
        evidenceFamily: "stylesheet_asset",
        strength: "weak",
        protectability: "non_protectable",
        disposition: "suppressed",
        suppressionReason: "LIBRARY",
      },
    ]);
    expect(result.candidates).toEqual([]);
  });

  it("deduplicates repeated copies of a registered signature", async () => {
    const result = await discover(
      '<script src="https://js.stripe.com/v3/"></script><script src="https://js.stripe.com/v3/"></script>',
    );
    expect(result.evidence).toHaveLength(1);
  });

  it("does not combine a Stripe host and path from separate script URLs", async () => {
    const result = await discover(
      '<script src="https://js.stripe.com/telemetry.js"></script><script src="/v3/app.js"></script>',
    );
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).not.toContain("stripe");
  });

  it("does not label correlated mixed-strength signals high", async () => {
    const result = await discover('<script src="/_vercel/insights/script.js"></script>', {
      server: "Vercel",
    });
    expect(result.candidates[0]).toMatchObject({
      providerSlug: "vercel",
      confidenceLabel: "medium",
    });
  });

  it("keeps static website signals below high confidence without independent runtime observations", async () => {
    const result = await discover(
      '<script src="https://js.stripe.com/v3/"></script><form action="https://checkout.stripe.com/pay"></form>',
    );
    expect(result.candidates[0]).toMatchObject({
      providerSlug: "stripe",
      confidenceLabel: "medium",
    });
  });

  it("does not treat two correlated response headers as independent confidence", async () => {
    const result = await discover("", { server: "Vercel", "x-vercel-id": "sfo1::abc" });
    expect(result.candidates[0]?.confidenceLabel).toBe("medium");
  });

  it("keeps a single response header at medium confidence", async () => {
    const result = await discover("", { "cf-ray": "abc" });
    expect(result.candidates[0]).toMatchObject({
      providerSlug: "cloudflare",
      confidenceLabel: "medium",
    });
  });

  it("keeps a weak infrastructure reference at low confidence", async () => {
    const result = await discover('<img src="https://d123.cloudfront.net/image.png">');
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ providerSlug: "aws", strength: "weak" }),
    );
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).not.toContain("aws");
  });

  it("retains weak analytics references without suggesting Cloudflare by themselves", async () => {
    const result = await discover(
      '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>',
    );
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ providerSlug: "cloudflare", strength: "weak" }),
    );
    expect(result.candidates).toEqual([]);
  });

  it("does not suggest providers from generic embedded assets or demo frames", async () => {
    const result = await discover(
      '<iframe src="https://demo.netlify.app/embed"></iframe><img src="https://project.supabase.co/storage/v1/object/public/logo.png"><img src="https://cdn.shopify.com/icons/store.png">',
    );
    expect(result.candidates).toEqual([]);
  });

  it("detects a provider endpoint in CSP without treating it as confirmed or high confidence", async () => {
    const result = await discover("", {
      "content-security-policy-report-only":
        "default-src 'self'; connect-src https://api.openai.com",
    });
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ providerSlug: "openai", signalType: "csp_host", strength: "weak" }),
    );
  });

  it("ignores a lookalike host in CSP", async () => {
    const result = await discover("", {
      "content-security-policy": "connect-src https://api.openai.com.attacker.example",
    });
    expect(result.candidates).toEqual([]);
  });

  it("uses only the final host of an observed safe redirect as redirect evidence", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () => ({
        ...page(""),
        finalUrl: "https://my-site.netlify.app/",
        redirectEvidence: [{ origin: "https://company.example", safeHeaders: {} }],
      }),
    });
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("netlify");
    expect(result.evidence).toContainEqual(
      expect.objectContaining({ signalType: "redirect_host", strength: "medium" }),
    );
  });

  it("extracts bounded API endpoint values from selected inline JSON keys", async () => {
    const result = await discover(
      '<script type="application/json" id="app-config">{"apiUrl":"https://api.openai.com/v1","description":"https://api.openai.com"}</script>',
    );
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("openai");
    expect(result.inspected.inlineConfigUrls).toBe(1);
  });

  it.each([
    '<a href="https://project.supabase.co/">Read a Supabase guide</a>',
    "<!-- example: https://static.cloudflareinsights.com/beacon.min.js -->",
    "<article>Use the resource at https://cdn.shopify.com/store.js</article>",
    '<script src="https://evil.example/_vercel/insights/script.js"></script>',
  ])("ignores copied URLs and spoofed resource paths: %s", async (html) => {
    const result = await discover(html);
    expect(result.candidates).toEqual([]);
  });

  it("keeps document order when limiting the script registry input", async () => {
    const noise = Array.from(
      { length: 35 },
      (_, index) => `<script src="/noise${index}.js"></script>`,
    ).join("");
    const result = await discover('<script src="/_vercel/insights/script.js"></script>' + noise);
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("vercel");
  });

  it("resolves relative resources against the first valid base href", async () => {
    const externalBase = await discover(
      '<base href="https://cdn.example/assets/"><script src="/_vercel/insights/script.js"></script>',
    );
    expect(externalBase.candidates.map(({ providerSlug }) => providerSlug)).not.toContain("vercel");

    const providerBase = await discover(
      '<base href="https://js.stripe.com/"><script src="v3/"></script>',
    );
    expect(providerBase.candidates.map(({ providerSlug }) => providerSlug)).toContain("stripe");
  });

  it("does not retain query strings from referenced script URLs in evidence", async () => {
    const result = await discover('<script src="https://js.stripe.com/v3/?token=secret"></script>');
    expect(JSON.stringify(result.evidence)).not.toContain("secret");
  });

  it("leaves the optional deep pass off by default", async () => {
    const result = await discover('<script src="/app.js"></script>');
    expect(result.deepPass).toMatchObject({
      requested: false,
      scriptsDiscovered: 0,
      scriptsAttempted: 0,
      scriptsFetched: 0,
      bytesFetched: 0,
      failures: 0,
    });
    expect(result.outcome).toBe("empty");
  });

  it("deep pass fetches same-origin scripts only and stays within its request cap", async () => {
    const html =
      Array.from({ length: 6 }, (_, index) => `<script src="/app${index}.js"></script>`).join("") +
      '<script src="https://third-party.example/asset.js"></script>';
    const calls: string[] = [];
    const result = await discover(html, {}, true, (url) => {
      calls.push(url);
      return { ...page("const app = true;"), contentType: "application/javascript" };
    });
    expect(calls).toHaveLength(4);
    expect(calls.every((url) => new URL(url).origin === "https://company.example")).toBe(true);
    expect(result.deepPass.scriptsFetched).toBe(4);
  });

  it("does not analyze non-JavaScript MIME responses returned by an adapter", async () => {
    const result = await discover('<script src="/app.js"></script>', {}, true, (url) =>
      url.endsWith("app.js")
        ? { ...page("Sentry.init({})"), contentType: "text/html" }
        : page('<script src="/app.js"></script>'),
    );
    expect(result.deepPass.scriptsFetched).toBe(0);
    expect(result.candidates).toEqual([]);
  });

  it("does not fail the fast result when an optional deep script fails", async () => {
    const result = await discover(
      '<script src="/app.js"></script>',
      { server: "Vercel" },
      true,
      (url) => {
        if (url.endsWith("app.js")) throw new Error("network failure");
        return page('<script src="/app.js"></script>');
      },
    );
    expect(result.status).toBe("partial");
    expect(result.deepPass.scriptsFetched).toBe(0);
    expect(result.deepPass.failures).toBe(1);
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("vercel");
  });

  it("retains bounded oversized HTML and runs the deep pass using head scripts", async () => {
    const html =
      '<!doctype html><html><head><script src="/_vercel/insights/script.js"></script><script src="/app.js"></script></head><body>' +
      "x".repeat(discoveryLimits.maxHtmlBytes + 32);
    const fetcher: typeof fetchHttpSource = (url, validators, bounds) =>
      fetchHttpSource(url, validators, {
        ...bounds,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async (requestUrl) => ({
          status: 200,
          headers:
            requestUrl.pathname === "/"
              ? {
                  "content-type": "text/html",
                  "content-length": String(Buffer.byteLength(html)),
                  server: "Vercel",
                }
              : { "content-type": "application/javascript" },
          body: (async function* () {
            yield Buffer.from(requestUrl.pathname === "/" ? html : "Sentry.init({});");
          })(),
        }),
      });
    const result = await discoverWebsiteDependencies("https://company.example/", {
      deep: true,
      fetcher,
    });
    expect(result).toMatchObject({
      status: "partial",
      outcome: "partial",
      coverage: {
        html: {
          status: 200,
          bytesRead: discoveryLimits.maxHtmlBytes,
          truncated: true,
          extractionPerformed: true,
        },
      },
      deepPass: {
        requested: true,
        scriptsDiscovered: 2,
        scriptsAttempted: 2,
        scriptsFetched: 2,
      },
    });
    expect(result.deepPass.bytesFetched).toBeGreaterThan(0);
    expect(result.evidence.map(({ providerSlug }) => providerSlug)).toContain("vercel");
    expect(result.evidence.map(({ providerSlug }) => providerSlug)).toContain("sentry");
  });

  it("reports an oversized no-signal document as partial rather than empty or failed", async () => {
    const html = `<html><head><title>Example</title></head><body>${"x".repeat(discoveryLimits.maxHtmlBytes + 1)}`;
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () => ({
        ...page(html.slice(0, discoveryLimits.maxHtmlBytes)),
        bodyTruncated: true,
      }),
    });
    expect(result).toMatchObject({
      status: "partial",
      outcome: "partial",
      candidates: [],
      evidence: [],
    });
    expect(result.coverage.html.extractionPerformed).toBe(true);
  });

  it("keeps root evidence and successful scripts when another optional script fails", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      deep: true,
      fetcher: async (url) => {
        if (url.endsWith("/"))
          return page(
            '<head><script src="/bad.js"></script><script src="/good.js"></script></head>',
            {
              server: "Vercel",
            },
          );
        if (url.endsWith("/bad.js")) throw new Error("optional failure");
        return { ...page("Sentry.init({});"), contentType: "application/javascript" };
      },
    });
    expect(result.status).toBe("partial");
    expect(result.deepPass).toMatchObject({ scriptsAttempted: 2, scriptsFetched: 1, failures: 1 });
    expect(result.evidence.map(({ providerSlug }) => providerSlug)).toEqual(
      expect.arrayContaining(["vercel", "sentry"]),
    );
  });

  it("marks malformed truncated HTML as inspected without parser failure", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () => ({
        ...page(
          '<html><head><script src="/_vercel/insights/script.js"></script><meta name="api-url" content="https://api.openai.com/v1">',
        ),
        bodyTruncated: true,
      }),
    });
    expect(result.status).toBe("partial");
    expect(result.coverage.html.extractionPerformed).toBe(true);
    expect(result.evidence.map(({ providerSlug }) => providerSlug)).toContain("vercel");
  });

  it("treats URLs embedded in deep script source as weak evidence", async () => {
    const result = await discover('<script src="/app.js"></script>', {}, true, (url) =>
      url.endsWith("app.js")
        ? {
            ...page('// example only: "https://project.supabase.co/rest/v1"'),
            contentType: "application/javascript",
          }
        : page('<script src="/app.js"></script>'),
    );
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("uses active first-party JavaScript SDK markers while ignoring comments", async () => {
    const result = await discover('<script src="/app.js"></script>', {}, true, (url) =>
      url.endsWith("app.js")
        ? {
            ...page('// Sentry.init({});\nSentry.init({ dsn: "https://x@ingest.sentry.io/42" });'),
            contentType: "application/javascript",
          }
        : page('<script src="/app.js"></script>'),
    );
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("sentry");
    expect(result.evidence.some(({ signalType }) => signalType === "js_sdk")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("ingest.sentry.io/42");
  });

  it("does not treat SDK examples in JavaScript strings as active use", async () => {
    const result = await discover('<script src="/app.js"></script>', {}, true, (url) =>
      url.endsWith("app.js")
        ? {
            ...page('const example = "Sentry.init({})";'),
            contentType: "application/javascript",
          }
        : page('<script src="/app.js"></script>'),
    );
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("does not treat SDK marker text in JavaScript regex literals as active use", async () => {
    const result = await discover('<script src="/app.js"></script>', {}, true, (url) =>
      url.endsWith("app.js")
        ? {
            ...page("const example = /Sentry.init/;"),
            contentType: "application/javascript",
          }
        : page('<script src="/app.js"></script>'),
    );
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("ignores endpoint-looking values in unlabelled example JSON blocks", async () => {
    const result = await discover(
      '<script type="application/json">{"apiUrl":"https://project.supabase.co"}</script>',
    );
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("ignores endpoint values in JSON blocks labeled as examples", async () => {
    const result = await discover(
      '<script type="application/json" id="example-config">{"apiUrl":"https://project.supabase.co"}</script>',
    );
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("ignores endpoint URLs in ordinary descriptive meta tags", async () => {
    const result = await discover(
      '<meta name="description" content="Our docs mention API access at https://api.openai.com">',
    );
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("collapses correlated infrastructure and SDK observations into independent families", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () => ({
        ...page('<script src="/_vercel/insights/script.js"></script>', { server: "Vercel" }),
        finalUrl: "https://company.vercel.app/",
        redirectEvidence: [{ origin: "https://company.example", safeHeaders: {} }],
      }),
    });
    expect(result.candidates[0]?.confidence).toBe(0.808);
    expect(result.candidates[0]?.confidenceLabel).toBe("medium");
  });

  it("reports concrete bounded inspection counts", async () => {
    const result = await discover(
      '<script src="/app.js"></script><img src="https://assets.example/logo.png">',
      { server: "Vercel" },
    );
    expect(result.inspected).toMatchObject({
      responseHeaders: 1,
      htmlNodes: expect.any(Number),
      scriptReferences: 1,
      resourceReferences: 2,
      dnsRecordsUsed: false,
      browserRuntime: false,
    });
  });

  it("skips runtime browsing when static coverage is strong", async () => {
    let runtimeCalls = 0;
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () =>
        page(
          '<script src="https://js.stripe.com/v3/"></script><form action="https://checkout.stripe.com/pay"></form>',
        ),
      runtimeEnabled: true,
      runtimeRunner: async () => {
        runtimeCalls += 1;
        return {
          requests: [],
          requestsObserved: 0,
          uniqueHosts: 0,
          blockedUnsafeRequests: 0,
          durationMs: 1,
          status: "complete",
          memoryDeltaBytes: 0,
        };
      },
    });
    expect(runtimeCalls).toBe(0);
    expect(result.coverage.staticCoverage).toMatchObject({
      quality: "strong",
      runtimeRequired: false,
    });
  });

  it("runs runtime enrichment for weak static coverage without treating one host as independent evidence", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () =>
        page(
          '<script type="application/json" id="runtime-config">{"apiUrl":"https://project.supabase.co"}</script>',
        ),
      runtimeEnabled: true,
      runtimeRunner: async () => ({
        requests: [
          { host: "project.supabase.co", resourceType: "fetch" },
          { host: "us.i.posthog.com", resourceType: "script" },
          { host: "us.i.posthog.com", resourceType: "fetch" },
        ],
        requestsObserved: 7,
        uniqueHosts: 2,
        blockedUnsafeRequests: 0,
        durationMs: 500,
        status: "complete",
        memoryDeltaBytes: 1024,
      }),
    });
    expect(result.coverage.runtime).toMatchObject({
      attempted: true,
      requestsObserved: 7,
      uniqueHosts: 2,
      status: "complete",
    });
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toEqual([
      "posthog",
      "supabase",
    ]);
    expect(
      result.candidates.find(({ providerSlug }) => providerSlug === "supabase")?.confidence,
    ).toBe(0.68);
    expect(
      result.candidates.find(({ providerSlug }) => providerSlug === "posthog")?.confidenceLabel,
    ).toBe("medium");
    expect(
      result.evidence.filter(
        ({ providerSlug, signatureKey }) =>
          providerSlug === "posthog" && signatureKey === "posthog-runtime-api",
      ),
    ).toHaveLength(1);
  });

  it("does not let one static provider clue suppress runtime-only dependencies", async () => {
    let runtimeCalls = 0;
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () =>
        page(
          '<script type="application/json" id="runtime-config">{"apiUrl":"https://project.supabase.co"}</script><script src="/app.js"></script>',
        ),
      runtimeEnabled: true,
      runtimeRunner: async () => {
        runtimeCalls += 1;
        return {
          requests: [
            { host: "company.example", resourceType: "document" },
            { host: "us.i.posthog.com", resourceType: "fetch" },
            { host: "us-assets.i.posthog.com", resourceType: "script" },
          ],
          requestsObserved: 3,
          uniqueHosts: 3,
          blockedUnsafeRequests: 0,
          durationMs: 10,
          status: "complete",
          memoryDeltaBytes: 0,
        };
      },
    });

    expect(runtimeCalls).toBe(1);
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("posthog");
    expect(result.coverage.staticCoverage.runtimeRequired).toBe(true);
  });

  it("deduplicates a controlled multi-provider fixture across static and runtime surfaces", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () =>
        page('<script src="/app.js"></script>', {
          "x-vercel-id": "iad1::fixture",
          "content-security-policy":
            "script-src https://js.stripe.com https://browser.sentry-cdn.com https://us.i.posthog.com; connect-src https://project.supabase.co https://api.stripe.com https://acme.ingest.sentry.io https://us.i.posthog.com",
        }),
      runtimeEnabled: true,
      runtimeRunner: async () => ({
        requests: [
          { host: "js.stripe.com", resourceType: "script" },
          { host: "api.stripe.com", resourceType: "fetch" },
          { host: "project.supabase.co", resourceType: "xhr" },
          { host: "browser.sentry-cdn.com", resourceType: "script" },
          { host: "acme.ingest.sentry.io", resourceType: "fetch" },
          { host: "us-assets.i.posthog.com", resourceType: "script" },
          { host: "us.i.posthog.com", resourceType: "fetch" },
          ...Array.from({ length: 10 }, () => ({
            host: "us.i.posthog.com",
            resourceType: "fetch" as const,
          })),
        ],
        requestsObserved: 17,
        uniqueHosts: 7,
        blockedUnsafeRequests: 0,
        durationMs: 600,
        status: "complete",
        memoryDeltaBytes: 4096,
      }),
    });
    expect(result.candidates.map(({ providerSlug }) => providerSlug).sort()).toEqual([
      "posthog",
      "sentry",
      "stripe",
      "supabase",
      "vercel",
    ]);
    expect(
      result.evidence.filter(
        ({ providerSlug, signatureKey }) =>
          providerSlug === "posthog" && signatureKey === "posthog-runtime-api",
      ),
    ).toHaveLength(1);
    expect(
      result.candidates.find(({ providerSlug }) => providerSlug === "posthog")?.confidenceLabel,
    ).toBe("high");
    expect(
      result.candidates.find(({ providerSlug }) => providerSlug === "supabase")?.confidenceLabel,
    ).toBe("medium");
  });

  it("ignores integration-directory copy, provider links, logos, and social embeds", async () => {
    const result = await discover(
      '<main>Connect Stripe, Supabase, Sentry and PostHog</main><a href="https://stripe.com">Stripe</a><img src="https://cdn.example/stripe-logo.png"><iframe src="https://www.youtube.com/embed/demo"></iframe><a href="https://github.com/example">GitHub</a>',
    );
    expect(result.candidates).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it("keeps functional marketing-demo integrations unconfirmed", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/integrations/", {
      fetcher: async () =>
        page(
          '<script src="https://js.stripe.com/v3/"></script><form action="https://checkout.stripe.com/pay"></form>',
        ),
      runtimeEnabled: true,
      runtimeRunner: async () => ({
        requests: [
          { host: "js.stripe.com", resourceType: "script" },
          { host: "checkout.stripe.com", resourceType: "fetch" },
        ],
        requestsObserved: 2,
        uniqueHosts: 2,
        blockedUnsafeRequests: 0,
        durationMs: 100,
        status: "complete",
        memoryDeltaBytes: 0,
      }),
    });
    expect(
      result.candidates.find(({ providerSlug }) => providerSlug === "stripe")?.confidenceLabel,
    ).toBe("medium");
    expect(result.status).toBe("completed");
    // Discovery candidates remain suggestions; website/demo evidence never auto-confirms a dependency.
  });

  it("propagates cancellation swallowed by optional deep asset fetches", async () => {
    const controller = new AbortController();
    await expect(
      discoverWebsiteDependencies("https://company.example/", {
        deep: true,
        signal: controller.signal,
        fetcher: async (url) => {
          if (url.endsWith("app.js")) controller.abort();
          return page(
            '<script src="/app.js"></script><form action="https://checkout.stripe.com/pay"></form>',
          );
        },
      }),
    ).rejects.toMatchObject({ category: "timeout" });
  });

  it("keeps useful static candidates when optional runtime browsing is unavailable", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () => page("", { "cf-ray": "abc" }),
      runtimeEnabled: true,
      runtimeRunner: async () => {
        throw new Error("browser unavailable");
      },
    });
    expect(result.status).toBe("partial");
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("cloudflare");
    expect(result.coverage.runtime.status).toBe("unavailable");
  });

  it("surfaces transient homepage failures so the Trigger task can retry", async () => {
    await expect(
      discoverWebsiteDependencies("https://company.example/", {
        fetcher: async () => {
          throw new SafeFetchError("timeout", "The source request timed out.");
        },
      }),
    ).rejects.toMatchObject({ category: "timeout" });
  });

  it("allows a later Trigger attempt to complete after a transient fetch failure", async () => {
    let discoveryAttempts = 0;
    const failedCategories: string[] = [];
    const repository = {
      begin: async () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      complete: async () => undefined,
      fail: async (_runId: string, _workspaceId: string, category: string) => {
        failedCategories.push(category);
      },
    };
    const input = {
      workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      companyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      websiteUrl: "https://company.example/",
      deep: false,
      triggerRunId: "attempted-discovery",
      attemptNumber: 1,
    };
    const discoverWithOneTransientFailure = async () => {
      discoveryAttempts += 1;
      if (discoveryAttempts === 1)
        throw new SafeFetchError("timeout", "The source request timed out.");
      return {
        normalizedUrl: "https://company.example/",
        status: "completed" as const,
        outcome: "empty" as const,
        candidates: [],
        evidence: [],
        deepPass: {
          requested: false,
          scriptsDiscovered: 0,
          scriptsAttempted: 0,
          scriptsFetched: 0,
          bytesFetched: 0,
          failures: 0,
        },
        coverage: {
          outcome: "empty" as const,
          durationMs: 1,
          html: {
            attempted: true,
            status: 200,
            bytesRead: 0,
            truncated: false,
            referencesExtracted: 0,
            extractionPerformed: true,
            nodeLimitReached: false,
            referenceLimitReached: false,
          },
          staticCoverage: {
            quality: "weak" as const,
            durationMs: 1,
            signalFamilies: 0,
            runtimeRequired: false,
            resourceGraph: {
              scriptsFirstParty: 0,
              scriptsThirdParty: 0,
              stylesheets: 0,
              preloads: 0,
              apiEndpoints: 0,
              frames: 0,
              manifests: 0,
              formActions: 0,
              otherResources: 0,
            },
          },
          runtime: {
            attempted: false,
            durationMs: 0,
            requestsObserved: 0,
            uniqueHosts: 0,
            providerMatches: 0,
            blockedUnsafeRequests: 0,
            status: "skipped" as const,
            memoryDeltaBytes: null,
          },
          headers: { inspected: 0 },
          csp: { inspected: true, hostSources: 0 },
          manifest: { attempted: false, discovered: 0, fetched: 0, failures: 0 },
          javascript: {
            attempted: false,
            scriptsDiscovered: 0,
            scriptsAttempted: 0,
            scriptsFetched: 0,
            bytesFetched: 0,
            failures: 0,
            limitReached: false,
          },
          incompleteReasons: [],
        },
        inspected: {
          responseHeaders: 0,
          redirects: 0,
          htmlNodes: 0,
          scriptReferences: 0,
          resourceReferences: 0,
          cspHosts: 0,
          inlineConfigUrls: 0,
          manifestsFetched: 0,
          jsAssetsFetched: 0,
          dnsRecordsUsed: false as const,
          browserRuntime: false as const,
        },
      };
    };
    await expect(
      runWebsiteDependencyDiscovery(input, {
        repository,
        discover: discoverWithOneTransientFailure,
      }),
    ).rejects.toMatchObject({ category: "timeout" });
    const result = await runWebsiteDependencyDiscovery(
      { ...input, attemptNumber: 2 },
      { repository, discover: discoverWithOneTransientFailure },
    );
    expect(result.status).toBe("completed");
    expect(discoveryAttempts).toBe(2);
    expect(failedCategories).toEqual(["timeout"]);
  });

  it("marks persistence errors separately and leaves the original error visible to Trigger retries", async () => {
    const failed: string[] = [];
    const repository = {
      begin: async () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      complete: async () => {
        throw new Error("completion unavailable");
      },
      fail: async (_runId: string, _workspaceId: string, category: string) => {
        failed.push(category);
      },
    };
    await expect(
      runWebsiteDependencyDiscovery(
        {
          workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          companyId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          websiteUrl: "https://company.example/",
          deep: false,
          triggerRunId: "run-persistence-error",
          attemptNumber: 1,
        },
        {
          repository,
          discover: async () => ({
            normalizedUrl: "https://company.example/",
            status: "completed",
            outcome: "empty",
            candidates: [],
            evidence: [],
            deepPass: {
              requested: false,
              scriptsDiscovered: 0,
              scriptsAttempted: 0,
              scriptsFetched: 0,
              bytesFetched: 0,
              failures: 0,
            },
            coverage: {
              outcome: "empty",
              durationMs: 1,
              html: {
                attempted: true,
                status: 200,
                bytesRead: 0,
                truncated: false,
                referencesExtracted: 0,
                extractionPerformed: true,
                nodeLimitReached: false,
                referenceLimitReached: false,
              },
              staticCoverage: {
                quality: "weak",
                durationMs: 1,
                signalFamilies: 0,
                runtimeRequired: false,
                resourceGraph: {
                  scriptsFirstParty: 0,
                  scriptsThirdParty: 0,
                  stylesheets: 0,
                  preloads: 0,
                  apiEndpoints: 0,
                  frames: 0,
                  manifests: 0,
                  formActions: 0,
                  otherResources: 0,
                },
              },
              runtime: {
                attempted: false,
                durationMs: 0,
                requestsObserved: 0,
                uniqueHosts: 0,
                providerMatches: 0,
                blockedUnsafeRequests: 0,
                status: "skipped",
                memoryDeltaBytes: null,
              },
              headers: { inspected: 0 },
              csp: { inspected: true, hostSources: 0 },
              manifest: { attempted: false, discovered: 0, fetched: 0, failures: 0 },
              javascript: {
                attempted: false,
                scriptsDiscovered: 0,
                scriptsAttempted: 0,
                scriptsFetched: 0,
                bytesFetched: 0,
                failures: 0,
                limitReached: false,
              },
              incompleteReasons: [],
            },
            inspected: {
              responseHeaders: 0,
              redirects: 0,
              htmlNodes: 0,
              scriptReferences: 0,
              resourceReferences: 0,
              cspHosts: 0,
              inlineConfigUrls: 0,
              manifestsFetched: 0,
              jsAssetsFetched: 0,
              dnsRecordsUsed: false,
              browserRuntime: false,
            },
          }),
        },
      ),
    ).rejects.toThrow("completion unavailable");
    expect(failed).toEqual(["persistence_error"]);
  });

  it("records terminal homepage fetch failures without retrying", async () => {
    const result = await discoverWebsiteDependencies("https://company.example/", {
      fetcher: async () => {
        throw new SafeFetchError("invalid_content_type", "The source did not return HTML.", 200);
      },
    });
    expect(result).toMatchObject({ status: "failed", failureCategory: "invalid_content_type" });
  });
});
