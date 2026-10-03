import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseEnvironment } from "../src/lib/env/schema.ts";

const root = process.cwd();
const errors: string[] = [];

function readProjectFile(path: string) {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    errors.push(`${path} is missing or unreadable`);
    return "";
  }
}

function parseKeyValues(contents: string) {
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

function readOrigin(config: string) {
  const remoteBlock = config.match(/\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/i)?.[1];
  if (!remoteBlock) return undefined;
  return {
    urls: [...remoteBlock.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gim)].map((match) => match[1]),
    pushUrls: [...remoteBlock.matchAll(/^\s*pushurl\s*=\s*(.+?)\s*$/gim)].map((match) => match[1]),
  };
}

const identity = parseKeyValues(readProjectFile(".project-identity"));
const packageJson = JSON.parse(readProjectFile("package.json")) as { name?: string };
const environmentText = readProjectFile(".env.local");
const localEnvironment = parseKeyValues(environmentText);
const triggerConfig = readProjectFile("trigger.config.ts");
const gitConfig = readProjectFile(".git/config");

if (basename(root).toLowerCase() !== "auterim") errors.push("current folder is not Auterim");
if (identity.PROJECT_NAME !== "Auterim" || packageJson.name !== "auterim") {
  errors.push("local project identity does not match Auterim");
}
if (
  identity.EXPECTED_GITHUB_REPOSITORY !== "michelpronkk-oss/auterim" ||
  identity.EXPECTED_GITHUB_REMOTE !== "https://github.com/michelpronkk-oss/auterim.git" ||
  identity.EXPECTED_VERCEL_PROJECT !== "auterim" ||
  identity.EXPECTED_TRIGGER_PROJECT !== "proj_hwqtxtyrvwykjirkrdoh"
) {
  errors.push(".project-identity does not match the approved Auterim identifiers");
}

const origin = readOrigin(gitConfig);
if (
  !origin ||
  origin.urls.length !== 1 ||
  origin.urls[0] !== identity.EXPECTED_GITHUB_REMOTE ||
  origin.pushUrls.some((url) => url !== identity.EXPECTED_GITHUB_REMOTE)
) {
  errors.push("Git origin does not match the approved Auterim repository");
}

let supabaseRef: string | undefined;
try {
  const environment = parseEnvironment(localEnvironment);
  const supabaseUrl = environment.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl || !environment.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    errors.push("Auterim Supabase URL or publishable key is not configured in .env.local");
  } else {
    const parsedUrl = new URL(supabaseUrl);
    const suffix = ".supabase.co";
    if (parsedUrl.protocol !== "https:" || !parsedUrl.hostname.endsWith(suffix)) {
      errors.push("Supabase URL is not a standard HTTPS Supabase project URL");
    } else {
      supabaseRef = parsedUrl.hostname.slice(0, -suffix.length);
      if (!/^[a-z0-9]{20}$/.test(supabaseRef)) {
        errors.push("Supabase project ref does not match the expected 20-character format");
      }
    }
    if (!(environment.SUPABASE_SECRET_KEY || environment.SUPABASE_SERVICE_ROLE_KEY)) {
      errors.push("server-only Supabase secret is not configured in .env.local");
    }
  }
} catch {
  errors.push("Auterim .env.local failed environment validation");
}

const triggerProject = triggerConfig.match(/^\s*project\s*:\s*["'](proj_[a-z0-9]{20})["']/m)?.[1];
if (!triggerProject || !/dirs\s*:\s*\[\s*["']\.\/src\/trigger["']\s*\]/m.test(triggerConfig)) {
  errors.push("Trigger config has no valid local project ID or task directory");
} else if (triggerProject !== identity.EXPECTED_TRIGGER_PROJECT) {
  errors.push("Trigger project does not match the approved Auterim project identity");
}

if (
  environmentText.toLowerCase().includes("wanterest") ||
  triggerConfig.toLowerCase().includes("wanterest") ||
  gitConfig.toLowerCase().includes("wanterest")
) {
  errors.push("local integration configuration contains a disallowed project reference");
}

try {
  const vercelMetadata = JSON.parse(
    readFileSync(resolve(root, ".vercel/project.json"), "utf8"),
  ) as {
    projectName?: string;
    name?: string;
  };
  const vercelName = vercelMetadata.projectName ?? vercelMetadata.name;
  if (vercelName !== identity.EXPECTED_VERCEL_PROJECT) {
    errors.push("Vercel metadata is present but does not identify the approved Auterim project");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
    errors.push("Vercel metadata exists but is invalid or unreadable");
  }
}

console.log("Auterim project identity check");
if (errors.length > 0) {
  for (const error of errors) console.error(`FAIL: ${error}`);
  console.error("Identity checks failed. No remote operation should be attempted.");
  process.exitCode = 1;
} else {
  console.log("Project: Auterim");
  console.log("GitHub: michelpronkk-oss/auterim");
  console.log(`Supabase project ref: ${supabaseRef}`);
  console.log(`Trigger project: ${triggerProject}`);
  console.log("Vercel: not configured locally; no deployment check required");
  console.log("No secret values were printed. No remote requests were made.");
}
