import { describe, expect, it } from "vitest";
import {
  clearConnectorCallbackCookie,
  connectorRedirectResponse,
  vercelIntegrationNextUrl,
} from "@/lib/connectors/callback-response";

describe("connector callback responses", () => {
  it("adds the callback-clearing cookie to a redirect response without mutating immutable headers", () => {
    const original = Response.redirect("https://auterim.com/app", 303);
    expect(() => original.headers.append("set-cookie", "broken=true")).toThrow(/immutable/i);

    const response = clearConnectorCallbackCookie(original, "vercel", true);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://auterim.com/app");
    expect(response.headers.get("set-cookie")).toContain(
      "auterim_connector_vercel=; Path=/api/connectors/vercel/callback; HttpOnly; SameSite=Lax; Max-Age=0; Secure",
    );
  });

  it("creates a mutable redirect response with a preserved location", () => {
    const response = connectorRedirectResponse(
      "https://vercel.com/dashboard/auterim/integrations/icfg_auterim",
    );
    response.headers.append("set-cookie", "callback=cleared");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://vercel.com/dashboard/auterim/integrations/icfg_auterim",
    );
    expect(response.headers.get("set-cookie")).toBe("callback=cleared");
  });

  it("accepts only the matching Vercel dashboard integration configuration URL", () => {
    expect(
      vercelIntegrationNextUrl(
        "https://vercel.com/dashboard/auterim/integrations/icfg_auterim",
        "icfg_auterim",
      )?.toString(),
    ).toBe("https://vercel.com/dashboard/auterim/integrations/icfg_auterim");
  });

  it.each([
    ["invalid host", "https://evil.example/dashboard/auterim/integrations/icfg_auterim"],
    ["HTTP scheme", "http://vercel.com/dashboard/auterim/integrations/icfg_auterim"],
    ["arbitrary Vercel path", "https://vercel.com/account"],
    ["malformed configuration path", "https://vercel.com/dashboard/auterim/integrations/"],
    ["different configuration ID", "https://vercel.com/dashboard/auterim/integrations/icfg_other"],
    ["credentials in URL", "https://user@vercel.com/dashboard/auterim/integrations/icfg_auterim"],
    ["query string", "https://vercel.com/dashboard/auterim/integrations/icfg_auterim?next=/"],
  ])("rejects %s", (_name, url) => {
    expect(vercelIntegrationNextUrl(url, "icfg_auterim")).toBeNull();
  });
});
