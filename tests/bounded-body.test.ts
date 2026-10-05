import { describe, expect, it } from "vitest";
import { readBoundedTextBody } from "@/lib/http/bounded-body";

describe("bounded HTTP body reader", () => {
  it("reads UTF-8 across chunk boundaries within the byte limit", async () => {
    const bytes = new TextEncoder().encode("hello 🌍");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 7));
        controller.enqueue(bytes.subarray(7));
        controller.close();
      },
    });
    await expect(readBoundedTextBody(body, bytes.byteLength)).resolves.toBe("hello 🌍");
  });

  it("cancels as soon as the streaming byte limit is exceeded", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5));
      },
      cancel() {
        canceled = true;
      },
    });
    await expect(readBoundedTextBody(body, 4)).rejects.toThrow("payload_too_large");
    expect(canceled).toBe(true);
  });
});
