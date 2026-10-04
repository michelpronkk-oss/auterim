import { describe, expect, it } from "vitest";
import { readBoundedSearchConsoleJson, SearchConsoleError } from "@/lib/growth-v2/search-console";

describe("bounded Search Console JSON responses", () => {
  it("parses a complete response under the byte cap", async () => {
    const response = new Response(JSON.stringify({ rows: [{ keys: ["2026-10-01"] }] }));

    await expect(readBoundedSearchConsoleJson(response, 1024)).resolves.toEqual({
      rows: [{ keys: ["2026-10-01"] }],
    });
  });

  it("rejects an oversized streamed response and cancels further consumption", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"rows":['));
      },
      pull(controller) {
        controller.enqueue(new Uint8Array(32));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body, { headers: { "content-type": "application/json" } });

    const result = readBoundedSearchConsoleJson(response, 16);

    await expect(result).rejects.toMatchObject({
      category: "invalid_response",
      retryable: false,
    } satisfies Partial<SearchConsoleError>);
    expect(cancelled).toBe(true);
  });

  it("rejects an oversized declared body before reading it", async () => {
    const response = new Response("{}", { headers: { "content-length": "100" } });

    await expect(readBoundedSearchConsoleJson(response, 8)).rejects.toMatchObject({
      category: "invalid_response",
      retryable: false,
    });
  });

  it("rejects malformed JSON as a typed non-retryable response error", async () => {
    await expect(readBoundedSearchConsoleJson(new Response("{"), 16)).rejects.toMatchObject({
      category: "invalid_response",
      retryable: false,
    });
  });
});
