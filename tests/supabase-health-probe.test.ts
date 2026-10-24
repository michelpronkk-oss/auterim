import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { probeSupabase } from "../scripts/supabase-health-probe.mjs";

const url = "https://lnljaacbptrubppoypaz.supabase.co";
const resolves = async () => ({ address: "172.64.149.246", family: 4 });
const respond = (status: number) => async () => new Response("ok", { status });

describe("external Supabase health probe", () => {
  it("passes only on DNS resolution and HTTP 200 from the auth health endpoint", async () => {
    const calls: string[] = [];
    const result = await probeSupabase({
      url,
      publishableKey: "sb_publishable_test",
      resolve: resolves,
      fetchImpl: async (target) => {
        calls.push(String(target));
        return new Response("ok", { status: 200 });
      },
    });
    expect(result).toEqual({ ok: true, stage: "http", detail: "200" });
    expect(calls).toEqual([`${url}/auth/v1/health`]);
  });

  it("fails closed on a paused project (no DNS), errors, timeouts and missing configuration", async () => {
    const enotfound = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    };
    expect(
      await probeSupabase({
        url,
        publishableKey: "k",
        resolve: enotfound,
        fetchImpl: respond(200),
      }),
    ).toEqual({ ok: false, stage: "dns", detail: "ENOTFOUND" });
    expect(
      await probeSupabase({
        url,
        publishableKey: "k",
        resolve: resolves,
        fetchImpl: async () =>
          new Response('{"message":"Invalid API key","hint":"Double check the provided API key"}', {
            status: 401,
          }),
      }),
    ).toEqual({ ok: false, stage: "http", detail: "401 invalid_api_key" });
    for (const status of [401, 500, 503, 540]) {
      expect(
        await probeSupabase({
          url,
          publishableKey: "k",
          resolve: resolves,
          fetchImpl: respond(status),
        }),
      ).toEqual({ ok: false, stage: "http", detail: String(status) });
    }
    const timeout = async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    };
    expect(
      await probeSupabase({ url, publishableKey: "k", resolve: resolves, fetchImpl: timeout }),
    ).toEqual({ ok: false, stage: "transport", detail: "TimeoutError" });
    expect(await probeSupabase({ url, publishableKey: undefined })).toEqual({
      ok: false,
      stage: "configuration",
      detail: "missing",
    });
    expect(await probeSupabase({ url: "https://example.com", publishableKey: "k" })).toMatchObject({
      ok: false,
      stage: "configuration",
    });
  });

  it("is scheduled, secret-free and fails the step when the probe fails", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/production-health-probe.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("schedule:");
    const executable = workflow
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(executable).not.toContain("secrets.");
    expect(workflow).toMatch(/^defaults:\n {2}run:\n {4}shell: bash$/m);
  });
});
