import { createServer, request as httpRequest, type Server } from "node:http";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { fetchHttpSource } from "@/lib/monitoring/fetcher";
import { discoverWebsiteDependencies } from "@/lib/discovery/discovery";
import {
  inspectPublicLandingPage,
  launchIsolatedChromium,
  startDenyProxy,
} from "@/lib/discovery/runtime-browser";

const controlledUrl = "http://controlled-public.test/";
let server: Server;
let endpointUrl = "";
let directHits = 0;
let mediatedHits = 0;

function requestEndpoint(path: string, headers?: Record<string, string>) {
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
  }>((resolve, reject) => {
    const request = httpRequest(`${endpointUrl}${path}`, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    request.once("error", reject);
    request.end();
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.headers["user-agent"]?.startsWith("AuterimMonitor/")) mediatedHits += 1;
    else directHits += 1;
    if (request.url === "/redirect-a") {
      response.writeHead(302, { location: "/redirect-b" }).end();
      return;
    }
    if (request.url === "/redirect-b") {
      response.writeHead(302, { location: "/final" }).end();
      return;
    }
    if (request.url === "/redirect-private") {
      response.writeHead(302, { location: "https://10.0.0.1/metadata" }).end();
      return;
    }
    if (request.url === "/redirect-loop") {
      response.writeHead(302, { location: "/redirect-loop" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>controlled response</body></html>");
  });
  server.listen(80, "127.0.0.1");
  await once(server, "listening");
  endpointUrl = "http://127.0.0.1";
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("application-level Chromium egress isolation", () => {
  it("blocks a direct Chromium connection and allows the same URL through safe-fetch mediation", async () => {
    // Prove the local endpoint is reachable without isolation, so a blocked request is meaningful.
    const control = await chromium.launch({
      headless: true,
      args: ["--host-resolver-rules=MAP controlled-public.test 127.0.0.1"],
    });
    try {
      const controlPage = await control.newPage();
      await controlPage.goto(controlledUrl, { timeout: 3_000 });
      expect(directHits).toBeGreaterThan(0);
    } finally {
      await control.close();
    }
    directHits = 0;

    // This is the exact production launcher, with only its DNS fixture mapping overridden.
    const denyProxy = await startDenyProxy();
    const browser = await launchIsolatedChromium(
      denyProxy.url,
      3_000,
      "MAP controlled-public.test 127.0.0.1",
    );
    try {
      const context = await browser.newContext({ serviceWorkers: "block" });
      const page = await context.newPage();
      await expect(page.goto(controlledUrl, { timeout: 2_000 })).rejects.toThrow();
      await expect(page.goto("http://127.0.0.1/", { timeout: 2_000 })).rejects.toThrow();
      expect(directHits).toBe(0);
      await context.close();
    } finally {
      await browser.close();
      await denyProxy.close();
    }

    const fetcher = async (
      url: string,
      validators: { etag?: string | null; lastModified?: string | null },
      limits: Record<string, unknown>,
    ) =>
      fetchHttpSource(url, validators, {
        ...limits,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async (safeUrl, headers) => {
          expect(
            Object.keys(headers).some((name) => /cookie|authorization|origin|csrf/i.test(name)),
          ).toBe(false);
          const endpoint = await requestEndpoint(safeUrl.pathname, headers);
          return {
            status: endpoint.status,
            headers: endpoint.headers,
            body: (async function* () {
              yield endpoint.body;
            })(),
          };
        },
      });

    const result = await inspectPublicLandingPage(
      controlledUrl,
      { deadlineAt: performance.now() + 10_000 },
      { fetcher: fetcher as never },
    );
    expect(result.requests).toContainEqual({
      host: "controlled-public.test",
      resourceType: "document",
    });
    expect(result.requestsFulfilled).toBeGreaterThan(0);
    expect(mediatedHits).toBe(1);
    expect(directHits).toBe(0);
  }, 25_000);

  it("captures five controlled runtime provider signals through the mediated browser path", async () => {
    const fixtureUrl = "https://app.runtime-fixture.test/";
    const providerScriptUrls = [
      "https://js.stripe.com/v3/",
      "https://browser.sentry-cdn.com/bundle.js",
      "https://us.i.posthog.com/static/array.js",
    ];
    const html = `<!doctype html><html><head></head><body><script>
      (async () => {
        for (const src of ${JSON.stringify(providerScriptUrls)}) {
          await new Promise((resolve) => {
            const script = document.createElement("script");
            script.onload = resolve;
            script.onerror = resolve;
            script.src = src;
            document.head.appendChild(script);
          });
        }
        await fetch("https://fixture-project.supabase.co/rest/v1/").catch(() => null);
      })();
    </script></body></html>`;
    const mediatedFetcher = async (
      url: string,
      validators: { etag?: string | null; lastModified?: string | null },
      limits: Record<string, unknown>,
    ) =>
      fetchHttpSource(url, validators, {
        ...limits,
        resolveHost: async () => [{ address: "93.184.216.34", family: 4 }],
        request: async (safeUrl) => {
          const root = safeUrl.href === fixtureUrl;
          return {
            status: 200,
            headers: {
              "content-type": root
                ? "text/html; charset=utf-8"
                : safeUrl.hostname === "fixture-project.supabase.co"
                  ? "application/json"
                  : "text/javascript",
              ...(root ? { server: "Vercel" } : {}),
            },
            body: (async function* () {
              yield Buffer.from(
                root
                  ? html
                  : safeUrl.pathname.includes("rest")
                    ? "{}"
                    : "window.fixtureLoaded = true;",
              );
            })(),
          };
        },
      });
    const discovery = await discoverWebsiteDependencies(fixtureUrl, {
      deep: true,
      runtimeEnabled: true,
      fetcher: mediatedFetcher as never,
      runtimeRunner: (url, options, dependencies) =>
        inspectPublicLandingPage(url, options, {
          fetcher: mediatedFetcher as never,
          initialDocument: dependencies?.initialDocument,
        }),
    });

    expect(discovery.coverage.runtime.attempted).toBe(true);
    expect(discovery.coverage.runtime.requestsFulfilled).toBeGreaterThanOrEqual(5);
    expect(discovery.candidates.map(({ providerSlug }) => providerSlug).sort()).toEqual([
      "posthog",
      "sentry",
      "stripe",
      "supabase",
      "vercel",
    ]);
    expect(new Set(discovery.evidence.map(({ signalType }) => signalType))).toEqual(
      new Set(["response_header", "runtime_script_host", "runtime_api_host"]),
    );
  }, 25_000);

  it("terminates a real busy page at the runtime deadline and closes Chromium", async () => {
    let browser: Browser | undefined;
    const url = "https://stalled.runtime-fixture.test/";
    const html = "<!doctype html><script>setInterval(() => {}, 0)</script>";
    const started = performance.now();
    const result = await inspectPublicLandingPage(
      url,
      { deadlineAt: started + 500 },
      {
        launch: async (denyProxyUrl) => {
          browser = await launchIsolatedChromium(denyProxyUrl, 3_000);
          return browser;
        },
        initialDocument: {
          status: 200,
          body: Buffer.from(html),
          bytesRead: Buffer.byteLength(html),
          wireBytesRead: 0,
          bodyTruncated: false,
          contentType: "text/html",
          finalUrl: url,
        },
      },
    );

    expect(performance.now() - started).toBeLessThan(1_500);
    expect(result.status).toBe("partial");
    expect(result.requests).toEqual([
      { host: "stalled.runtime-fixture.test", resourceType: "document" },
    ]);
    expect(browser?.isConnected()).toBe(false);
  }, 25_000);

  it("re-intercepts public redirects and blocks a public-to-private redirect before transport", async () => {
    let privateTargetTransportCalls = 0;
    const fetcher = async (
      url: string,
      validators: { etag?: string | null; lastModified?: string | null },
      limits: Record<string, unknown>,
    ) =>
      fetchHttpSource(url, validators, {
        ...limits,
        resolveHost: async (host) =>
          host === "controlled-public.test"
            ? [{ address: "93.184.216.34", family: 4 }]
            : [{ address: "10.0.0.1", family: 4 }],
        request: async (safeUrl, headers) => {
          if (safeUrl.hostname !== "controlled-public.test") privateTargetTransportCalls += 1;
          const endpoint = await requestEndpoint(safeUrl.pathname, headers);
          return {
            status: endpoint.status,
            headers: endpoint.headers,
            body: (async function* () {
              yield endpoint.body;
            })(),
          };
        },
      });
    const publicResult = await inspectPublicLandingPage(
      new URL("/redirect-a", controlledUrl).href,
      { deadlineAt: performance.now() + 10_000 },
      { fetcher: fetcher as never },
    );
    expect(publicResult.requestsObserved).toBe(1);
    expect(publicResult.requestsFulfilled).toBe(1);
    expect(publicResult.status).toBe("complete");

    const privateResult = await inspectPublicLandingPage(
      new URL("/redirect-private", controlledUrl).href,
      { deadlineAt: performance.now() + 10_000 },
      { fetcher: fetcher as never },
    );
    expect(privateTargetTransportCalls).toBe(0);
    expect(privateResult.blockedUnsafeRequests).toBe(1);
    expect(privateResult.requestsBlocked).toBeGreaterThan(0);

    const loopResult = await inspectPublicLandingPage(
      new URL("/redirect-loop", controlledUrl).href,
      { deadlineAt: performance.now() + 10_000 },
      { fetcher: fetcher as never },
    );
    expect(loopResult.requestsObserved).toBeLessThanOrEqual(5);
    expect(loopResult.requestsBlocked).toBeGreaterThan(0);
  }, 25_000);

  it("blocks JavaScript fetches to loopback, private, link-local, metadata, and IPv6 targets", async () => {
    const urls = [
      "http://127.0.0.1/",
      "http://localhost/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.0.1/",
      "http://169.254.169.254/",
      "http://[::1]/",
      "https://127.0.0.1/",
      "https://10.0.0.1/",
      "https://172.16.0.1/",
      "https://192.168.0.1/",
      "https://169.254.169.254/",
      "https://[::1]/",
    ];
    const html = `<!doctype html><script>void Promise.all(${JSON.stringify(urls)}.map((url) => fetch(url).catch(() => null)))</script>`;
    let transportCalls = 0;
    const fetcher = async (
      url: string,
      validators: { etag?: string | null; lastModified?: string | null },
      limits: Record<string, unknown>,
    ) =>
      fetchHttpSource(url, validators, {
        ...limits,
        resolveHost: async (host) => {
          if (host === "controlled-public.test") return [{ address: "93.184.216.34", family: 4 }];
          if (host.includes(":")) return [{ address: "::1", family: 6 }];
          if (host === "localhost") return [{ address: "127.0.0.1", family: 4 }];
          return [{ address: host, family: 4 }];
        },
        request: async () => {
          transportCalls += 1;
          return {
            status: 200,
            headers: { "content-type": "text/html" },
            body: (async function* () {
              yield Buffer.from(html);
            })(),
          };
        },
      });
    const result = await inspectPublicLandingPage(
      controlledUrl,
      { deadlineAt: performance.now() + 10_000 },
      {
        fetcher: fetcher as never,
        launch: async (proxyUrl) =>
          (await chromium.launch({
            headless: true,
            proxy: { server: proxyUrl },
            args: [
              "--host-resolver-rules=MAP * ~NOTFOUND",
              "--disable-background-networking",
              "--disable-quic",
              "--disable-webrtc",
              "--disable-features=WebTransport",
              "--proxy-bypass-list=<-loopback>",
              "--no-first-run",
            ],
          })) as Browser,
      },
    );

    expect(transportCalls).toBe(1);
    expect(result.blockedUnsafeRequests).toBeGreaterThanOrEqual(1);
    expect(result.requestsBlocked).toBeGreaterThanOrEqual(urls.length);
  }, 25_000);

  it("blocks direct WebRTC/STUN UDP even when page JavaScript attempts a local socket", async () => {
    const udp = createSocket("udp4");
    let udpPackets = 0;
    udp.on("message", () => {
      udpPackets += 1;
    });
    udp.bind(0, "127.0.0.1");
    await once(udp, "listening");
    const address = udp.address();
    const html = `<!doctype html><script>
      const Peer = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (Peer) {
        const pc = new Peer({ iceServers: [{ urls: "stun:127.0.0.1:${address.port}" }] });
        pc.createDataChannel("probe");
        pc.createOffer().then((offer) => pc.setLocalDescription(offer)).catch(() => undefined);
      }
    </script>`;
    const fetcher = async (url: string) => ({
      status: 200,
      body: Buffer.from(html),
      bytesRead: Buffer.byteLength(html),
      wireBytesRead: Buffer.byteLength(html),
      bodyTruncated: false,
      contentType: "text/html",
      safeHeaders: {},
      etag: null,
      lastModified: null,
      finalUrl: url,
    });

    try {
      await inspectPublicLandingPage(
        controlledUrl,
        { deadlineAt: performance.now() + 10_000 },
        {
          fetcher: fetcher as never,
          launch: async (proxyUrl) =>
            (await chromium.launch({
              headless: true,
              proxy: { server: proxyUrl },
              args: [
                "--host-resolver-rules=MAP * ~NOTFOUND",
                "--disable-background-networking",
                "--disable-quic",
                "--disable-webrtc",
                "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                "--disable-features=WebTransport",
                "--proxy-bypass-list=<-loopback>",
                "--no-first-run",
              ],
            })) as Browser,
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(udpPackets).toBe(0);
    } finally {
      await new Promise<void>((resolve) => udp.close(resolve));
    }
  }, 25_000);

  it("uses an isolated world for runtime probes against page-poisoned intrinsics and lookalike hosts", async () => {
    const url = "https://isolated-world.runtime-fixture.test/";
    const html = `<!doctype html><script>
      window.Sentry = new Proxy({}, { getOwnPropertyDescriptor() { while (true) {} } });
      Object.getOwnPropertyDescriptor = () => ({ value: {} });
      Document.prototype.querySelector = () => { while (true) {} };
      document.querySelector = () => { while (true) {} };
      document.querySelectorAll = () => { while (true) {} };
    </script><iframe src="https://evilgoogle.com/recaptcha/frame"></iframe>`;
    const started = performance.now();
    let browser: Browser | undefined;
    const result = await inspectPublicLandingPage(
      url,
      { deadlineAt: started + 7_000 },
      {
        launch: async (proxyUrl) => {
          browser = await launchIsolatedChromium(proxyUrl, 3_000);
          return browser;
        },
        initialDocument: {
          status: 200,
          body: Buffer.from(html),
          bytesRead: Buffer.byteLength(html),
          wireBytesRead: 0,
          bodyTruncated: false,
          contentType: "text/html",
          finalUrl: url,
        },
      },
    );
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(result.status).toBe("complete");
    expect(result.technologyFingerprintIds).toContain("runtime-sentry-global");
    expect(result.technologyFingerprintIds).not.toContain("runtime-recaptcha-frame");
    expect(browser?.isConnected()).toBe(false);
  }, 25_000);

  it("enforces the WebRTC UDP policy even when constructors are left exposed", async () => {
    const udp = createSocket("udp4");
    let udpPackets = 0;
    udp.on("message", () => {
      udpPackets += 1;
    });
    udp.bind(0, "127.0.0.1");
    await once(udp, "listening");
    const address = udp.address();
    const denyProxy = await startDenyProxy();
    const browser = await chromium.launch({
      headless: true,
      proxy: { server: denyProxy.url },
      args: [
        "--host-resolver-rules=MAP * ~NOTFOUND",
        "--disable-quic",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        "--proxy-bypass-list=<-loopback>",
      ],
    });
    try {
      const page = await browser.newPage();
      const apiAvailable = await page.evaluate((port) => {
        const Peer =
          window.RTCPeerConnection ||
          (window as unknown as { webkitRTCPeerConnection?: typeof RTCPeerConnection })
            .webkitRTCPeerConnection;
        if (!Peer) return false;
        const connection = new Peer({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
        connection.createDataChannel("direct-udp-probe");
        void connection
          .createOffer()
          .then((offer) => connection.setLocalDescription(offer))
          .catch(() => undefined);
        return true;
      }, address.port);
      expect(apiAvailable).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      expect(udpPackets).toBe(0);
    } finally {
      await browser.close();
      await denyProxy.close();
      await new Promise<void>((resolve) => udp.close(resolve));
    }
  }, 25_000);
});
