import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resourceCatalog } from "@trigger.dev/core/v3";
import { StandardResourceCatalog } from "@trigger.dev/core/v3/workers";
import { configure, tasks } from "@trigger.dev/sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// M15.78R: run_06glcb88fo2melb0m37u0ghn01 was stored with the bare queue
// "attest-verification-runner-identity" while the registered default queue is
// "task/attest-verification-runner-identity". Trigger v4.7.2 stores a caller's
// options.queue.name verbatim for unlocked triggers, and dequeue then parks the
// run in PENDING_VERSION (QUEUE_NOT_FOUND). These tests pin the Auterim side.

const TASK_ID = "attest-verification-runner-identity";
const TRIGGER_DIR = join(process.cwd(), "src/trigger");

const catalog = new StandardResourceCatalog();

beforeAll(async () => {
  resourceCatalog.setGlobalResourceCatalog(catalog);
  catalog.setCurrentFileContext("src/trigger/attest-verification-runner-identity.ts", TASK_ID);
  await import("../src/trigger/attest-verification-runner-identity");
  catalog.clearCurrentFileContext();
});

function captureTriggerBody() {
  const fetchMock = vi.fn<(url: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async () => Response.json({ id: "run_local_fixture" }),
  );
  vi.stubGlobal("fetch", fetchMock);
  configure({ accessToken: "tr_dev_local_fixture", baseURL: "http://127.0.0.1:9" });
  return () => {
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`http://127.0.0.1:9/api/v1/tasks/${TASK_ID}/trigger`);
    return JSON.parse(String(init?.body)) as { options?: { queue?: { name: string } } };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("M15.78R attestation task queue resolution", () => {
  it("registers the attestation task without a queue override", () => {
    const manifest = catalog.getTaskManifest(TASK_ID);
    expect(manifest?.id).toBe(TASK_ID);
    expect(manifest?.queue).toBeUndefined();
    expect(catalog.listQueueManifests().map((queue) => queue.name)).not.toContain(TASK_ID);
  });

  it("omits the queue from a default invocation so the server resolves task/<id>", async () => {
    const readBody = captureTriggerBody();
    const handle = await tasks.trigger(TASK_ID, {});
    expect(handle.id).toBe("run_local_fixture");
    expect(readBody().options?.queue).toBeUndefined();
  });

  it("forwards an explicit queue name verbatim, without the task/ prefix", async () => {
    const readBody = captureTriggerBody();
    await tasks.trigger(TASK_ID, {}, { queue: TASK_ID });
    // This is the bare value observed on the parked Production run: the SDK
    // does not normalize it, so a task-ID-as-queue override cannot match the
    // worker's registered "task/<id>" queue.
    expect(readBody().options?.queue).toEqual({ name: TASK_ID });
  });

  it("has no Auterim-owned producer that overrides a trigger queue or targets the attestation task", () => {
    const files = readdirSync(TRIGGER_DIR, { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => join(TRIGGER_DIR, file))
      .concat(
        readdirSync(join(process.cwd(), "src/lib"), { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".ts"))
          .map((file) => join(process.cwd(), "src/lib", file)),
      );
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      // A string queue reference or lockToVersion at trigger time is the only
      // SDK path that can persist a non-default queue name.
      expect(source, file).not.toMatch(/\bqueue:\s*["'`]/);
      expect(source, file).not.toMatch(/\blockToVersion\b/);
      if (!file.endsWith("attest-verification-runner-identity.ts"))
        expect(source, file).not.toContain(`"${TASK_ID}"`);
    }
  });
});
