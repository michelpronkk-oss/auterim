import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

const fixture = fileURLToPath(new URL("../fixtures/projects/basic", import.meta.url));
const scratch: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function configDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "auterim-cli-test-"));
  scratch.push(directory);
  return directory;
}

describe("CLI command contract", () => {
  it("provides help/version and rejects conflicting dry-run/network options", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    expect(await main(["--help"])).toBe(0);
    expect(await main(["connect", "--help"])).toBe(0);
    expect(await main(["--version"])).toBe(0);
    expect(writes.join("")).toContain("Usage: auterim <command>");
    expect(writes.join("")).toContain("Usage: auterim connect");
    expect(writes.join("")).toContain("0.1.0");
    expect(await main(["connect", "--dry-run", "--server", "https://auterim.com"])).toBe(2);
  });

  it("keeps dry-run offline and rejects untrusted origins before making requests", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await main(["connect", "--server", "https://attacker.example", "--root", fixture])).toBe(
      2,
    );
    expect(
      await main(["connect", "--dry-run", "--root", fixture], {
        configDirectory: await configDirectory(),
      }),
    ).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires interactive consent before creating a connection", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await main(["connect", "--server", "http://127.0.0.1:3000", "--root", fixture], {
        interactive: false,
        ci: false,
        configDirectory: await configDirectory(),
      }),
    ).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("CLI device authorization", () => {
  it("submits only after consent and never prints bearer secrets", async () => {
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
              verificationUrl: "http://127.0.0.1:3000/app/cli/connect?code=ABCDE-12345",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              intervalSeconds: 3,
            },
            { status: 201 },
          );
        if (url.pathname.endsWith("/poll"))
          return Response.json({ status: "approved", credential, scope: "submit_local_discovery" });
        if (url.pathname.endsWith("/discovery"))
          return Response.json(
            { accepted: true, scanId: "scan-123", observationCount: 2 },
            { status: 201 },
          );
        if (url.pathname.endsWith("/cancel")) return Response.json({ cancelled: true });
        throw new Error("unexpected_request");
      }),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    expect(
      await main(["connect", "--server", "http://127.0.0.1:3000", "--root", fixture], {
        interactive: true,
        ci: false,
        configDirectory: await configDirectory(),
        openBrowser: async () => false,
        confirm: async () => true,
      }),
    ).toBe(0);
    expect(requests.map((request) => request.path)).toEqual([
      "/api/cli/v1/connect",
      "/api/cli/v1/connect/poll",
      "/api/cli/v1/discovery",
    ]);
    expect(requests[1]?.body).toContain(pollSecret);
    expect(requests[2]?.body).not.toContain(fixture);
    const uploadedPayload = JSON.parse(requests[2]?.body ?? "{}") as Record<string, unknown>;
    expect(uploadedPayload.projectFingerprint).toBeNull();
    expect(uploadedPayload).not.toHaveProperty("localProjectId");
    expect(
      requests.every(
        (request) => request.authorization === null || request.path.endsWith("/discovery"),
      ),
    ).toBe(true);
    expect(requests[2]?.authorization).toBe(`Bearer ${credential}`);
    expect(output.join("")).toContain("ABCDE-12345");
    expect(output.join("")).toContain("Copy the approval URL above into your browser.");
    expect(output.join("")).toContain("✓ Product protection evidence updated");
    expect(output.join("")).not.toContain(pollSecret);
    expect(output.join("")).not.toContain(credential);
  });

  it("rejects a server-supplied unsafe approval URL and cancels the session", async () => {
    const pollSecret = "poll-secret-canary-not-for-output-1234567890";
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path.endsWith("/connect"))
          return Response.json({
            sessionId: "11111111-1111-4111-8111-111111111111",
            userCode: "ABCDE-12345",
            pollSecret,
            verificationUrl: "javascript:alert(1)",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            intervalSeconds: 3,
          });
        if (path.endsWith("/cancel")) return Response.json({ cancelled: true });
        throw new Error("unexpected_request");
      }),
    );
    expect(
      await main(["connect", "--server", "http://127.0.0.1:3000", "--root", fixture], {
        interactive: true,
        ci: false,
        configDirectory: await configDirectory(),
        openBrowser: async () => {
          throw new Error("unsafe_url_opened");
        },
      }),
    ).toBe(4);
    expect(paths).toEqual(["/api/cli/v1/connect", "/api/cli/v1/connect/cancel"]);
  });

  it("treats explicit decline as cancellation and never submits", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        paths.push(path);
        if (path.endsWith("/connect"))
          return Response.json({
            sessionId: "11111111-1111-4111-8111-111111111111",
            userCode: "ABCDE-12345",
            pollSecret: "poll-secret-canary-not-for-output-1234567890",
            verificationUrl: "http://127.0.0.1:3000/app/cli/connect?code=ABCDE-12345",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            intervalSeconds: 3,
          });
        if (path.endsWith("/poll"))
          return Response.json({ status: "approved", credential: "a".repeat(48) });
        if (path.endsWith("/cancel")) return Response.json({ cancelled: true });
        throw new Error("unexpected_request");
      }),
    );
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    expect(
      await main(["connect", "--server", "http://127.0.0.1:3000", "--root", fixture], {
        interactive: true,
        ci: false,
        configDirectory: await configDirectory(),
        openBrowser: async () => false,
        confirm: async () => false,
      }),
    ).toBe(3);
    expect(paths).toEqual([
      "/api/cli/v1/connect",
      "/api/cli/v1/connect/poll",
      "/api/cli/v1/connect/cancel",
    ]);
    expect(paths).not.toContain("/api/cli/v1/discovery");
    expect(output.join("")).toContain("Submission declined");
  });
});
