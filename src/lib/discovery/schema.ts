import { z } from "zod";

export const discoveryWebsiteUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        (url.port === "" || url.port === "80" || url.port === "443")
      );
    } catch {
      return false;
    }
  }, "Website URL must use public HTTP(S) on a standard port without credentials.");

export const discoverWebsiteDependenciesPayloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    companyId: z.string().uuid(),
    websiteUrl: discoveryWebsiteUrlSchema,
    deep: z.boolean().default(false),
  })
  .strict();
