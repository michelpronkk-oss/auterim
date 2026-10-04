import "server-only";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createServer, type Server, type Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { fetchHttpSource, SafeFetchError, type FetchResult } from "@/lib/monitoring/fetcher";
import type {
  DiscoveryRuntimeBudget,
  RuntimeDiscoveryResult,
  RuntimeRequestObservation,
} from "@/lib/discovery/discovery";

export const runtimeDiscoveryLimits = {
  maxDurationMs: 8_000,
  navigationTimeoutMs: 3_500,
  settleMs: 650,
  maxRequests: 60,
  maxHosts: 20,
  maxRedirects: 3,
  maxConcurrentFetches: 3,
  maxTotalResponseBytes: 5 * 1024 * 1024,
  maxTotalWireBytes: 8 * 1024 * 1024,
  maxDocumentBytes: 4 * 1024 * 1024,
  maxScriptBytes: 128 * 1024,
  maxApiBytes: 96 * 1024,
} as const;

type RuntimeBrowserDependencies = {
  launch?: (denyProxyUrl: string) => Promise<Browser>;
  fetcher?: typeof fetchHttpSource;
  initialDocument?: Pick<
    FetchResult,
    "status" | "body" | "bytesRead" | "wireBytesRead" | "bodyTruncated" | "contentType" | "finalUrl"
  >;
  sharedBudget?: DiscoveryRuntimeBudget;
};

type DenyProxy = { url: string; close: () => Promise<void> };

/** Shared production/test launch path. The Windows local test host cannot enable Chromium's OS sandbox. */
export function launchIsolatedChromium(
  denyProxyUrl: string,
  timeoutMs: number,
  hostResolverRules = "MAP * ~NOTFOUND",
) {
  return chromium.launch({
    headless: true,
    chromiumSandbox: process.platform !== "win32",
    proxy: { server: denyProxyUrl },
    timeout: timeoutMs,
    args: [
      `--host-resolver-rules=${hostResolverRules}`,
      "--disable-background-networking",
      "--disable-quic",
      "--disable-webrtc",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--disable-features=WebTransport",
      // Chromium implicitly bypasses proxies for loopback unless this token is present.
      "--proxy-bypass-list=<-loopback>",
      "--no-first-run",
    ],
  });
}

