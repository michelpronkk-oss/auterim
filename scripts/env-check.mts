import { readFileSync } from "node:fs";
import { isIntegrationConfigured, parseEnvironment } from "../src/lib/env/schema.ts";

function readLocalEnvironmentFile() {
  let contents: string;
  try {
    contents = readFileSync(".env.local", "utf8");
  } catch {
    return {};
  }

  return Object.fromEntries(
    contents.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return [];
      const separator = trimmed.indexOf("=");
      if (separator < 1) return [];
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, "$2");
      return [[key, value]];
    }),
  );
}

function redactSupabaseUrl(value: string) {
  const parsed = new URL(value);
  const projectRef = parsed.hostname.endsWith(".supabase.co")
    ? parsed.hostname.slice(0, -".supabase.co".length)
    : undefined;
  const hostname = projectRef
    ? `${projectRef.slice(0, 4)}…${parsed.hostname.slice(projectRef.length)}`
    : parsed.hostname;

  return { hostname, projectRef: projectRef ? `${projectRef.slice(0, 4)}…` : "custom domain" };
}

try {
  // Deliberately inspect only this project's .env.local, never inherited machine variables.
  const environment = parseEnvironment(readLocalEnvironmentFile());
  const supabaseConfigured = isIntegrationConfigured("supabase", environment);
  const classifierConfigured = isIntegrationConfigured("classifier", environment);
  const githubAppConfigured = isIntegrationConfigured("githubApp", environment);
  const slackConfigured = isIntegrationConfigured("slackApp", environment);
  const linearConfigured = isIntegrationConfigured("linearApp", environment);
  const sentryConfigured = isIntegrationConfigured("sentryApp", environment);
  const searchConsoleConfigured = isIntegrationConfigured("searchConsole", environment);
  const connectorEncryptionConfigured = isIntegrationConfigured("connectorEncryption", environment);
  const dodoConfigured = isIntegrationConfigured("dodo", environment);
  const preflightFixtureConfigured =
    environment.AUTERIM_PREFLIGHT_LIVE === "1" &&
    githubAppConfigured &&
    environment.AUTERIM_PREFLIGHT_FIXTURE_OWNER === "michelpronkk-oss" &&
    Boolean(
      environment.AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY?.startsWith("auterim-preflight-fixture"),
    ) &&
    Boolean(
      environment.AUTERIM_PREFLIGHT_FIXTURE_INSTALLATION_ID &&
      environment.AUTERIM_PREFLIGHT_FIXTURE_REPOSITORY_ID &&
      environment.AUTERIM_PREFLIGHT_FIXTURE_BRANCH &&
      environment.AUTERIM_PREFLIGHT_FIXTURE_ENTITY,
    );

  console.log("Auterim environment check");
  console.log(
    `Supabase: ${supabaseConfigured ? "configured" : "NOT configured (expected during foundation setup)"}`,
  );
  console.log(
    `Public distributed rate limiting: ${environment.PUBLIC_RATE_LIMIT_HMAC_SECRET ? "configured" : "not configured"}`,
  );
  if (supabaseConfigured && environment.NEXT_PUBLIC_SUPABASE_URL) {
    const redacted = redactSupabaseUrl(environment.NEXT_PUBLIC_SUPABASE_URL);
    console.log(`  URL host: ${redacted.hostname}`);
    console.log(`  Project ref: ${redacted.projectRef}`);
  }
  console.log(
    `Trigger.dev: ${isIntegrationConfigured("trigger", environment) ? "configured" : "not configured"}`,
  );
  console.log(
    `Resend: ${isIntegrationConfigured("resend", environment) ? "configured" : "not configured"}`,
  );
  console.log(`Dodo Payments: ${dodoConfigured ? "configured" : "not configured"}`);
  console.log(`  Environment: ${environment.DODO_PAYMENTS_ENVIRONMENT}`);
  console.log(`OpenAI classification: ${classifierConfigured ? "configured" : "not configured"}`);
  console.log(`  Provider: ${environment.AUTERIM_CLASSIFIER_PROVIDER}`);
  console.log(`  Model: ${environment.AUTERIM_CLASSIFIER_MODEL ?? "not set"}`);
  console.log(`GitHub App: ${githubAppConfigured ? "configured" : "not configured"}`);
  console.log(
    "  Required server-side settings: App ID, slug, OAuth client ID/secret, private key, webhook secret",
  );
  console.log(
    `Slack connector: ${slackConfigured && connectorEncryptionConfigured ? "configured" : "not configured"}`,
  );
  console.log(
    `Linear connector: ${linearConfigured && connectorEncryptionConfigured ? "configured" : "not configured"}`,
  );
  console.log(
    `Sentry connector: ${sentryConfigured && connectorEncryptionConfigured ? "configured" : "not configured"}`,
  );
  console.log(
    `Google Search Console growth integration: ${searchConsoleConfigured ? "configured" : "not configured"}`,
  );
  console.log(
    `Connector credential encryption: ${connectorEncryptionConfigured ? "configured" : "not configured"}`,
  );
  console.log(
    `Preflight live fixture: ${preflightFixtureConfigured ? "enabled and scoped to the Auterim fixture allowlist" : "not configured"}`,
  );
  console.log(
    `Discovery browser runtime: ${environment.AUTERIM_DISCOVERY_RUNTIME_ENABLED === "1" ? "enabled" : "disabled"}`,
  );
  console.log("No secrets were printed. No project discovery or network calls were made.");
} catch (error) {
  console.error("Environment validation failed:");
  if (error instanceof Error && "issues" in error && Array.isArray(error.issues)) {
    for (const issue of error.issues)
      console.error(`- ${issue.path.join(".") || "environment"}: ${issue.message}`);
  } else {
    console.error(error instanceof Error ? error.message : "Unknown validation error");
  }
  process.exitCode = 1;
}
