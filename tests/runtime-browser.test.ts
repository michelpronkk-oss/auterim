import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { inspectPublicLandingPage } from "@/lib/discovery/runtime-browser";
import { SafeFetchError, type FetchResult } from "@/lib/monitoring/fetcher";

function response(
  url: string,
  body: string,
  contentType: string,
  wireBytesRead?: number,
): FetchResult {
  return {
    status: 200,
    body: Buffer.from(body),
    bytesRead: Buffer.byteLength(body),
    wireBytesRead,
    bodyTruncated: false,
    contentType,
    safeHeaders: {},
    etag: null,
    lastModified: null,
    finalUrl: url,
  };
}

function browserHarness(
  onGoto: (route: (value: unknown) => Promise<void>, frame: object) => Promise<void>,
) {
  let routeHandler: ((value: unknown) => Promise<void>) | null = null;
  const lifecycleOrder: string[] = [];
  const frame = {};
  const page = {
    on: vi.fn(),
    addInitScript: vi.fn(async () => undefined),
    mainFrame: () => frame,
    goto: async () => {
      if (!routeHandler) throw new Error("Route handler was not installed before navigation.");
      lifecycleOrder.push("navigate");
      await onGoto(routeHandler, frame);
      return { status: () => 200 };
    },
    waitForTimeout: async () => undefined,
    close: vi.fn(async (): Promise<void> => undefined),
  };
  const context = {
    newPage: async () => {
      lifecycleOrder.push("page");
      return page;
    },
    route: async (_pattern: string, handler: (value: unknown) => Promise<void>) => {
      lifecycleOrder.push("route");
      routeHandler = handler;
    },
    routeWebSocket: vi.fn(async () => undefined),
    close: vi.fn(async (): Promise<void> => undefined),
  };
  const browser = {
    newContext: async () => context,
    close: vi.fn(async (): Promise<void> => undefined),
  };
  const makeRoute = (url: string, resourceType: string, targetFrame: object, method = "GET") => {
    const fulfilled: Array<{
      status?: number;
      headers?: Record<string, string>;
      body?: Buffer | string;
    }> = [];
    const request = {
      url: () => url,
      resourceType: () => resourceType,
      method: () => method,
      frame: () => targetFrame,
      redirectedFrom: () => null,
    };
    return {
      value: {
        request: () => request,
        abort: vi.fn(async () => undefined),
        fulfill: vi.fn(async (value: (typeof fulfilled)[number]) => {
          fulfilled.push(value);
        }),
      },
      fulfilled,
    };
  };
  return { browser, page, context, frame, makeRoute, lifecycleOrder };
}

