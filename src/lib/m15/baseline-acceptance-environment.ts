import "server-only";
import { z } from "zod";

const baselineAcceptanceEnvironmentSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().trim().url(),
    SUPABASE_SECRET_KEY: z.string().trim().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().trim().min(1).optional(),
    GITHUB_APP_ID: z.string().trim().regex(/^\d+$/),
    GITHUB_APP_PRIVATE_KEY: z.string().trim().min(1),
  })
  .superRefine((environment, context) => {
    if (!environment.SUPABASE_SECRET_KEY && !environment.SUPABASE_SERVICE_ROLE_KEY) {
      context.addIssue({
        code: "custom",
        message: "A server-only Supabase credential is required.",
        path: ["SUPABASE_SECRET_KEY"],
      });
    }

    let projectRef = "";
    try {
      const url = new URL(environment.NEXT_PUBLIC_SUPABASE_URL);
      if (url.protocol === "https:" && url.hostname.endsWith(".supabase.co")) {
        projectRef = url.hostname.slice(0, -".supabase.co".length);
      }
    } catch {
      // The URL schema reports malformed URLs without exposing the input value.
    }
    if (projectRef !== "lnljaacbptrubppoypaz") {
      context.addIssue({
        code: "custom",
        message: "Baseline acceptance is restricted to the authorized Auterim Supabase project.",
        path: ["NEXT_PUBLIC_SUPABASE_URL"],
      });
    }
  });

export type BaselineAcceptanceEnvironment = z.infer<typeof baselineAcceptanceEnvironmentSchema>;

export function parseBaselineAcceptanceEnvironment(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): BaselineAcceptanceEnvironment {
  return baselineAcceptanceEnvironmentSchema.parse(source);
}

export function getBaselineAcceptanceEnvironment() {
  return parseBaselineAcceptanceEnvironment(process.env);
}