/** A loopback proxy that accepts and immediately drops every direct Chromium connection. */
export async function startDenyProxy(): Promise<DenyProxy> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("deny_proxy_bind_failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function safeLocation(urlValue: string): URL | null {
  try {
    const url = new URL(urlValue);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      (url.port !== "" && url.port !== (url.protocol === "https:" ? "443" : "80")) ||
      url.hostname.length > 253
    ) {
      return null;
    }
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function redirectCount(route: Route) {
  let count = 0;
  let request = route.request().redirectedFrom();
  while (request && count <= runtimeDiscoveryLimits.maxRedirects) {
    count += 1;
    request = request.redirectedFrom();
  }
  return count;
}

function responseContentTypes(resourceType: string) {
  if (resourceType === "document") return ["text/html", "application/xhtml+xml"];
  if (resourceType === "script") {
    return ["text/javascript", "application/javascript", "application/x-javascript"];
  }
  return ["application/json", "text/plain", "text/event-stream"];
}

function maxResponseBytes(resourceType: string) {
  if (resourceType === "document") return runtimeDiscoveryLimits.maxDocumentBytes;
  if (resourceType === "script") return runtimeDiscoveryLimits.maxScriptBytes;
  return runtimeDiscoveryLimits.maxApiBytes;
}

function safeResponseHeaders(contentType: string | null): Record<string, string> {
  return contentType ? { "content-type": contentType } : {};
}

export async function inspectPublicLandingPage(
  rawUrl: string,
  options: { deadlineAt: number; signal?: AbortSignal },
  dependencies: RuntimeBrowserDependencies = {},
): Promise<RuntimeDiscoveryResult> {
  const startedAt = performance.now();
  const memoryBefore = process.memoryUsage().rss;
  const observations = new Map<string, RuntimeRequestObservation>();
  const hosts = new Set<string>();
  let requestsObserved = 0;
  let requestsFulfilled = 0;
  let requestsBlocked = 0;
  let blockedUnsafeRequests = 0;
  let totalResponseBytes = 0;
  let totalWireBytes = 0;
  let reservedResponseBytes = 0;
  let reservedWireBytes = 0;
  let inFlight = 0;
  let bounded = false;
  let unavailable = false;
  const abortController = new AbortController();
  let rejectCallerAbort!: (error: Error) => void;
  const callerAbortRace = new Promise<never>((_, reject) => {
    rejectCallerAbort = reject;
  });
  const abortFromCaller = () => {
    abortController.abort();
    rejectCallerAbort(new Error("runtime_cancelled"));
  };
  if (options.signal?.aborted) {
    return {
      requests: [],
      requestsObserved: 0,
      requestsFulfilled: 0,
      requestsBlocked: 0,
      uniqueHosts: 0,
      blockedUnsafeRequests: 0,
      durationMs: 0,
      status: "unavailable",
      memoryDeltaBytes: 0,
    };
  }
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let denyProxy: DenyProxy | null = null;
  const fetcher = dependencies.fetcher ?? fetchHttpSource;
  const initialUrl = safeLocation(rawUrl);
  if (!initialUrl) {
    return {
      requests: [],
      requestsObserved: 0,
      requestsFulfilled: 0,
      requestsBlocked: 0,
      uniqueHosts: 0,
      blockedUnsafeRequests: 1,
      durationMs: 0,
      status: "unavailable",
      memoryDeltaBytes: 0,
    };
  }
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const deadlineAt = Math.min(options.deadlineAt, startedAt + runtimeDiscoveryLimits.maxDurationMs);
  const remainingMs = () => Math.max(0, Math.floor(deadlineAt - performance.now()));
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadlineRace = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      abortController.abort();
      reject(new Error("runtime_deadline"));
    }, remainingMs());
  });
  const withDeadline = <T>(
    operation: Promise<T>,
    closeLate?: (value: T) => void | Promise<unknown>,
  ) => {
    let completed = false;
    const guarded = operation.then(
      (value) => {
        if (completed && closeLate) void Promise.resolve(closeLate(value)).catch(() => undefined);
        return value;
      },
      (error: unknown) => {
        if (completed) return undefined as T;
        throw error;
      },
    );
    return Promise.race([guarded, deadlineRace, callerAbortRace]).finally(() => {
      completed = true;
    });
  };
  const output = (status: RuntimeDiscoveryResult["status"]): RuntimeDiscoveryResult => ({
    requests: [...observations.values()],
    requestsObserved,
    requestsFulfilled,
    requestsBlocked,
    uniqueHosts: hosts.size,
    blockedUnsafeRequests,
    durationMs: Math.ceil(performance.now() - startedAt),
    status,
    memoryDeltaBytes: Math.max(0, process.memoryUsage().rss - memoryBefore),
  });

  try {
    if (remainingMs() <= 0) return output("unavailable");
    denyProxy = await withDeadline(startDenyProxy(), (proxy) => proxy.close());
    browser = await withDeadline(
      (
        dependencies.launch ??
        ((denyProxyUrl: string) =>
          launchIsolatedChromium(denyProxyUrl, Math.min(4_000, remainingMs())))
      )(denyProxy.url),
      (lateBrowser) => lateBrowser.close(),
    );
    context = await withDeadline(
      browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        javaScriptEnabled: true,
        locale: "en-US",
        viewport: { width: 1024, height: 768 },
      }),
      (lateContext) => lateContext.close(),
    );
    let openedPage: Page | null = null;
    let initialDocumentUsed = false;

    const routeRequest = async (route: Route) => {
      if (remainingMs() <= 0) {
        bounded = true;
        requestsBlocked += 1;
        await route.abort("timedout").catch(() => undefined);
        return;
      }
      const request = route.request();
      const target = safeLocation(request.url());
      const resourceType = request.resourceType();
      const method = request.method();
      if (!target || (method !== "GET" && method !== "HEAD")) {
        if (!target) blockedUnsafeRequests += 1;
        requestsBlocked += 1;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      if (
        resourceType !== "document" &&
        resourceType !== "script" &&
        resourceType !== "fetch" &&
        resourceType !== "xhr"
      ) {
        requestsBlocked += 1;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      if (resourceType === "document") {
        let isMainFrameDocument = false;
        try {
          isMainFrameDocument = !!openedPage && request.frame() === openedPage.mainFrame();
        } catch {
          // Popup initial navigations can briefly lack a frame object. Fail closed.
        }
        if (!isMainFrameDocument) {
          requestsBlocked += 1;
          await route.abort("blockedbyclient").catch(() => undefined);
          return;
        }
      }
      if (redirectCount(route) > runtimeDiscoveryLimits.maxRedirects) {
        bounded = true;
        requestsBlocked += 1;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      if (
        requestsObserved >= runtimeDiscoveryLimits.maxRequests ||
        (!hosts.has(target.hostname) && hosts.size >= runtimeDiscoveryLimits.maxHosts) ||
        (dependencies.sharedBudget &&
          (dependencies.sharedBudget.requests >= dependencies.sharedBudget.maxRequests ||
            (!dependencies.sharedBudget.hosts.has(target.hostname) &&
              dependencies.sharedBudget.hosts.size >= dependencies.sharedBudget.maxHosts)))
      ) {
        bounded = true;
        requestsBlocked += 1;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      if (inFlight >= runtimeDiscoveryLimits.maxConcurrentFetches) {
        bounded = true;
        requestsBlocked += 1;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      const sharedResponseRemaining = dependencies.sharedBudget
        ? dependencies.sharedBudget.maxResponseBytes -
          dependencies.sharedBudget.responseBytes -
          dependencies.sharedBudget.reservedResponseBytes
        : Number.POSITIVE_INFINITY;
      const remainingBytes = Math.min(
        runtimeDiscoveryLimits.maxTotalResponseBytes - totalResponseBytes - reservedResponseBytes,
        sharedResponseRemaining,
      );
      const byteBudget = Math.min(maxResponseBytes(resourceType), remainingBytes);
      const usesInitialDocument =
        !initialDocumentUsed &&
        resourceType === "document" &&
        dependencies.initialDocument?.finalUrl === target.href;
      const sharedWireRemaining = dependencies.sharedBudget
        ? dependencies.sharedBudget.maxWireBytes -
          dependencies.sharedBudget.wireBytes -
          dependencies.sharedBudget.reservedWireBytes
        : Number.POSITIVE_INFINITY;
      const remainingWireBytes = Math.min(
        runtimeDiscoveryLimits.maxTotalWireBytes - totalWireBytes - reservedWireBytes,
        sharedWireRemaining,
      );
      const wireByteBudget = usesInitialDocument
        ? 0
        : Math.min(Math.max(byteBudget * 2, 64 * 1024), 4 * 1024 * 1024, remainingWireBytes);
      if (byteBudget <= 0 || (!usesInitialDocument && wireByteBudget < 64 * 1024)) {
        bounded = true;
        requestsBlocked += 1;
        await route.abort("blockedbyclient").catch(() => undefined);
        return;
      }
      requestsObserved += 1;
      hosts.add(target.hostname);
      if (dependencies.sharedBudget) {
        dependencies.sharedBudget.requests += 1;
        dependencies.sharedBudget.hosts.add(target.hostname);
        dependencies.sharedBudget.reservedResponseBytes += byteBudget;
        dependencies.sharedBudget.reservedWireBytes += wireByteBudget;
      }
      inFlight += 1;
      reservedResponseBytes += byteBudget;
      reservedWireBytes += wireByteBudget;
      let completedFetch = false;
      let wireBytesCharged = 0;
      let initialDocumentResponse = false;
      try {
        // HTTP(S) browser requests are read by Auterim's DNS-validating, IP-pinning fetcher.
        // Chromium only receives the bounded response through route.fulfill.
        const initialDocument = usesInitialDocument ? dependencies.initialDocument : undefined;
        if (initialDocument) {
          initialDocumentUsed = true;
          initialDocumentResponse = true;
        }
        const response =
          initialDocument ??
          (await fetcher(
            target.href,
            {},
            {
              restrictToStandardPorts: true,
              acceptedContentTypes: responseContentTypes(resourceType),
              maxResponseBytes: byteBudget,
              maxWireBytes: wireByteBudget,
              allowTruncatedResponse: false,
              // Playwright treats a fulfilled 3xx chain as one routed request; following in Node
              // ensures every redirect hop is DNS/SSRF-checked before Chromium receives a response.
              followRedirects: true,
              timeoutMs: Math.min(3_000, remainingMs()),
              dnsTimeoutMs: Math.min(1_500, remainingMs()),
              deadlineAt,
              signal: abortController.signal,
              method,
            },
          ));
        completedFetch = true;
        totalResponseBytes += response.bytesRead;
        wireBytesCharged = initialDocumentResponse
          ? 0
          : Math.min(wireByteBudget, response.wireBytesRead ?? response.bytesRead);
        if (dependencies.sharedBudget) {
          dependencies.sharedBudget.responseBytes += response.bytesRead;
          dependencies.sharedBudget.wireBytes += wireBytesCharged;
        }
        if (response.bodyTruncated) bounded = true;
        if (response.contentType && response.body.byteLength > 0) {
          observations.set(`${target.hostname}:${resourceType}`, {
            host: target.hostname.toLowerCase().replace(/\.$/, ""),
            resourceType,
          });
        }
        await route.fulfill({
          status: response.status,
          headers: safeResponseHeaders(response.contentType),
          body: method === "HEAD" ? Buffer.alloc(0) : response.body,
        });
        requestsFulfilled += 1;
      } catch (error) {
        wireBytesCharged = initialDocumentResponse
          ? 0
          : Math.min(
              wireByteBudget,
              error instanceof SafeFetchError && error.wireBytesRead !== undefined
                ? error.wireBytesRead
                : wireByteBudget,
            );
        if (error instanceof SafeFetchError && error.category === "unsafe_target") {
          blockedUnsafeRequests += 1;
        } else if (error instanceof SafeFetchError && error.category === "response_too_large") {
          bounded = true;
        } else if (error instanceof SafeFetchError && error.category === "timeout") {
          bounded = true;
        } else {
          unavailable = true;
        }
        requestsBlocked += 1;
        await route.abort("failed").catch(() => undefined);
      } finally {
        // Conservatively charge the whole reservation on failed reads (including oversized
        // responses), since the fetcher may have consumed bytes before throwing.
        if (!completedFetch) totalResponseBytes += byteBudget;
        totalWireBytes += wireBytesCharged;
        if (dependencies.sharedBudget) {
          if (!completedFetch) dependencies.sharedBudget.responseBytes += byteBudget;
          dependencies.sharedBudget.wireBytes += wireBytesCharged;
          dependencies.sharedBudget.reservedResponseBytes -= byteBudget;
          dependencies.sharedBudget.reservedWireBytes -= wireByteBudget;
        }
        reservedResponseBytes -= byteBudget;
        reservedWireBytes -= wireByteBudget;
        inFlight -= 1;
      }
    };

    // Install network interception before creating the first page. Any missed request can only
    // reach the deny proxy; the proxy itself never forwards or resolves requests.
    await context.route("**/*", routeRequest);
    await context.routeWebSocket("**/*", (socket) => socket.close());
    openedPage = await withDeadline(context.newPage(), (latePage) => latePage.close());
    page = openedPage;
    openedPage.on("popup", (popup) => void popup.close().catch(() => undefined));
    await withDeadline(
      openedPage.addInitScript(() => {
        for (const name of [
          "RTCPeerConnection",
          "webkitRTCPeerConnection",
          "WebTransport",
          "Worker",
          "SharedWorker",
        ]) {
          try {
            Object.defineProperty(globalThis, name, { configurable: false, value: undefined });
          } catch {
            // The deny proxy is the network boundary if an API cannot be hidden.
          }
        }
      }),
    );
    const response = await withDeadline(
      openedPage.goto(initialUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: Math.min(runtimeDiscoveryLimits.navigationTimeoutMs, remainingMs()),
      }),
    );
    if (!response) unavailable = true;
    const settleRemaining = Math.min(runtimeDiscoveryLimits.settleMs, remainingMs());
    if (settleRemaining > 0) await withDeadline(openedPage.waitForTimeout(settleRemaining));
    if (remainingMs() <= 0) bounded = true;
  } catch {
    unavailable = true;
  } finally {
    clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", abortFromCaller);
    abortController.abort();
    const cleanupStartedAt = performance.now();
    const cleanupOperations: Promise<unknown>[] = [];
    if (page) cleanupOperations.push(page.close());
    if (context) cleanupOperations.push(context.close());
    if (browser) cleanupOperations.push(browser.close());
    if (denyProxy) cleanupOperations.push(denyProxy.close());
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Close all layers concurrently under one shared cap, so cleanup cannot add four
      // sequential timeout windows after the scan deadline.
      await Promise.race([
        Promise.all(cleanupOperations.map((operation) => operation.catch(() => undefined))),
        new Promise<void>((resolve) => {
          cleanupTimer = setTimeout(
            resolve,
            Math.max(0, 500 - (performance.now() - cleanupStartedAt)),
          );
        }),
      ]);
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer);
    }
  }

  return observations.size === 0
    ? output("unavailable")
    : output(bounded || unavailable || blockedUnsafeRequests > 0 ? "partial" : "complete");
}
