import type { MetadataRoute } from "next";
import { getPublicSiteOrigin } from "@/lib/public/intelligence";

export default function robots(): MetadataRoute.Robots {
  const origin = getPublicSiteOrigin();
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/", "/changes", "/tools", "/pricing"],
        disallow: [
          "/app",
          "/api/",
          "/auth/",
          "/login",
          "/signup",
          "/forgot-password",
          "/reset-password",
        ],
      },
    ],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
