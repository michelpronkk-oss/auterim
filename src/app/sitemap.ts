import type { MetadataRoute } from "next";
import {
  getApprovedPublicChanges,
  getApprovedPublicProviders,
  getPublicSiteOrigin,
} from "@/lib/public/intelligence";

export const revalidate = 300;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = getPublicSiteOrigin();
  const [changes, providers] = await Promise.all([
    getApprovedPublicChanges(),
    getApprovedPublicProviders(),
  ]);
  const pages: MetadataRoute.Sitemap = [
    { url: origin, changeFrequency: "weekly", priority: 1 },
    { url: `${origin}/changes`, changeFrequency: "hourly", priority: 0.8 },
    { url: `${origin}/tools`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${origin}/tools/dependency-exposure`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${origin}/tools/deprecation-checker`, changeFrequency: "weekly", priority: 0.6 },
    { url: `${origin}/pricing`, changeFrequency: "monthly", priority: 0.6 },
    { url: `${origin}/product`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${origin}/security`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${origin}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${origin}/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${origin}/cookies`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${origin}/subprocessors`, changeFrequency: "yearly", priority: 0.3 },
  ];
  pages.push(
    ...providers.map((provider) => ({
      url: `${origin}/changes/${provider.slug}`,
      lastModified: provider.lastVerifiedAt,
      changeFrequency: "daily" as const,
      priority: 0.6,
    })),
  );
  pages.push(
    ...changes.map((change) => ({
      url: `${origin}/changes/${change.provider.slug}/${change.canonicalSlug}`,
      lastModified: change.lastVerifiedAt,
      changeFrequency: "daily" as const,
      priority: 0.7,
    })),
  );
  return pages;
}
