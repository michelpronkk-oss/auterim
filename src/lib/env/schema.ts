import { z } from "zod";

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value;
const optionalSecret = z.preprocess(emptyToUndefined, z.string().trim().min(1).optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().trim().url().optional());
const resendFromAddress = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .refine((value) => {
      if (z.email().safeParse(value).success) return true;
      const displayAddress = /^([^<>\r\n]{1,100})\s+<([^<>\s]+)>$/.exec(value);
      return Boolean(displayAddress?.[1]?.trim() && z.email().safeParse(displayAddress[2]).success);
    }, "Expected an email address or display name with an email address.")
    .optional(),
);

export const environmentSchema = z
  .object({
    NEXT_PUBLIC_SUPABASE_URL: optionalUrl,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optionalSecret,
    SUPABASE_SECRET_KEY: optionalSecret,
    SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
    TRIGGER_SECRET_KEY: optionalSecret,
    RESEND_API_KEY: optionalSecret,
    RESEND_FROM_EMAIL: resendFromAddress,
    AUTERIM_NOTIFICATION_EMAIL_LIVE: z.preprocess(
      emptyToUndefined,
      z.enum(["0", "1"]).default("0"),
    ),
    DODO_PAYMENTS_API_KEY: optionalSecret,
    DODO_PAYMENTS_WEBHOOK_KEY: optionalSecret,
    DODO_PAYMENTS_ENVIRONMENT: z.preprocess(
      emptyToUndefined,
      z.enum(["test_mode", "live_mode"]).default("test_mode"),
    ),
    DODO_PRODUCT_CORE_MONTHLY: optionalSecret,
    DODO_PRODUCT_PRO_MONTHLY: optionalSecret,
    DODO_PRODUCT_BUSINESS_MONTHLY: optionalSecret,
    GITHUB_APP_ID: z.preprocess(emptyToUndefined, z.string().trim().regex(/^\d+$/).optional()),
    GITHUB_APP_SLUG: z.preprocess(
      emptyToUndefined,
      z
        .string()
        .trim()
        .regex(/^[a-z0-9-]+$/)
        .optional(),
    ),
    GITHUB_APP_CLIENT_ID: optionalSecret,
    GITHUB_APP_CLIENT_SECRET: optionalSecret,
    GITHUB_APP_PRIVATE_KEY: optionalSecret,
    GITHUB_APP_WEBHOOK_SECRET: optionalSecret,
    SLACK_CLIENT_ID: optionalSecret,
    SLACK_CLIENT_SECRET: optionalSecret,
    SLACK_REDIRECT_URI: optionalUrl,
    LINEAR_CLIENT_ID: optionalSecret,
    LINEAR_CLIENT_SECRET: optionalSecret,
    LINEAR_REDIRECT_URI: optionalUrl,
    SENTRY_CLIENT_ID: optionalSecret,
    SENTRY_CLIENT_SECRET: optionalSecret,
    SENTRY_REDIRECT_URI: optionalUrl,
    GOOGLE_SEARCH_CONSOLE_CLIENT_ID: optionalSecret,
    GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET: optionalSecret,
    GOOGLE_SEARCH_CONSOLE_REDIRECT_URI: optionalUrl,
    GOOGLE_SEARCH_CONSOLE_PROPERTY: z.preprocess(
      emptyToUndefined,
      z.literal("sc-domain:auterim.com").optional(),
    ),
    AUTERIM_GROWTH_ADMIN_EMAILS: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS: optionalSecret,
    CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    AUTERIM_PREFLIGHT_LIVE: z.preprocess(emptyToUndefined, z.enum(["0", "1"]).default("0")),
    AUTERIM_DISCOVERY_RUNTIME_ENABLED: z.preprocess(
      emptyToUndefined,
      z.enum(["0", "1"]).default("0"),
    ),
    AUTERIM_PREFLIGHT_FIXTURE_OWNER: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY: z.preprocess(
      emptyToUndefined,
      z.string().trim().optional(),
    ),
    AUTERIM_PREFLIGHT_FIXTURE_INSTALLATION_ID: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY_ID: z.preprocess(
      emptyToUndefined,
      z.coerce.number().int().positive().optional(),
    ),
    AUTERIM_PREFLIGHT_FIXTURE_BRANCH: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    AUTERIM_PREFLIGHT_FIXTURE_ENTITY: z.preprocess(emptyToUndefined, z.string().trim().optional()),
    OPENAI_API_KEY: optionalSecret,
    AUTERIM_CLASSIFIER_PROVIDER: z.preprocess(
      emptyToUndefined,
      z.enum(["openai"]).default("openai"),
    ),
    AUTERIM_CLASSIFIER_MODEL: z.preprocess(
      emptyToUndefined,
      z.string().trim().min(1).max(160).optional(),
    ),
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

    const encryptionConfigured = Boolean(
      environment.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS &&
      environment.CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION,
    );
    if (
      (environment.SLACK_CLIENT_ID ||
        environment.LINEAR_CLIENT_ID ||
        environment.SENTRY_CLIENT_ID) &&
      !encryptionConfigured
    ) {
      context.addIssue({
        code: "custom",
        message: "Connector OAuth requires versioned connector credential encryption keys.",
        path: ["CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS"],
      });
    }

    if (
      environment.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS &&
      environment.CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION
    ) {
      let keys: Record<string, unknown> = {};
      try {
        keys = JSON.parse(environment.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS) as Record<
          string,
          unknown
        >;
      } catch {
        context.addIssue({
          code: "custom",
          message: "Connector encryption keys must be a JSON object keyed by version.",
          path: ["CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS"],
        });
      }
      const active = keys[String(environment.CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION)];
      const decoded = typeof active === "string" ? Buffer.from(active, "base64") : Buffer.alloc(0);
      if (decoded.length !== 32 || decoded.toString("base64") !== active) {
        context.addIssue({
          code: "custom",
          message: "The active connector encryption key must be a base64-encoded 32-byte key.",
          path: ["CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS"],
        });
      }
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

export function parseEnvironment(source: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  return environmentSchema.parse(source);
}

export function getEnvironment() {
  return parseEnvironment(process.env);
}

export function getSupabasePublicConfig(environment?: AppEnvironment) {
  // Next.js only inlines direct NEXT_PUBLIC_* references into client bundles.
  // Keep server validation centralized while ensuring browser code receives the public config.
  const source =
    environment ??
    (typeof window === "undefined"
      ? getEnvironment()
      : {
          NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        });
  const url = source.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = source.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !publishableKey) {
    throw new Error(
      "Supabase is not configured. Add the dedicated Auterim URL and publishable key to .env.local.",
    );
  }

  return { url, publishableKey };
}

export function isIntegrationConfigured(
  name:
    | "supabase"
    | "trigger"
    | "resend"
    | "classifier"
    | "githubApp"
    | "slackApp"
    | "linearApp"
    | "sentryApp"
    | "searchConsole"
    | "connectorEncryption"
    | "dodo",
  environment: AppEnvironment,
) {
  if (name === "supabase") {
    return Boolean(
      environment.NEXT_PUBLIC_SUPABASE_URL && environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    );
  }

  if (name === "classifier") {
    return Boolean(
      environment.AUTERIM_CLASSIFIER_PROVIDER === "openai" &&
      environment.OPENAI_API_KEY &&
      environment.AUTERIM_CLASSIFIER_MODEL,
    );
  }

  if (name === "githubApp") {
    return Boolean(
      environment.GITHUB_APP_ID &&
      environment.GITHUB_APP_SLUG &&
      environment.GITHUB_APP_CLIENT_ID &&
      environment.GITHUB_APP_CLIENT_SECRET &&
      environment.GITHUB_APP_PRIVATE_KEY &&
      environment.GITHUB_APP_WEBHOOK_SECRET,
    );
  }

  if (name === "slackApp")
    return Boolean(
      environment.SLACK_CLIENT_ID &&
      environment.SLACK_CLIENT_SECRET &&
      environment.SLACK_REDIRECT_URI,
    );
  if (name === "linearApp")
    return Boolean(
      environment.LINEAR_CLIENT_ID &&
      environment.LINEAR_CLIENT_SECRET &&
      environment.LINEAR_REDIRECT_URI,
    );
  if (name === "sentryApp")
    return Boolean(
      environment.SENTRY_CLIENT_ID &&
      environment.SENTRY_CLIENT_SECRET &&
      environment.SENTRY_REDIRECT_URI,
    );
  if (name === "searchConsole")
    return Boolean(
      environment.GOOGLE_SEARCH_CONSOLE_CLIENT_ID &&
      environment.GOOGLE_SEARCH_CONSOLE_CLIENT_SECRET &&
      environment.GOOGLE_SEARCH_CONSOLE_REDIRECT_URI &&
      environment.GOOGLE_SEARCH_CONSOLE_PROPERTY === "sc-domain:auterim.com" &&
      environment.AUTERIM_GROWTH_ADMIN_EMAILS &&
      environment.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS &&
      environment.CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION,
    );
  if (name === "connectorEncryption")
    return Boolean(
      environment.CONNECTOR_CREDENTIAL_ENCRYPTION_KEYS &&
      environment.CONNECTOR_CREDENTIAL_ACTIVE_KEY_VERSION,
    );

  if (name === "dodo") {
    return Boolean(
      environment.DODO_PAYMENTS_API_KEY &&
      environment.DODO_PAYMENTS_WEBHOOK_KEY &&
      environment.DODO_PRODUCT_CORE_MONTHLY &&
      environment.DODO_PRODUCT_PRO_MONTHLY &&
      environment.DODO_PRODUCT_BUSINESS_MONTHLY,
    );
  }

  return name === "trigger"
    ? Boolean(environment.TRIGGER_SECRET_KEY)
    : Boolean(
        environment.RESEND_API_KEY &&
        environment.RESEND_FROM_EMAIL &&
        environment.AUTERIM_NOTIFICATION_EMAIL_LIVE === "1",
      );
}