describe("bounded runtime dependency discovery", () => {
  it("captures only normalized public request metadata and closes the isolated browser", async () => {
    let capturedQuery = false;
    const harness = browserHarness(async (route, frame) => {
      const root = harness.makeRoute("https://company.example/?token=private", "document", frame);
      const script = harness.makeRoute(
        "https://js.stripe.com/v3/?publishable_key=private",
        "script",
        frame,
      );
      const unsafe = harness.makeRoute("https://127.0.0.1/admin", "fetch", frame);
      await route(root.value);
      await route(script.value);
      await route(unsafe.value);
      expect(root.value.fulfill).toHaveBeenCalledOnce();
      expect(script.value.fulfill).toHaveBeenCalledOnce();
      expect(unsafe.value.abort).toHaveBeenCalledOnce();
      capturedQuery = JSON.stringify([root.fulfilled, script.fulfilled]).includes("private");
    });
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).hostname === "127.0.0.1") {
        throw new SafeFetchError("unsafe_target", "private target");
      }
      return response(url, "safe", url.includes("stripe") ? "text/javascript" : "text/html");
    });
    const result = await inspectPublicLandingPage(
      "https://company.example/?customer=private",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser, fetcher: fetcher as never },
    );

    expect(result).toMatchObject({
      status: "partial",
      requestsObserved: 3,
      uniqueHosts: 3,
      blockedUnsafeRequests: 1,
    });
    expect(result.requests).toEqual([
      { host: "company.example", resourceType: "document" },
      { host: "js.stripe.com", resourceType: "script" },
    ]);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(capturedQuery).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(harness.page.close).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.browser.close).toHaveBeenCalledOnce();
    expect(harness.context.routeWebSocket).toHaveBeenCalledOnce();
    expect(harness.lifecycleOrder.indexOf("route")).toBeLessThan(
      harness.lifecycleOrder.indexOf("page"),
    );
    expect(harness.lifecycleOrder.indexOf("page")).toBeLessThan(
      harness.lifecycleOrder.indexOf("navigate"),
    );
  });

  it("blocks unsafe schemes, POSTs, frames, and generic assets before any fetch", async () => {
    const harness = browserHarness(async (route, frame) => {
      const unsafeScheme = harness.makeRoute("file:///etc/passwd", "document", frame);
      const post = harness.makeRoute("https://company.example/api", "fetch", frame, "POST");
      const iframe = harness.makeRoute("https://third.example/", "document", {});
      const image = harness.makeRoute("https://images.example/logo.png", "image", frame);
      const popupDocument = {
        request: () => ({
          url: () => "https://popup.example/",
          resourceType: () => "document",
          method: () => "GET",
          frame: () => {
            throw new Error("popup frame is not available yet");
          },
          redirectedFrom: () => null,
        }),
        abort: vi.fn(async () => undefined),
        fulfill: vi.fn(async () => undefined),
      };
      await route(unsafeScheme.value);
      await route(post.value);
      await route(iframe.value);
      await route(image.value);
      await route(popupDocument);
      expect(popupDocument.abort).toHaveBeenCalledOnce();
    });
    const fetcher = vi.fn();
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser, fetcher: fetcher as never },
    );
    expect(result.status).toBe("unavailable");
    expect(result.blockedUnsafeRequests).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("mediates HEAD but blocks mutating methods and forwards no request bodies", async () => {
    const harness = browserHarness(async (route, frame) => {
      const head = harness.makeRoute("https://company.example/health", "xhr", frame, "HEAD");
      const post = harness.makeRoute("https://company.example/api", "fetch", frame, "POST");
      await route(head.value);
      await route(post.value);
      expect(head.value.fulfill).toHaveBeenCalledOnce();
      expect(post.value.abort).toHaveBeenCalledOnce();
    });
    const fetcher = vi.fn(async (url: string, validators: unknown, options: { method: string }) => {
      void validators;
      void options;
      return response(url, "must not be forwarded for HEAD", "application/json");
    });
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser, fetcher: fetcher as never },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[2]).toMatchObject({ method: "HEAD" });
    expect(result.requestsBlocked).toBeGreaterThan(0);
  });

  it("fulfills the main document from the already safe-fetched response when available", async () => {
    let fulfilledBody: string | Buffer | undefined;
    const harness = browserHarness(async (route, frame) => {
      const root = harness.makeRoute("https://company.example/", "document", frame);
      await route(root.value);
      fulfilledBody = root.fulfilled[0]?.body;
    });
    const fetcher = vi.fn();
    const initialDocument = response(
      "https://company.example/",
      "<html><body>safe preloaded document</body></html>",
      "text/html",
    );
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      {
        launch: async () => harness.browser as unknown as Browser,
        fetcher: fetcher as never,
        initialDocument,
      },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(fulfilledBody?.toString()).toContain("safe preloaded document");
    expect(result.requestsFulfilled).toBe(1);
    expect(result.requests).toEqual([{ host: "company.example", resourceType: "document" }]);
  });

  it("degrades to unavailable when browser launch fails", async () => {
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      {
        launch: async () => {
          throw new Error("browser unavailable");
        },
      },
    );
    expect(result).toMatchObject({ status: "unavailable", requestsObserved: 0, uniqueHosts: 0 });
  });

  it("retains fulfilled static evidence and closes resources after a page crash", async () => {
    const harness = browserHarness(async (route, frame) => {
      await route(harness.makeRoute("https://company.example/", "document", frame).value);
      throw new Error("page crashed");
    });
    const fetcher = vi.fn(async (url: string) => response(url, "safe html", "text/html"));
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser, fetcher: fetcher as never },
    );

    expect(result.status).toBe("partial");
    expect(result.requests).toEqual([{ host: "company.example", resourceType: "document" }]);
    expect(harness.page.close).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("closes the browser after an early browser-disconnect error", async () => {
    const harness = browserHarness(async () => undefined);
    harness.browser.newContext = async () => {
      throw new Error("browser disconnected");
    };
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser },
    );

    expect(result.status).toBe("unavailable");
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("does not launch Chromium for an already-cancelled task", async () => {
    const launch = vi.fn();
    const signal = AbortSignal.abort();
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000, signal },
      { launch },
    );
    expect(result.status).toBe("unavailable");
    expect(launch).not.toHaveBeenCalled();
  });

  it("charges oversized failed responses against the aggregate byte budget", async () => {
    const harness = browserHarness(async (route, frame) => {
      for (let index = 0; index < 50; index += 1) {
        const target = harness.makeRoute(`https://host.example/app-${index}.js`, "script", frame);
        await route(target.value);
      }
    });
    const fetcher = vi.fn(async (url: string) => {
      if (new URL(url).hostname !== "company.example") {
        throw new SafeFetchError("response_too_large", "bounded");
      }
      return response(url, "<html></html>", "text/html");
    });
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser, fetcher: fetcher as never },
    );
    // Failed reads consume the aggregate response reservation; later requests are blocked.
    expect(fetcher).toHaveBeenCalledTimes(32);
    expect(result.status).toBe("unavailable");
  });

  it("enforces a separate aggregate encoded-wire budget", async () => {
    const harness = browserHarness(async (route, frame) => {
      await route(harness.makeRoute("https://company.example/", "document", frame).value);
      for (let index = 0; index < 40; index += 1) {
        await route(
          harness.makeRoute(`https://script.example/app-${index}.js`, "script", frame).value,
        );
      }
    });
    const fetcher = vi.fn(async (url: string) =>
      new URL(url).hostname === "company.example"
        ? response(url, "<html></html>", "text/html", 1_048_576)
        : response(url, "x", "text/javascript", 250_000),
    );
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser, fetcher: fetcher as never },
    );
    expect(fetcher).toHaveBeenCalledTimes(31);
    expect(result.status).toBe("partial");
  });

  it("limits actual overlapping fetch callbacks to the configured concurrency", async () => {
    const harness = browserHarness(async (route, frame) => {
      const routes = [
        harness.makeRoute("https://company.example/", "document", frame),
        ...Array.from({ length: 5 }, (_, index) =>
          harness.makeRoute(`https://asset-${index}.example/app.js`, "script", frame),
        ),
      ];
      await Promise.all(routes.map(({ value }) => route(value)));
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher = vi.fn(async (url: string) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight -= 1;
      return response(url, "safe", new URL(url).pathname === "/" ? "text/html" : "text/javascript");
    });
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000 },
      { launch: async () => harness.browser as unknown as Browser, fetcher: fetcher as never },
    );

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.requestsBlocked).toBeGreaterThan(0);
  });

  it("closes a browser that resolves after the runtime deadline", async () => {
    const harness = browserHarness(async () => undefined);
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 300 },
      {
        launch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 500));
          return harness.browser as unknown as Browser;
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(result.status).toBe("unavailable");
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("closes contexts and pages that resolve after the runtime deadline", async () => {
    const delayedContext = browserHarness(async () => undefined);
    delayedContext.browser.newContext = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return delayedContext.context as never;
    };
    const contextResult = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 300 },
      { launch: async () => delayedContext.browser as unknown as Browser },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(contextResult.status).toBe("unavailable");
    expect(delayedContext.context.close).toHaveBeenCalledOnce();

    const delayedPage = browserHarness(async () => undefined);
    delayedPage.context.newPage = async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return delayedPage.page as never;
    };
    const pageResult = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 300 },
      { launch: async () => delayedPage.browser as unknown as Browser },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(pageResult.status).toBe("unavailable");
    expect(delayedPage.page.close).toHaveBeenCalledOnce();
  });

  it("closes browser resources when navigation never settles before the deadline", async () => {
    const harness = browserHarness(() => new Promise<void>(() => undefined));
    const started = performance.now();
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: started + 300 },
      { launch: async () => harness.browser as unknown as Browser },
    );

    expect(performance.now() - started).toBeLessThan(1_500);
    expect(result.status).toBe("unavailable");
    expect(harness.page.close).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("bounds cleanup when page, context, and browser close operations stall", async () => {
    const harness = browserHarness(() => new Promise<void>(() => undefined));
    const neverClose = () => new Promise<void>(() => undefined);
    harness.page.close = vi.fn(neverClose);
    harness.context.close = vi.fn(neverClose);
    harness.browser.close = vi.fn(neverClose);
    const started = performance.now();
    const result = await inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: started + 300 },
      { launch: async () => harness.browser as unknown as Browser },
    );

    expect(performance.now() - started).toBeLessThan(1_200);
    expect(result.status).toBe("unavailable");
    expect(harness.page.close).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });

  it("returns promptly on caller cancellation and closes browser resources", async () => {
    const harness = browserHarness(() => new Promise<void>(() => undefined));
    const controller = new AbortController();
    const run = inspectPublicLandingPage(
      "https://company.example/",
      { deadlineAt: performance.now() + 20_000, signal: controller.signal },
      { launch: async () => harness.browser as unknown as Browser },
    );
    setTimeout(() => controller.abort(), 20);
    const result = await run;

    expect(result.status).toBe("unavailable");
    expect(harness.page.close).toHaveBeenCalledOnce();
    expect(harness.browser.close).toHaveBeenCalledOnce();
  });
});
