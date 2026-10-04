import { describe, expect, it } from "vitest";
import {
  companyDiscoveryLimits,
  discoverCompanySurfaceDependencies,
} from "@/lib/discovery/company-surfaces";
import type { FetchResult } from "@/lib/monitoring/fetcher";

function response(url: string, html: string, headers: Record<string, string> = {}): FetchResult {
  return {
    status: 200,
    body: Buffer.from(html),
    bytesRead: Buffer.byteLength(html),
    wireBytesRead: Buffer.byteLength(html),
    bodyTruncated: false,
    contentType: "text/html",
    safeHeaders: headers,
    etag: null,
    lastModified: null,
    finalUrl: url,
  };
}

describe("company surface discovery", () => {
  it("selects only explicitly linked high-value first-party surfaces with PSL boundaries", async () => {
    const fetched: string[] = [];
    const result = await discoverCompanySurfaceDependencies("https://example.co.uk", {
      fetcher: async (url) => {
        fetched.push(url);
        if (url === "https://example.co.uk/") {
          return response(
            url,
            '<nav><a href="https://app.example.co.uk/private?token=do-not-store">Open app</a>' +
              '<a href="https://auth.example.co.uk/login">Sign in</a>' +
              '<a href="https://docs.example.co.uk">Docs</a>' +
              '<a href="https://example.co.uk/integrations">Integrations</a>' +
              '<a href="https://app.example.co.uk.attacker.net">Open app</a>' +
              '<a href="https://unlinked.example.co.uk">unlinked</a></nav>',
            { "cf-ray": "fixture" },
          );
        }
        if (url === "https://app.example.co.uk/") {
          return response(
            url,
            '<script src="https://browser.sentry-cdn.com/7.0/bundle.js"></script>' +
              '<script type="application/json" id="runtime-config">{"apiUrl":"https://tenant.supabase.co"}</script>' +
              '<script src="https://js.stripe.com/v3/"></script>',
          );
        }
        if (url === "https://auth.example.co.uk/") {
          return response(url, '<script src="https://clerk.accounts.dev/npm/clerk.js"></script>');
        }
        throw new Error(`Unexpected fetch: ${url}`);
      },
    });

    expect(fetched).toEqual([
      "https://example.co.uk/",
      "https://app.example.co.uk/",
      "https://auth.example.co.uk/",
    ]);
    expect(result.companyCoverage?.surfacesSelected).toBe(3);
    expect(result.companyCoverage?.surfacesScanned).toBe(3);
    expect(result.companyCoverage?.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          host: "app.example.co.uk",
          type: "PRODUCT_APP",
          status: "scanned",
        }),
        expect.objectContaining({
          host: "auth.example.co.uk",
          type: "AUTH_APP",
          status: "scanned",
        }),
        expect.objectContaining({ host: "docs.example.co.uk", type: "DOCS", selected: false }),
      ]),
    );
    expect(result.candidates.map(({ providerSlug }) => providerSlug).sort()).toEqual([
      "clerk",
      "cloudflare",
      "sentry",
      "stripe",
      "supabase",
    ]);
    expect(result.evidence.find(({ providerSlug }) => providerSlug === "sentry")).toMatchObject({
      surfaceType: "PRODUCT_APP",
      surfaceHost: "app.example.co.uk",
    });
    expect(JSON.stringify(result)).not.toContain("do-not-store");
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("never enumerates sibling hosts and caps deterministic expansion at two extra surfaces", async () => {
    const fetched: string[] = [];
    const result = await discoverCompanySurfaceDependencies("https://acme.example.com", {
      fetcher: async (url) => {
        fetched.push(url);
        if (url === "https://acme.example.com/") {
          return response(
            url,
            '<a href="https://dashboard.acme.example.com">Dashboard</a>' +
              '<a href="https://app.acme.example.com">Open app</a>' +
              '<a href="https://portal.acme.example.com">Customer portal</a>' +
              '<a href="https://docs.acme.example.com">Docs</a>',
          );
        }
        return response(url, "");
      },
    });
    expect(fetched).toEqual([
      "https://acme.example.com/",
      "https://dashboard.acme.example.com/",
      "https://app.acme.example.com/",
    ]);
    expect(result.companyCoverage?.surfacesSelected).toBe(3);
    expect(
      result.companyCoverage?.surfaces.find(({ host }) => host === "portal.acme.example.com"),
    ).toMatchObject({ selected: false, selectionReason: "surface_limit", status: "skipped" });
  });

  it("classifies but does not scan first-party docs, blog, status, support, or integration surfaces", async () => {
    const fetched: string[] = [];
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) => {
        fetched.push(url);
        return response(
          url,
          '<a href="https://docs.company.example">Docs</a>' +
            '<a href="https://blog.company.example">Blog</a>' +
            '<a href="https://status.company.example">Status</a>' +
            '<a href="https://support.company.example">Support</a>' +
            '<a href="https://integrations.company.example">Integrations</a>',
        );
      },
    });
    expect(fetched).toEqual(["https://company.example/"]);
    expect(result.companyCoverage?.surfaces.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["DOCS", "BLOG", "STATUS", "SUPPORT", "INTEGRATION_DIRECTORY"]),
    );
    expect(
      result.companyCoverage?.surfaces.find(({ type }) => type === "INTEGRATION_DIRECTORY"),
    ).toMatchObject({ selected: false, selectionReason: "integration_directory_excluded" });
  });

  it("selects one scan when a first-party host has multiple app-like link classifications", async () => {
    const fetched: string[] = [];
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) => {
        fetched.push(url);
        return response(
          url,
          url === "https://company.example/"
            ? '<a href="https://app.company.example/dashboard">Dashboard</a><a href="https://app.company.example">Open app</a>'
            : "",
        );
      },
    });
    expect(fetched).toEqual(["https://company.example/", "https://app.company.example/"]);
    expect(
      result.companyCoverage?.surfaces.filter(({ host }) => host === "app.company.example"),
    ).toHaveLength(1);
    expect(
      result.companyCoverage?.surfaces.find(({ host }) => host === "app.company.example"),
    ).toMatchObject({ type: "DASHBOARD", selected: true, status: "scanned" });
  });

  it("does not rescan a www/non-www alias of the submitted root", async () => {
    const fetched: string[] = [];
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) => {
        fetched.push(url);
        return response(url, '<a href="https://www.company.example/dashboard">Dashboard</a>');
      },
    });
    expect(fetched).toEqual(["https://company.example/"]);
    expect(result.companyCoverage?.surfaces).toHaveLength(1);
  });

  it("does not scan marketplace or customer case-study surfaces, while retaining an explicit portal", async () => {
    const fetched: string[] = [];
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) => {
        fetched.push(url);
        return response(
          url,
          url === "https://company.example/"
            ? '<a href="https://marketplace.company.example">Open app</a><a href="https://company.example/customers/acme">Customer story</a><a href="https://portal.company.example/customers/login">Customer portal</a>'
            : "",
        );
      },
    });
    expect(fetched).toEqual(["https://company.example/", "https://portal.company.example/"]);
    expect(
      result.companyCoverage?.surfaces.find(({ host }) => host === "marketplace.company.example"),
    ).toMatchObject({ type: "INTEGRATION_DIRECTORY", selected: false });
    expect(
      result.companyCoverage?.surfaces.filter(({ host }) => host === "company.example"),
    ).toHaveLength(1);
    expect(
      result.companyCoverage?.surfaces.find(({ host }) => host === "portal.company.example"),
    ).toMatchObject({ type: "CUSTOMER_PORTAL", selected: true, status: "scanned" });
  });

  it("keeps the hard company scan deadline below the onboarding latency ceiling", () => {
    expect(companyDiscoveryLimits.maxTotalDurationMs).toBeLessThan(20_000);
  });

  it("does not treat separate private-suffix tenants as one company", async () => {
    const fetched: string[] = [];
    await discoverCompanySurfaceDependencies("https://acme.github.io", {
      fetcher: async (url) => {
        fetched.push(url);
        return response(url, '<a href="https://app.other.github.io">Open app</a>');
      },
    });
    expect(fetched).toEqual(["https://acme.github.io/"]);
  });

  it("treats a marketing-only provider signal as suppressed and keeps root infrastructure evidence", async () => {
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) =>
        response(
          url,
          '<script src="https://js.stripe.com/v3/"></script>' +
            '<form action="https://checkout.stripe.com/pay"></form>',
          { "cf-ray": "fixture" },
        ),
    });
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toEqual(["cloudflare"]);
    expect(result.companyCoverage?.suppressionReasonCounts.marketing_only).toBeGreaterThan(0);
    expect(result.companyCoverage?.providersSuppressed).toBe(1);
  });

  it("counts distinct suppressed observations without calling a suggested provider suppressed", async () => {
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) =>
        response(
          url,
          url === "https://company.example/"
            ? '<a href="https://app.company.example">Open app</a><script src="https://js.stripe.com/v3/"></script><form action="https://checkout.stripe.com/pay"></form>'
            : '<script src="https://js.stripe.com/v3/"></script><form action="https://checkout.stripe.com/pay"></form>',
          { "cf-ray": "fixture" },
        ),
    });
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("stripe");
    expect(result.companyCoverage?.suppressionReasonCounts.marketing_only).toBe(2);
    expect(result.companyCoverage?.providersSuppressed).toBe(0);
    expect(
      result.companyCoverage?.suppressedObservations.filter(
        ({ providerSlug, reason }) => providerSlug === "stripe" && reason === "marketing_only",
      ),
    ).toHaveLength(2);
  });

  it("preserves same-signature suppressed observations from distinct provider hosts", async () => {
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) =>
        url === "https://company.example/"
          ? response(url, '<a href="https://app.company.example">Open app</a>', {
              "content-security-policy": "connect-src https://us.i.posthog.com",
            })
          : response(url, "", {
              "content-security-policy": "connect-src https://eu.i.posthog.com",
            }),
    });
    const posthogObservations = result.companyCoverage?.suppressedObservations.filter(
      ({ providerSlug, signatureKey }) =>
        providerSlug === "posthog" && signatureKey === "posthog-csp-endpoint",
    );
    expect(posthogObservations?.map(({ sourceOrigin }) => sourceOrigin).sort()).toEqual([
      "https://app.company.example",
      "https://company.example",
    ]);
    expect(result.companyCoverage?.suppressionReasonCounts.marketing_only).toBe(1);
    expect(result.companyCoverage?.suppressionReasonCounts.weak_evidence).toBe(1);
  });

  it("keeps runtime evidence attributed to each selected surface while deduping the provider candidate", async () => {
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      deep: true,
      runtimeEnabled: true,
      fetcher: async (url) =>
        url === "https://company.example/"
          ? response(
              url,
              '<a href="https://app1.company.example">Open app</a>' +
                '<a href="https://app2.company.example">Open app</a>',
            )
          : response(url, ""),
      runtimeRunner: async (url) => ({
        requests: new URL(url).hostname.startsWith("app")
          ? [{ host: "browser.sentry-cdn.com", resourceType: "script" }]
          : new URL(url).hostname.startsWith("auth")
            ? [{ host: "ingest.sentry.io", resourceType: "xhr" }]
            : [],
        requestsObserved: 1,
        uniqueHosts: 1,
        blockedUnsafeRequests: 0,
        durationMs: 100,
        status: "complete",
        memoryDeltaBytes: 0,
      }),
    });
    const sentryEvidence = result.evidence.filter(({ providerSlug }) => providerSlug === "sentry");
    expect(result.candidates.filter(({ providerSlug }) => providerSlug === "sentry")).toHaveLength(
      1,
    );
    expect(sentryEvidence.map(({ surfaceHost }) => surfaceHost).sort()).toEqual([
      "app1.company.example",
      "app2.company.example",
    ]);
    expect(result.companyCoverage?.suppressionReasonCounts.correlated_evidence).toBe(1);
  });

  it("does not combine unrelated app and auth surfaces into high confidence", async () => {
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      runtimeEnabled: true,
      fetcher: async (url) => {
        if (url === "https://company.example/")
          return response(
            url,
            '<a href="https://app.company.example">Open app</a>' +
              '<a href="https://auth.company.example/login">Sign in</a>',
          );
        if (url === "https://app.company.example/")
          return response(
            url,
            '<script src="https://browser.sentry-cdn.com/7/bundle.js"></script>',
          );
        return response(
          url,
          '<script type="application/json" id="runtime-config">{"dsn":"https://key@ingest.sentry.io/1"}</script>',
        );
      },
      runtimeRunner: async (url) => ({
        requests: new URL(url).hostname.startsWith("app")
          ? [{ host: "browser.sentry-cdn.com", resourceType: "script" }]
          : new URL(url).hostname.startsWith("auth")
            ? [{ host: "ingest.sentry.io", resourceType: "xhr" }]
            : [],
        requestsObserved: 1,
        uniqueHosts: 1,
        blockedUnsafeRequests: 0,
        durationMs: 100,
        status: "complete",
        memoryDeltaBytes: 0,
      }),
    });
    expect(
      result.candidates.find(({ providerSlug }) => providerSlug === "sentry")?.confidenceLabel,
    ).toBe("medium");
    expect(
      result.candidates.find(({ providerSlug }) => providerSlug === "sentry")?.confidence,
    ).toBeLessThan(0.8);
    expect(
      result.candidates
        .find(({ providerSlug }) => providerSlug === "sentry")
        ?.evidence.some(({ signalType }) => signalType.startsWith("runtime_")),
    ).toBe(true);
  });

  it("rejects an associated app that redirects outside its selected first-party host", async () => {
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) =>
        url === "https://company.example/"
          ? response(url, '<a href="https://app.company.example">Open app</a>')
          : response(
              "https://unrelated.example/",
              '<script src="https://browser.sentry-cdn.com/7/bundle.js"></script>',
            ),
    });
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).not.toContain("sentry");
    expect(
      result.companyCoverage?.surfaces.find(({ host }) => host === "app.company.example"),
    ).toMatchObject({ selected: true, status: "failed" });
    expect(result.outcome).toBe("partial");
  });

  it("applies one aggregate decoded and wire byte budget across selected surfaces", async () => {
    const large = "x".repeat(3 * 1024 * 1024);
    const result = await discoverCompanySurfaceDependencies("https://company.example", {
      fetcher: async (url) =>
        url === "https://company.example/"
          ? response(
              url,
              `<a href="https://app1.company.example">Open app</a><a href="https://app2.company.example">Open app</a><!--${large}-->`,
            )
          : response(url, `<!--${large}-->`),
    });
    expect(result.companyCoverage?.totalStaticBytes).toBe(8 * 1024 * 1024);
    expect(result.companyCoverage?.totalStaticWireBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.companyCoverage?.surfacesScanned).toBe(2);
    expect(
      result.companyCoverage?.surfaces.find(({ host }) => host === "app2.company.example"),
    ).toMatchObject({ selected: true, status: "failed" });
    expect(result.outcome).toBe("partial");
  });
});
