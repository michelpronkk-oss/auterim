import { describe, expect, it } from "vitest";
import { discoverWebsiteDependencies } from "@/lib/discovery/discovery";
import {
  observeTechnologies,
  technologyCategories,
  technologyEvidenceFamilies,
  technologyFingerprintRegistry,
  technologyRegistryVersion,
  technologyRuntimeFingerprints,
  providerEvidenceFamily,
  fuseTechnologyObservations,
  type TechnologySignatureInput,
} from "@/lib/discovery/technology-registry";
import type { FetchResult } from "@/lib/monitoring/fetcher";
import { publicStackScanResult } from "@/lib/public/stack-scan";

const siteOrigin = "https://fixture.example";

function signature(overrides: Partial<TechnologySignatureInput> = {}): TechnologySignatureInput {
  return {
    headers: {},
    scriptUrls: [],
    resourceUrls: [],
    stylesheetUrls: [],
    iframeUrls: [],
    cspHosts: [],
    embeddedUrls: [],
    siteOrigin,
    ...overrides,
  };
}

const signatureFixtures: Record<
  string,
  { positive: TechnologySignatureInput; negative: TechnologySignatureInput }
> = {
  "nextjs-static-script": {
    positive: signature({ scriptUrls: [`${siteOrigin}/_next/static/chunks/app-abcd.js`] }),
    negative: signature({ resourceUrls: [`${siteOrigin}/_next/image?url=%2Fhero.png`] }),
  },
  "react-explicit-cdn-script": {
    positive: signature({
      scriptUrls: ["https://unpkg.com/react@19.0.0/umd/react.production.min.js"],
    }),
    negative: signature({ scriptUrls: ["https://unpkg.com.attacker.example/react@19.0.0/a.js"] }),
  },
  "react-dom-bundle-pair": {
    positive: signature({
      javascriptBundles: [
        { url: `${siteOrigin}/a.js`, code: "createRoot()", stringLiterals: ["react-dom/client"] },
      ],
    }),
    negative: signature({
      javascriptBundles: [{ url: `${siteOrigin}/a.js`, code: "createRoot()" }],
    }),
  },
  "tailwind-browser-cdn": {
    positive: signature({ scriptUrls: ["https://cdn.tailwindcss.com"] }),
    negative: signature({ scriptUrls: ["https://cdn.tailwindcss.com.attacker.example/a.js"] }),
  },
  "tailwind-generated-css-pair": {
    positive: signature({
      cssBundles: [
        {
          url: `${siteOrigin}/a.css`,
          code: "--tw-ring-offset-shadow:0 0 #000;--tw-ring-shadow:0 0 #000;--tw-shadow:0 0 #000",
        },
      ],
    }),
    negative: signature({
      cssBundles: [{ url: `${siteOrigin}/a.css`, code: ".container{color:red}" }],
    }),
  },
  "vite-client-script": {
    positive: signature({ scriptUrls: [`${siteOrigin}/@vite/client`] }),
    negative: signature({ scriptUrls: [`${siteOrigin}/@vite/client-copy`] }),
  },
  "wordpress-generator-and-content-path": {
    positive: signature({
      markupMarkers: ["wordpress-generator"],
      resourceUrls: [`${siteOrigin}/wp-content/themes/site/main.css`],
    }),
    negative: signature({ markupMarkers: ["wordpress-generator"] }),
  },
  "wordpress-path-only-weak": {
    positive: signature({ resourceUrls: [`${siteOrigin}/wp-content/themes/site/main.css`] }),
    negative: signature({ resourceUrls: [`${siteOrigin}/assets/wp-content-copy/main.css`] }),
  },
  "wordpress-generator-only-weak": {
    positive: signature({ markupMarkers: ["wordpress-generator"] }),
    negative: signature(),
  },
  "core-js-script-asset": {
    positive: signature({ scriptUrls: [`${siteOrigin}/assets/core-js/index.js`] }),
    negative: signature({ scriptUrls: [`${siteOrigin}/assets/not-core-js.js`] }),
  },
  "core-js-bundle-pair": {
    positive: signature({
      javascriptBundles: [
        {
          url: `${siteOrigin}/a.js`,
          code: "",
          stringLiterals: ["__core-js_shared__", "core-js/modules/es.array"],
        },
      ],
    }),
    negative: signature({
      javascriptBundles: [
        { url: `${siteOrigin}/a.js`, code: "", stringLiterals: ["__core-js_shared__"] },
      ],
    }),
  },
  "rxjs-script-asset": {
    positive: signature({
      scriptUrls: [`${siteOrigin}/node_modules/rxjs/bundles/rxjs.umd.min.js`],
    }),
    negative: signature({ scriptUrls: [`${siteOrigin}/docs/rxjs-copy/example.js`] }),
  },
  "rxjs-bundle-pair": {
    positive: signature({
      javascriptBundles: [
        {
          url: `${siteOrigin}/a.js`,
          code: "Subscriber()",
          stringLiterals: ["rxjs/internal/Subscriber"],
        },
      ],
    }),
    negative: signature({
      javascriptBundles: [{ url: `${siteOrigin}/a.js`, code: "Subscriber()" }],
    }),
  },
  "bootstrap-css-named-asset": {
    positive: signature({ stylesheetUrls: [`${siteOrigin}/assets/bootstrap.min.css`] }),
    negative: signature({ stylesheetUrls: [`${siteOrigin}/assets/not-bootstrap.css`] }),
  },
  "bootstrap-css-content-pair": {
    positive: signature({
      cssBundles: [
        {
          url: `${siteOrigin}/a.css`,
          code: "*{box-sizing: border-box}.btn{--bs-btn-color:red}.form-control{--bs-gutter-x:1rem}",
        },
      ],
    }),
    negative: signature({
      cssBundles: [
        {
          url: `${siteOrigin}/a.css`,
          code: "*{box-sizing: border-box}.btn{--bs-btn-color:red}.button{--bs-gutter-x:1rem}",
        },
      ],
    }),
  },
  "sentry-browser-bundle-pair": bundle("@sentry/browser", "captureException()"),
  "posthog-browser-bundle-pair": bundle("posthog-js", "capture()"),
  "segment-browser-bundle-pair": bundle("@segment/analytics", "track()"),
  "intercom-browser-bundle-pair": bundle("@intercom/messenger-js-sdk", "boot()"),
  "algolia-browser-bundle-pair": bundle("algoliasearch", "instantsearch()"),
  "stripe-browser-bundle-pair": bundle("@stripe/stripe-js", "loadStripe()"),
  "clerk-browser-bundle-pair": bundle("@clerk/clerk.browser", "ClerkProvider()"),
  "supabase-client-bundle-pair": bundle("@supabase/supabase-js", "createClient()"),
  "firebase-client-bundle-pair": bundle("firebase/app", "initializeApp()"),
  "datadog-rum-bundle-pair": bundle("@datadog/browser-rum", "startSessionReplayRecording()"),
  "auth0-spa-bundle-pair": bundle("@auth0/auth0-spa-js", "createAuth0Client()"),
  "webpack-runtime-pair": bundle("webpackChunk", "__webpack_require__()"),
};

