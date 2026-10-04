import { z } from "zod";
import { discoverWebsiteDependencies, normalizePublicWebsiteUrl } from "@/lib/discovery/discovery";
import { consumePublicRateLimit, publicClientKey } from "@/lib/public/rate-limit";
import { publicStackScanResult } from "@/lib/public/stack-scan";
import { SafeFetchError } from "@/lib/monitoring/fetcher";

const inputSchema = z.object({ websiteUrl: z.string().trim().min(1).max(2048) }).strict();
const MAX_REQUEST_BYTES = 4096;
const MAX_CONCURRENT_SCANS_PER_INSTANCE = 2;
let activeScans = 0;

class RequestBodyTooLargeError extends Error {}

async function readRequestBodyBounded(request: Request) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size,
  ).toString("utf8");
}

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rate = consumePublicRateLimit(publicClientKey(request));
  if (!rate.allowed) {
    return Response.json(
      { error: "rate_limited", message: "Please wait before running another scan." },
      {
        status: 429,
        headers: { "Retry-After": String(rate.retryAfterSeconds), "Cache-Control": "no-store" },
      },
    );
  }
  let acquiredScanSlot = false;
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > MAX_REQUEST_BYTES)
      return Response.json({ error: "request_too_large" }, { status: 413 });
    const body = await readRequestBodyBounded(request);
    const { websiteUrl } = inputSchema.parse(JSON.parse(body));
    const normalizedUrl = normalizePublicWebsiteUrl(websiteUrl);
    if (activeScans >= MAX_CONCURRENT_SCANS_PER_INSTANCE) {
      return Response.json(
        { error: "scan_capacity_reached", message: "Please retry shortly." },
        {
          status: 429,
          headers: { "Retry-After": "5", "Cache-Control": "no-store" },
        },
      );
    }
    activeScans += 1;
    acquiredScanSlot = true;
    const result = await discoverWebsiteDependencies(normalizedUrl, { deep: false });
    return Response.json(publicStackScanResult(result), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json({ error: "request_too_large" }, { status: 413 });
    if (error instanceof z.ZodError)
      return Response.json({ error: "invalid_website_url" }, { status: 400 });
    if (error instanceof SyntaxError)
      return Response.json({ error: "invalid_request_body" }, { status: 400 });
    if (error instanceof SafeFetchError && error.category === "invalid_url")
      return Response.json(
        { error: "invalid_website_url", message: "Enter a valid company website." },
        { status: 400 },
      );
    return Response.json(
      { error: "scan_unavailable", message: "This public website could not be scanned safely." },
      { status: 422, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    if (acquiredScanSlot) activeScans = Math.max(0, activeScans - 1);
  }
}
