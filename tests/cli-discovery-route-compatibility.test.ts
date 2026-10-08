import { beforeEach, describe, expect, it, vi } from "vitest";

const { createSupabaseServerClient } = vi.hoisted(() => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/public/rate-limit", () => ({
  claimPublicRateLimit: vi.fn(async () => ({ status: "allowed" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient }));

import { POST } from "@/app/api/cli/v1/discovery/route";

describe("CLI discovery route compatibility response", () => {
  beforeEach(() => {
    createSupabaseServerClient.mockReset();
  });

  it("returns a safe 426 for a valid credential with an unsupported payload schema", async () => {
    const response = await POST(
      new Request("http://127.0.0.1:3000/api/cli/v1/discovery", {
        method: "POST",
        headers: { authorization: `Bearer acli_${"a".repeat(43)}` },
        body: JSON.stringify({ schemaVersion: "2.0.0" }),
      }),
    );
    expect(response.status).toBe(426);
    expect(await response.json()).toEqual({
      error: "unsupported_cli_version",
      supportedSchemaVersion: "1.0.0",
    });
    expect(createSupabaseServerClient).not.toHaveBeenCalled();
  });
});
