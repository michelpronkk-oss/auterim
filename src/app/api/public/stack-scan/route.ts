import { z } from "zod";
import { discoverWebsiteDependencies, normalizePublicWebsiteUrl } from "@/lib/discovery/discovery";
import { consumePublicRateLimit, publicClientKey } from "@/lib/public/rate-limit";
import { publicStackScanResult } from "@/lib/public/stack-scan";
import { SafeFetchError } from "@/lib/monitoring/fetcher";

const inputSchema = z.object({ websiteUrl: z.string().trim().min(1).max(2048) }).strict();

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
  try {
    const declaredLength = Number(request.headers.get("content-length") ?? 0);
    if (declaredLength > 4096)
      return Response.json({ error: "request_too_large" }, { status: 413 });
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 4096)
      return Response.json({ error: "request_too_large" }, { status: 413 });
    const { websiteUrl } = inputSchema.parse(JSON.parse(body));
    const normalizedUrl = normalizePublicWebsiteUrl(websiteUrl);
    const result = await discoverWebsiteDependencies(normalizedUrl, { deep: false });
    return Response.json(publicStackScanResult(result), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
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
  }
}
