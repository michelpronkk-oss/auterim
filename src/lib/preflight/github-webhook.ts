import { createHmac, timingSafeEqual } from "node:crypto";

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel("payload_too_large");
        throw new Error("payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  );
}

export function verifyGitHubWebhookSignature(
  rawBody: Uint8Array,
  suppliedSignature: string,
  secret: string,
) {
  if (!/^sha256=[a-f0-9]{64}$/i.test(suppliedSignature)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const supplied = Buffer.from(suppliedSignature);
  const actual = Buffer.from(expected);
  return supplied.length === actual.length && timingSafeEqual(supplied, actual);
}
