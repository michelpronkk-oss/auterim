import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const fixture = fileURLToPath(new URL("../fixtures/projects/basic", import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("CLI device authorization", () => {
  it("keeps dry-run offline and refuses arbitrary upload hosts", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await main(["connect", "--server", "https://attacker.example", "--root", fixture])).toBe(
      2,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("polls for approval, requires interactive consent, and never prints bearer secrets", async () => {
    const pollSecret = "poll-secret-canary-not-for-output-1234567890";
    const credential = "acli_" + "x".repeat(43);
    const requests: Array<{ path: string; body: string; authorization: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = typeof init?.body === "string" ? init.body : "";
        requests.push({
          path: url.pathname,
          body,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (url.pathname.endsWith("/connect"))
          return Response.json(
            {
              sessionId: "11111111-1111-4111-8111-111111111111",
              userCode: "ABCDE-12345",
              pollSecret,
              verificationUrl: "http://127.0.0.1:3000/app/cli/connect?code=ABCDE12345",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              intervalSeconds: 3,
            },
            { status: 201 },
          );
        if (url.pathname.endsWith("/poll"))
          return Response.json({ status: "approved", credential, scope: "submit_local_discovery" });
        if (url.pathname.endsWith("/cancel")) return Response.json({ cancelled: true });
        throw new Error("unexpected_request");
      }),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    expect(await main(["connect", "--server", "http://127.0.0.1:3000", "--root", fixture])).toBe(0);
    expect(requests.map((request) => request.path)).toEqual([
      "/api/cli/v1/connect",
      "/api/cli/v1/connect/poll",
      "/api/cli/v1/connect/cancel",
    ]);
    expect(requests[1]?.body).toContain(pollSecret);
    expect(requests[2]?.body).toContain(pollSecret);
    expect(requests.every((request) => request.authorization === null)).toBe(true);
    expect(output.join("")).toContain("ABCDE-12345");
    expect(output.join("")).not.toContain(pollSecret);
    expect(output.join("")).not.toContain(credential);
  });
});
