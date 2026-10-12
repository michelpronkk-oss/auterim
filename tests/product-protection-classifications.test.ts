import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createServerClient: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  inFilter: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: mocks.createServerClient,
}));

import { readProductProtectionClassifications } from "@/lib/protection/product-graph";
import { ProductProtectionReadError } from "@/lib/protection/read-stage";

describe("product protection classification reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerClient.mockReturnValue({ from: mocks.from });
    mocks.from.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ in: mocks.inFilter });
    mocks.inFilter.mockResolvedValue({
      data: [
        { id: "classification-1", material: true, status: "classified", change_id: "change-1" },
      ],
      error: null,
    });
  });

  it("reads only requested classification IDs through the server-only client", async () => {
    const ids = ["classification-1", "classification-2"];

    await expect(readProductProtectionClassifications(ids)).resolves.toEqual([
      { id: "classification-1", material: true, status: "classified", change_id: "change-1" },
    ]);

    expect(mocks.createServerClient).toHaveBeenCalledOnce();
    expect(mocks.from).toHaveBeenCalledExactlyOnceWith("source_change_classifications");
    expect(mocks.select).toHaveBeenCalledExactlyOnceWith("id,material,status,change_id");
    expect(mocks.inFilter).toHaveBeenCalledExactlyOnceWith("id", ids);
  });

  it("does not create a privileged client when there are no referenced classifications", async () => {
    await expect(readProductProtectionClassifications([])).resolves.toEqual([]);
    expect(mocks.createServerClient).not.toHaveBeenCalled();
  });

  it("normalizes privileged read failures to the fixed classifications stage", async () => {
    mocks.inFilter.mockResolvedValue({
      data: null,
      error: new Error("sensitive provider details"),
    });

    await expect(readProductProtectionClassifications(["classification-1"])).rejects.toEqual(
      new ProductProtectionReadError("classifications"),
    );
  });
});