function bundle(packageMarker: string, executableMarker: string) {
  return {
    positive: signature({
      javascriptBundles: [
        { url: `${siteOrigin}/app.js`, code: executableMarker, stringLiterals: [packageMarker] },
      ],
    }),
    negative: signature({
      javascriptBundles: [
        { url: `${siteOrigin}/app.js`, code: "", stringLiterals: [packageMarker] },
      ],
    }),
  };
}

function html(body: string, url = `${siteOrigin}/`, contentType = "text/html"): FetchResult {
  return {
    status: 200,
    body: Buffer.from(body),
    bytesRead: Buffer.byteLength(body),
    bodyTruncated: false,
    contentType,
    safeHeaders: {},
    etag: null,
    lastModified: null,
    finalUrl: url,
  };
}

describe("versioned technology fingerprint registry", () => {
  it("requires rationale and labeled positive/negative fixtures for every production fingerprint", () => {
    const ids = technologyFingerprintRegistry.map(({ fingerprintId }) => fingerprintId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const fingerprint of technologyFingerprintRegistry) {
      expect(fingerprint.registryVersion).toBe(technologyRegistryVersion);
      expect(fingerprint.rationale.trim().length, fingerprint.fingerprintId).toBeGreaterThan(30);
      expect(signatureFixtures[fingerprint.fingerprintId], fingerprint.fingerprintId).toBeDefined();
      expect(fingerprint.positiveFixture).toBeTruthy();
      expect(fingerprint.negativeFixture).toBeTruthy();
      expect(technologyEvidenceFamilies).toContain(fingerprint.evidenceFamily);
      expect(technologyCategories).toContain(fingerprint.category);
    }
    const allIds = [
      ...technologyFingerprintRegistry.map(({ fingerprintId }) => fingerprintId),
      ...technologyRuntimeFingerprints.map(({ fingerprintId }) => fingerprintId),
    ];
    expect(new Set(allIds).size).toBe(allIds.length);
    for (const fingerprint of technologyRuntimeFingerprints) {
      expect(fingerprint.rationale.trim().length).toBeGreaterThan(30);
      expect(fingerprint.expression).toBeTruthy();
      expect(fingerprint.positiveFixture).toBeTruthy();
      expect(fingerprint.negativeFixture).toBeTruthy();
      expect(technologyEvidenceFamilies).toContain(fingerprint.family);
      expect(technologyCategories).toContain(fingerprint.category);
    }
  });

  it("does not pair package and executable tokens from different JavaScript bundles", () => {
    const coreJs = technologyFingerprintRegistry.find(
      ({ fingerprintId }) => fingerprintId === "core-js-bundle-pair",
    );
    expect(
      coreJs?.matches(
        signature({
          javascriptBundles: [
            { url: `${siteOrigin}/package.js`, code: "", stringLiterals: ["__core-js_shared__"] },
            {
              url: `${siteOrigin}/runtime.js`,
              code: "",
              stringLiterals: ["core-js/modules/es.array"],
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it.each(technologyFingerprintRegistry)(
    "matches positive and rejects negative for $fingerprintId",
    (fingerprint) => {
      const fixture = signatureFixtures[fingerprint.fingerprintId]!;
      expect(fingerprint.matches(fixture.positive), fingerprint.positiveFixture).toBe(true);
      expect(fingerprint.matches(fixture.negative), fingerprint.negativeFixture).toBe(false);
    },
  );

  it("detects WordPress only from the paired generator and technical asset markers", () => {
    const wordpress = (overrides: Partial<TechnologySignatureInput>) =>
      observeTechnologies({
        signatureInput: signature(overrides),
        providerEvidence: [],
        surfaceType: "PRODUCT_APP",
        surfaceHost: "fixture.example",
        candidates: new Set(),
      }).filter(({ technologySlug }) => technologySlug === "wordpress");
    expect(wordpress({ markupMarkers: ["wordpress-generator"] }).map((x) => x.strength)).toContain(
      "weak",
    );
    expect(
      wordpress({ resourceUrls: [`${siteOrigin}/wp-content/theme/main.css`] }).map(
        (x) => x.strength,
      ),
    ).toContain("weak");
    expect(
      wordpress({
        markupMarkers: ["wordpress-generator"],
        resourceUrls: [`${siteOrigin}/wp-content/theme/main.css`],
      }).map((x) => x.fingerprintId),
    ).toContain("wordpress-generator-and-content-path");
    expect(
      wordpress({
        markupMarkers: ["wordpress-generator", "cms-generator-drupal"],
        resourceUrls: [`${siteOrigin}/wp-content/theme/main.css`],
      }).some((x) => x.status === "conflicted"),
    ).toBe(true);
    expect(wordpress({}).filter((x) => x.technologySlug === "wordpress")).toEqual([]);
  });

  it.each([
    "<p>WordPress Moodle Drupal Stripe Sentry React OpenAI Anthropic Supabase</p>",
    "<!-- WordPress wp-content Stripe Sentry React -->",
    '<a href="https://wordpress.org">WordPress</a><img src="/logos/stripe-sentry-react.png">',
  ])("ignores misleading prose, comments, and logo names: %s", async (body) => {
    const result = await discoverWebsiteDependencies(`${siteOrigin}/`, {
      fetcher: async () => html(body),
    });
    expect(result.technologyObservations).toEqual([]);
    expect(result.candidates).toEqual([]);
  });

  it("does not inspect or retain Set-Cookie values", async () => {
    const result = await discoverWebsiteDependencies(`${siteOrigin}/`, {
      fetcher: async () => ({
        ...html("<html></html>"),
        safeHeaders: { "set-cookie": "session=secret-shaped-value; HttpOnly" },
      }),
    });
    expect(result.technologyObservations ?? []).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("secret-shaped-value");
  });

  it("recognizes a controlled modern SaaS fixture without turning bundle support into suggestions", () => {
    const observations = observeTechnologies({
      signatureInput: signature({
        scriptUrls: [
          `${siteOrigin}/_next/static/chunks/app.js`,
          "https://unpkg.com/react@19.0.0/umd/react.production.min.js",
          "https://cdn.tailwindcss.com",
          `${siteOrigin}/@vite/client`,
        ],
        cssBundles: [
          {
            url: `${siteOrigin}/main.css`,
            code: "--tw-ring-offset-shadow;--tw-ring-shadow;--tw-shadow",
          },
        ],
        javascriptBundles: [
          {
            url: `${siteOrigin}/app.js`,
            code: "createClient() loadStripe() captureException() capture() instantsearch() ClerkProvider()",
            stringLiterals: [
              "@supabase/supabase-js",
              "@stripe/stripe-js",
              "@sentry/browser",
              "posthog-js",
              "algoliasearch",
              "@clerk/clerk.browser",
            ],
          },
        ],
      }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP",
      surfaceHost: "fixture.example",
      candidates: new Set(),
    });
    const present = new Set(observations.map(({ technologySlug }) => technologySlug));
    for (const slug of [
      "nextjs",
      "react",
      "tailwindcss",
      "vite",
      "supabase",
      "stripe",
      "sentry",
      "posthog",
      "algolia",
      "clerk",
    ])
      expect(present, slug).toContain(slug);
    for (const slug of ["wordpress", "moodle", "drupal", "intercom", "datadog"])
      expect(present, slug).not.toContain(slug);
    expect(observations.every(({ disposition }) => disposition === "suppressed")).toBe(true);
  });

  it("uses runtime fingerprints as allowlisted primitive hits and never serializes page values", () => {
    const fingerprintIds = ["runtime-sentry-global", "runtime-hcaptcha-frame"];
    const observations = observeTechnologies({
      signatureInput: signature({ runtimeFingerprintIds: fingerprintIds }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP",
      surfaceHost: "fixture.example",
      candidates: new Set(),
    });
    expect(observations.map(({ fingerprintId }) => fingerprintId)).toEqual(fingerprintIds);
    expect(JSON.stringify(observations)).not.toContain("cookie");
    expect(JSON.stringify(observations)).not.toContain("raw-value");
    for (const probe of technologyRuntimeFingerprints) {
      expect(probe.expression).toBeTruthy();
      expect(probe.maxLength).toBeLessThanOrEqual(256);
      expect(probe.expectedPrimitive).toMatch(/^(function|object|array|present)$/);
    }
  });

  it("does not treat repeated same-family observations as independent confidence", () => {
    const repeated = observeTechnologies({
      signatureInput: signature({ scriptUrls: [`${siteOrigin}/_next/static/a.js`] }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP",
      surfaceHost: "fixture.example",
      candidates: new Set(),
    });
    const fused = fuseTechnologyObservations(
      [
        ...repeated,
        ...repeated.map((item) => ({
          ...item,
          fingerprintId: `${item.fingerprintId}-2`,
          sourceHost: "cdn.fixture.example",
        })),
      ],
      new Set(),
    );
    expect(fused.find((item) => item.technologySlug === "nextjs")?.status).toBe("strong");
    expect(fused.find((item) => item.technologySlug === "nextjs")?.evidenceFamily).toBe(
      "script_url",
    );
    expect(fused.every((item) => item.disposition === "suppressed")).toBe(true);
    expect(fused.find((item) => item.fingerprintId.endsWith("-2"))?.suppressionReason).toBe(
      "CORRELATED_EVIDENCE",
    );
  });

  it("raises bundle confidence only when an independent runtime family agrees", () => {
    const observations = observeTechnologies({
      signatureInput: signature({
        javascriptBundles: [
          {
            url: `${siteOrigin}/a.js`,
            code: "captureException()",
            stringLiterals: ["@sentry/browser"],
          },
        ],
        runtimeFingerprintIds: ["runtime-sentry-global"],
      }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP",
      surfaceHost: "fixture.example",
      candidates: new Set(),
    });
    const fused = fuseTechnologyObservations(observations, new Set());
    expect(
      fused
        .filter(({ technologySlug }) => technologySlug === "sentry")
        .every(({ status }) => status === "strong"),
    ).toBe(true);
    expect(
      fused
        .filter(({ technologySlug }) => technologySlug === "sentry")
        .every(({ disposition }) => disposition === "suppressed"),
    ).toBe(true);
  });

  it("does not upgrade repeated medium bundle markers without an independent family", () => {
    const observations = observeTechnologies({
      signatureInput: signature({
        javascriptBundles: [
          {
            url: `${siteOrigin}/a.js`,
            code: "captureException()",
            stringLiterals: ["@sentry/browser"],
          },
        ],
      }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP",
      surfaceHost: "fixture.example",
      candidates: new Set(),
    });
    const repeated = [
      ...observations,
      ...observations.map((item) => ({ ...item, surfaceHost: "app.fixture.example" })),
    ];
    const fused = fuseTechnologyObservations(repeated, new Set());
    expect(
      fused
        .filter(({ technologySlug }) => technologySlug === "sentry")
        .every(({ status }) => status === "supported"),
    ).toBe(true);
    expect(fused.find(({ technologySlug }) => technologySlug === "sentry")?.suppressionReason).toBe(
      "OPTIONAL_INTEGRATION",
    );
  });

  it("keeps evidence confidence and conflicts isolated by surface", () => {
    const root = observeTechnologies({
      signatureInput: signature({
        javascriptBundles: [
          {
            url: `${siteOrigin}/app.js`,
            code: "captureException()",
            stringLiterals: ["@sentry/browser"],
          },
        ],
      }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP",
      surfaceHost: "app.fixture.example",
      candidates: new Set(),
    });
    const directory = observeTechnologies({
      signatureInput: signature({ runtimeFingerprintIds: ["runtime-sentry-global"] }),
      providerEvidence: [],
      surfaceType: "INTEGRATION_DIRECTORY",
      surfaceHost: "www.fixture.example",
      candidates: new Set(),
    }).map((item) => ({ ...item, status: "conflicted" as const }));
    const fused = fuseTechnologyObservations([...root, ...directory], new Set());
    expect(
      fused.find(
        ({ technologySlug, surfaceType }) =>
          technologySlug === "sentry" && surfaceType === "PRODUCT_APP",
      )?.status,
    ).toBe("supported");
    expect(
      fused.find(
        ({ technologySlug, surfaceType }) =>
          technologySlug === "sentry" && surfaceType === "INTEGRATION_DIRECTORY",
      )?.status,
    ).toBe("conflicted");
  });

  it("maps every current provider signal into a meaningful observation family", () => {
    expect({
      response_header: providerEvidenceFamily("response_header"),
      script_host: providerEvidenceFamily("script_host"),
      script_path: providerEvidenceFamily("script_path"),
      document_host: providerEvidenceFamily("document_host"),
      embedded_url: providerEvidenceFamily("embedded_url"),
      markup_marker: providerEvidenceFamily("markup_marker"),
      resource_host: providerEvidenceFamily("resource_host"),
      csp_host: providerEvidenceFamily("csp_host"),
      api_endpoint: providerEvidenceFamily("api_endpoint"),
      js_sdk: providerEvidenceFamily("js_sdk"),
      redirect_host: providerEvidenceFamily("redirect_host"),
      runtime_host: providerEvidenceFamily("runtime_host"),
      runtime_script_host: providerEvidenceFamily("runtime_script_host"),
      runtime_api_host: providerEvidenceFamily("runtime_api_host"),
    }).toEqual({
      response_header: "response_header",
      script_host: "script_url",
      script_path: "script_url",
      document_host: "html_marker",
      embedded_url: "html_marker",
      markup_marker: "html_marker",
      resource_host: "asset_path",
      csp_host: "csp_host",
      api_endpoint: "public_config",
      js_sdk: "javascript_bundle",
      redirect_host: "html_marker",
      runtime_host: "runtime_fetch_host",
      runtime_script_host: "runtime_script_host",
      runtime_api_host: "runtime_api_host",
    });
  });

  it("keeps derived React evidence out of independent confidence", () => {
    const observations = observeTechnologies({
      signatureInput: signature({ scriptUrls: [`${siteOrigin}/_next/static/chunks/app.js`] }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP",
      surfaceHost: "fixture.example",
      candidates: new Set(),
    });
    const react = observations.find(({ technologySlug }) => technologySlug === "react");
    expect(react).toMatchObject({
      evidenceFamily: "derived_tech_relationship",
      strength: "derived",
      suppressionReason: "DERIVED_ONLY",
    });
    expect(
      fuseTechnologyObservations(observations, new Set()).find(
        ({ technologySlug }) => technologySlug === "react",
      )?.status,
    ).toBe("supported");
  });

  it("inspects bounded same-origin CSS and JS in memory without persisting source text", async () => {
    const htmlBody = '<link rel="stylesheet" href="/main.css"><script src="/app.js"></script>';
    const result = await discoverWebsiteDependencies(`${siteOrigin}/`, {
      deep: true,
      fetcher: async (url) => {
        if (url === `${siteOrigin}/`) return html(htmlBody);
        if (url === `${siteOrigin}/main.css`)
          return html(
            "--tw-ring-offset-shadow:0 0 #000;--tw-ring-shadow:0 0 #000;--tw-shadow:0 0 #000 SECRET_CSS",
            url,
            "text/css",
          );
        if (url === `${siteOrigin}/app.js`)
          return html(
            'import "@sentry/browser"; captureException(); SECRET_JS',
            url,
            "text/javascript",
          );
        throw new Error("unexpected_fixture_url");
      },
    });
    expect(result.technologyObservations?.map(({ technologySlug }) => technologySlug)).toEqual(
      expect.arrayContaining(["tailwindcss", "sentry"]),
    );
    expect(
      result.technologyObservations?.some(
        ({ fingerprintId }) => fingerprintId === "sentry-browser-bundle-pair",
      ),
    ).toBe(true);
    expect(result.coverage.css).toMatchObject({ attempted: 1, fetched: 1, failures: 0 });
    expect(result.coverage.technologyAnalysis?.javascriptBundlesInspected).toBe(1);
    expect(result.coverage.technologyAnalysis?.cssBundlesInspected).toBe(1);
    expect(JSON.stringify(result.technologyObservations)).not.toContain("SECRET_");
    expect(result.candidates).toEqual([]);
  });

  it("bounds CSS inspection by file count and aggregate bytes", async () => {
    const body = `<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><link rel="stylesheet" href="/c.css">`;
    const css = "x".repeat(48 * 1024);
    const fetched: string[] = [];
    const result = await discoverWebsiteDependencies(`${siteOrigin}/`, {
      deep: true,
      fetcher: async (url) => {
        if (url === `${siteOrigin}/`) return html(body);
        fetched.push(url);
        return html(css, url, "text/css");
      },
    });
    expect(fetched).toEqual([`${siteOrigin}/a.css`, `${siteOrigin}/b.css`]);
    expect(result.coverage.css).toMatchObject({
      attempted: 2,
      fetched: 2,
      bytesFetched: 96 * 1024,
      limitReached: true,
    });
  });

  it("caps optional CSS fetch timeouts and continues to same-origin JavaScript", async () => {
    const body = `<link rel="stylesheet" href="/slow-a.css"><link rel="stylesheet" href="/slow-b.css"><script src="/app.js"></script>`;
    const cssTimeouts: number[] = [];
    const urls: string[] = [];
    const result = await discoverWebsiteDependencies(`${siteOrigin}/`, {
      deep: true,
      fetcher: async (url, _validators, limits) => {
        urls.push(url);
        if (url === `${siteOrigin}/`) return html(body);
        if (url.endsWith(".css")) {
          cssTimeouts.push(limits?.timeoutMs ?? 0);
          throw new Error("fixture_css_timeout");
        }
        return html('"@sentry/browser"; captureException();', url, "text/javascript");
      },
    });
    expect(cssTimeouts).toEqual([expect.any(Number), expect.any(Number)]);
    expect(cssTimeouts.every((timeout) => timeout > 0 && timeout <= 1_250)).toBe(true);
    expect(urls).toContain(`${siteOrigin}/app.js`);
    expect(result.coverage.javascript.scriptsFetched).toBe(1);
  });

  it("keeps path and bundle matching bounded on pathological fixture text", () => {
    const long = "x".repeat(25_000);
    const input = signature({
      scriptUrls: [`${siteOrigin}/${long}.js`],
      resourceUrls: [`${siteOrigin}/${long}/wp-content-copy/a.css`],
      stylesheetUrls: [`${siteOrigin}/${long}.css`],
      javascriptBundles: [{ url: `${siteOrigin}/a.js`, code: long, stringLiterals: [long] }],
      cssBundles: [{ url: `${siteOrigin}/a.css`, code: long }],
    });
    const startedAt = performance.now();
    for (const fingerprint of technologyFingerprintRegistry) fingerprint.matches(input);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("keeps bundle support suppressed until existing independent provider candidate logic suggests it", () => {
    const input = {
      signatureInput: signature({
        javascriptBundles: [
          {
            url: `${siteOrigin}/a.js`,
            code: "captureException()",
            stringLiterals: ["@sentry/browser"],
          },
        ],
      }),
      providerEvidence: [],
      surfaceType: "PRODUCT_APP" as const,
      surfaceHost: "fixture.example",
      candidates: new Set<string>(),
    };
    const observed = observeTechnologies(input).find(
      ({ fingerprintId }) => fingerprintId === "sentry-browser-bundle-pair",
    );
    expect(observed).toMatchObject({
      disposition: "suppressed",
      suppressionReason: "OPTIONAL_INTEGRATION",
    });
  });

  it("keeps broad observations away from dependency candidates and public scanner output", async () => {
    const result = await discoverWebsiteDependencies(`${siteOrigin}/`, {
      fetcher: async () => html('<script src="/_next/static/chunks/app.js"></script>'),
    });
    expect(
      result.technologyObservations?.some(({ technologySlug }) => technologySlug === "nextjs"),
    ).toBe(true);
    expect(result.candidates).toEqual([]);
    const publicResult = publicStackScanResult(result);
    expect(JSON.stringify(publicResult)).not.toContain("technologyObservations");
    expect(JSON.stringify(publicResult)).not.toContain("nextjs-static-script");
  });

  it("contains registry exceptions without failing deterministic discovery", async () => {
    const result = await discoverWebsiteDependencies(`${siteOrigin}/`, {
      fetcher: async () => html('<script src="https://js.stripe.com/v3/"></script>'),
      technologyObserver: () => {
        throw new Error("registry_fixture_failure");
      },
    });
    expect(result.candidates.map(({ providerSlug }) => providerSlug)).toContain("stripe");
    expect(result.coverage.technologyAnalysis?.registryFailure).toBe(true);
    expect(result.technologyObservations).toEqual([]);
  });

  it("keeps server-only technologies unknown when no public signal exists", () => {
    const observations = observeTechnologies({
      signatureInput: signature(),
      providerEvidence: [],
      surfaceType: "ROOT_MARKETING",
      surfaceHost: "fixture.example",
      candidates: new Set(),
    });
    expect(observations.some(({ technologySlug }) => technologySlug === "openai")).toBe(false);
    expect(observations.some(({ technologySlug }) => technologySlug === "anthropic")).toBe(false);
  });

  it("retains a versioned labeled benchmark instead of assigning an unsupported universal accuracy score", () => {
    expect(technologyRegistryVersion).toBe("2026-10-04.2");
    expect(technologyFingerprintRegistry.length).toBeGreaterThanOrEqual(25);
    expect(Object.keys(signatureFixtures).length).toBe(technologyFingerprintRegistry.length);
  });
});
