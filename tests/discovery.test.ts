import { describe, expect, it } from "vitest";
import {
  discoverWebsiteDependencies,
  normalizePublicWebsiteUrl,
  type UrlDiscoveryResult,
} from "@/lib/discovery/discovery";
import { runWebsiteDependencyDiscovery } from "@/lib/discovery/run";
import { discoveryWebsiteUrlSchema } from "@/lib/discovery/schema";
import { SafeFetchError, type FetchResult } from "@/lib/monitoring/fetcher";

const page = (html: string, safeHeaders: Record<string, string> = {}): FetchResult => ({
  status: 200,
  body: Buffer.from(html),
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
  {
    name: "Cloudflare insights host",
    html: '<script src="https://static.cloudflareinsights.com/beacon.min.js"></script>',
    slug: "cloudflare",
  },
  { name: "Netlify request header", headers: { "x-nf-request-id": "abc" }, slug: "netlify" },
  {
    name: "Netlify public host",
    html: '<img src="https://site.netlify.app/image.png">',
    slug: "netlify",
  },
  {
    name: "CloudFront reference",
    html: '<img src="https://d123.cloudfront.net/a.png">',
    slug: "aws",
  },
  {
    name: "Supabase public host",
    html: '<script src="https://project.supabase.co/storage/v1/client.js"></script>',
    slug: "supabase",
  },
  {
    name: "Firebase app host",
    html: '<script src="https://project.firebaseapp.com/app.js"></script>',
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
    html: '<script src="https://123-dsn.algolia.net/1/indexes"></script>',
    slug: "algolia",
  },
  {
    name: "Shopify CDN host",
    html: '<script src="https://cdn.shopify.com/shopifycloud/storefront.js"></script>',
    slug: "shopify",
  },
  {
    name: "Firebase database host",
    html: '<script src="https://project.firebasedatabase.app/sdk.js"></script>',
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
    "not a URL",
  ])("rejects unsafe or malformed website input: %s", (url) => {
    expect(() => normalizePublicWebsiteUrl(url)).toThrow();
  });

  it.each([
    "ftp://example.com/",
    "https://user:password@example.com/",
    "https://example.com:8443/",
    "not a URL",
  ])("rejects a permanently invalid task URL before task execution: %s", (url) => {
    expect(discoveryWebsiteUrlSchema.safeParse(url).success).toBe(false);
  });

  it("does not infer a provider from a company name in visible copy", async () => {
    const result = await discover("<p>We love Stripe and Cloudflare products.</p>");
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

  it("combines independent signals and labels high confidence only after corroboration", async () => {
    const result = await discover('<script src="/_vercel/insights/script.js"></script>', {
      server: "Vercel",
    });
    expect(result.candidates[0]).toMatchObject({ providerSlug: "vercel", confidenceLabel: "high" });
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
    expect(result.candidates[0]).toMatchObject({ providerSlug: "aws", confidenceLabel: "low" });
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
    expect(result.deepPass).toEqual({ requested: false, scriptsFetched: 0, bytesFetched: 0 });
  });

  it("deep pass fetches same-origin scripts only and stays within its request cap", async () => {
    const html =
      Array.from({ length: 6 }, (_, index) => `<script src="/app${index}.js"></script>`).join("") +
      '<script src="https://third-party.example/asset.js"></script>';
    const calls: string[] = [];
    const result = await discover(html, {}, true, (url) => {
      calls.push(url);
      return page("const app = true;");
    });
    expect(calls).toHaveLength(4);
    expect(calls.every((url) => new URL(url).origin === "https://company.example")).toBe(true);
    expect(result.deepPass.scriptsFetched).toBe(4);
  });

  it("does not fail the fast result when an optional deep script fails", async () => {
    const result = await discover('<script src="/app.js"></script>', {}, true, (url) => {
      if (url.endsWith("app.js")) throw new Error("network failure");
      return page('<script src="/app.js"></script>');
    });
    expect(result.status).toBe("completed");
    expect(result.deepPass.scriptsFetched).toBe(0);
  });

  it("treats URLs embedded in deep script source as weak evidence", async () => {
    const result = await discover('<script src="/app.js"></script>', {}, true, (url) =>
      url.endsWith("app.js")
        ? page('// example only: "https://project.supabase.co/rest/v1"')
        : page('<script src="/app.js"></script>'),
    );
    expect(result.candidates[0]).toMatchObject({
      providerSlug: "supabase",
      confidenceLabel: "low",
      evidence: [{ signalType: "embedded_url", strength: "weak" }],
    });
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
        candidates: [],
        evidence: [],
        deepPass: { requested: false, scriptsFetched: 0, bytesFetched: 0 },
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
    expect(failedCategories).toEqual(["discovery_failed"]);
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
