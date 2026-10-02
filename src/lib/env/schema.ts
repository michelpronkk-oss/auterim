import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalSecret = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().trim().url().optional());

export const environmentSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalSecret,
    SUPABASE_SECRET_KEY: optionalSecret,
    SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
    TRIGGER_SECRET_KEY: optionalSecret,
    RESEND_API_KEY: optionalSecret,
    NEXT_PUBLIC_APP_URL: z.preprocess(
      emptyToUndefined,
      z.string().trim().url().default("http://localhost:3000"),
    ),
  })
  .superRefine((environment, context) => {
    const hasUrl = Boolean(environment.NEXT_PUBLIC_SUPABASE_URL);
    const hasPublishableKey = Boolean(environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

    if (hasUrl !== hasPublishableKey) {
      context.addIssue({
        code: "custom",
        message: "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY together.",
        path: [hasUrl ? "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" : "NEXT_PUBLIC_SUPABASE_URL"],
      });
    }

    if ((environment.SUPABASE_SECRET_KEY || environment.SUPABASE_SERVICE_ROLE_KEY) && !hasUrl) {
      context.addIssue({
        code: "custom",
        message: "A Supabase server secret requires the matching NEXT_PUBLIC_SUPABASE_URL.",
        path: ["SUPABASE_SECRET_KEY"],
      });
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function parseEnvironment(source: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  return environmentSchema.parse(source);
}

export function getEnvironment() {
  return parseEnvironment(process.env);
}

export function getSupabasePublicConfig(environment: AppEnvironment = getEnvironment()) {
  const url = environment.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Supabase is not configured. Add the dedicated Auterim URL and publishable key to .env.local.",
    );
  }

  return { url, publishableKey };
}

export function isIntegrationConfigured(
  name: "supabase" | "trigger" | "resend",
  environment: AppEnvironment,
) {
  if (name === "supabase") {
    return Boolean(
      environment.NEXT_PUBLIC_SUPABASE_URL && environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
  }

  return name === "trigger"
    ? Boolean(environment.TRIGGER_SECRET_KEY)
    : Boolean(environment.RESEND_API_KEY);
}
