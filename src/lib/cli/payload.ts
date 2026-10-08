import { createHash } from "node:crypto";
import { z } from "zod";

const families = [
  "package_manifest",
  "environment_variable_name",
  "import_reference",
  "provider_host",
  "model_identifier",
  "configuration_file",
  "framework_runtime",
  "lockfile_identity",
  "git_remote",
] as const;
const reasons = [
  "known_package_provider",
  "unmapped_package",
  "framework_package",
  "environment_name",
  "known_environment_provider",
  "imported_provider_package",
  "provider_host_reference",
  "model_reference",
  "configuration_identity",
  "lockfile_identity",
  "sanitized_git_origin",
] as const;
const slugs = /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/;
const safeIdentifier = /^[A-Za-z0-9@_./:-]{1,180}$/;
const safeRelativePath = /^[A-Za-z0-9_./@ -]{1,240}$/;
const safeRelativePathSchema = z
  .string()
  .regex(safeRelativePath)
  .refine(
    (value) =>
      !value.startsWith("/") && !value.split("/").some((part) => part === "." || part === ".."),
  );

const metadataSchema = z
  .object({
    ecosystem: z.enum(["npm", "python", "go", "cargo", "composer", "unknown"]).optional(),
    manifestKind: z
      .enum([
        "package.json",
        "requirements.txt",
        "pyproject.toml",
        "go.mod",
        "Cargo.toml",
        "composer.json",
      ])
      .optional(),
    dependencyScope: z
      .enum(["production", "optional", "development", "build", "unknown"])
      .optional(),
    declaredVersion: z
      .string()
      .regex(/^[0-9a-zA-Z*^~<>=|.,+ _-]{1,80}$/)
      .optional(),
    runtimeName: z.enum(["node", "python", "go", "rust", "php", "ruby", "unknown"]).optional(),
    configKind: z
      .enum([
        "next",
        "vite",
        "nuxt",
        "svelte",
        "astro",
        "vercel",
        "sentry",
        "cloudflare",
        "docker",
        "runtime",
        "other",
      ])
      .optional(),
    modelFamily: z.enum(["openai", "anthropic", "gemini", "cohere", "mistral"]).optional(),
    gitHost: z.enum(["github.com", "gitlab.com", "bitbucket.org", "other"]).optional(),
    gitOwner: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,180}$/)
      .optional(),
    gitRepository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,180}$/)
      .optional(),
    gitBranch: z
      .string()
      .regex(/^[A-Za-z0-9_.\/-]{1,180}$/)
      .optional(),
    gitCommit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/i)
      .optional(),
  })
  .strict();

const observationSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{32}$/),
    evidenceFamily: z.enum(families),
    normalizedIdentifier: z.string().regex(safeIdentifier),
    providerCandidate: z.discriminatedUnion("status", [
      z
        .object({
          status: z.literal("known"),
          providerSlug: z.string().regex(slugs).max(80),
          providerName: z.string().regex(/^[A-Za-z0-9 .&'()-]{1,100}$/),
        })
        .strict(),
      z
        .object({ status: z.literal("unknown"), providerSlug: z.null(), providerName: z.null() })
        .strict(),
    ]),
    confidence: z.number().finite().min(0).max(1),
    reasonCode: z.enum(reasons),
    safeRelativePath: safeRelativePathSchema.max(240).nullable(),
    subproject: safeRelativePathSchema.max(180).nullable(),
    metadata: metadataSchema,
  })
  .strict();

const payloadSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    scannerVersion: z.literal("0.1.0"),
    registryVersion: z.literal("m15.6-provider-map-1"),
    scanId: z.string().uuid(),
    projectFingerprint: z.null(),
    status: z.enum(["complete", "partial"]),
    projectSummary: z
      .object({
        rootName: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
        git: z
          .object({
            host: z.enum(["github.com", "gitlab.com", "bitbucket.org", "other"]).nullable(),
            owner: z
              .string()
              .regex(/^[A-Za-z0-9_.-]{1,120}$/)
              .nullable(),
            repository: z
              .string()
              .regex(/^[A-Za-z0-9_.-]{1,120}$/)
              .nullable(),
            branch: z
              .string()
              .regex(/^[A-Za-z0-9_.\/-]{1,180}$/)
              .nullable(),
            commit: z
              .string()
              .regex(/^[a-f0-9]{40,64}$/i)
              .nullable(),
          })
          .strict(),
      })
      .strict(),
    stats: z
      .object({
        filesVisited: z.number().int().min(0).max(4000),
        directoriesVisited: z.number().int().min(0).max(600),
        manifestsParsed: z.number().int().min(0).max(4000),
        sourceFilesInspected: z.number().int().min(0).max(600),
        observations: z.number().int().min(0).max(1500),
        symlinksSkipped: z.number().int().min(0).max(4000),
        ignoredDirectories: z.number().int().min(0).max(4000),
        ignoredSensitiveFiles: z.number().int().min(0).max(4000),
        ignoredSensitiveDirectories: z.number().int().min(0).max(4000),
        totalBytesRead: z
          .number()
          .int()
          .min(0)
          .max(4 * 1024 * 1024),
        truncated: z.boolean(),
        partialReasons: z
          .array(
            z.enum([
              "cancelled",
              "deadline",
              "max_depth",
              "max_directories",
              "max_files",
              "max_total_bytes",
              "max_observations",
              "symlink_skipped",
              "root_unavailable",
              "network_path_not_allowed",
              "malformed_manifest",
              "file_too_large",
              "read_error",
            ]),
          )
          .max(20),
        durationMs: z.number().int().min(0).max(60_000),
      })
      .strict(),
    observations: z.array(observationSchema).max(1500),
  })
  .strict();

const secretCanaryPattern =
  /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|AUTERIM_FAKE_(?:SECRET|PRIVATE_KEY|GIT_TOKEN)_DO_NOT_LEAK_|\bsk-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{12,}\b|(?:password|secret|token)=\S+)/i;

export function parseCliDiscoveryPayload(value: unknown) {
  const parsed = payloadSchema.parse(value);
  if (parsed.stats.observations !== parsed.observations.length)
    throw new Error("invalid_cli_payload");
  if (
    parsed.status === "complete" &&
    (parsed.stats.truncated || parsed.stats.partialReasons.length)
  )
    throw new Error("invalid_cli_payload");
  if (
    parsed.status === "partial" &&
    !parsed.stats.truncated &&
    parsed.stats.partialReasons.length === 0
  )
    throw new Error("invalid_cli_payload");
  const strings: string[] = [];
  const visit = (item: unknown) => {
    if (typeof item === "string") strings.push(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(parsed);
  if (strings.some((item) => secretCanaryPattern.test(item))) throw new Error("unsafe_cli_payload");
  return parsed;
}

export function payloadDigest(raw: string) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
