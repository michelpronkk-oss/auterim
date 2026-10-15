import { describe, expect, it } from "vitest";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getProductProtectionGraph } from "@/lib/protection/product-graph";
import { ProductProtectionReadError } from "@/lib/protection/read-stage";

const enabled = process.env.AUTERIM_M157_GRAPH_DIAGNOSTIC === "1";

describe("M15.7 read-only Product Protection Graph diagnostic", () => {
  it.skipIf(!enabled)("reports only the fixed Product Graph read stage", async () => {
    let stage = "diagnostic_setup";
    try {
      const graph = await getProductProtectionGraph(createSupabaseServerClient(), {
        workspaceId: "e140d48e-9dc0-4552-a9a4-a81fe3872422",
        productId: "de1f2a12-de3c-4644-8892-b6c2d458a300",
        verificationCapabilityAvailable: true,
      });
      stage = graph ? "none" : "product_missing";
    } catch (error) {
      stage = error instanceof ProductProtectionReadError ? error.stage : "unknown";
    }
    console.info(`PRODUCT_GRAPH_READ_STAGE=${stage}`);
    expect(stage).not.toBe("diagnostic_setup");
  });
});
