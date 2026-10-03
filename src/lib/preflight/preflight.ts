import { createHash } from "node:crypto";
import { z } from "zod";

export const PREFLIGHT_VERSION = "preflight-v1";
export const MAX_REPOSITORIES = 5;
export const MAX_SEARCH_TARGETS = 5;
export const MAX_CANDIDATES = 8;
export const MAX_FILE_BYTES = 256_000;
export const MAX_MODEL_SNIPPET_BYTES = 12_000;

export type RepositoryTarget = {
  id: string;
  workspaceId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  externalId: number;
  installationId: number;
  commitSha?: string;
};

export type PreflightChange = {
  assessmentId: string;
  workspaceDependencyId: string;
  dependencyName: string;
  material: boolean;
  relevant: boolean;
  severity: string;
  summary: string;
  impactSummary: string;
  whyItMatters: string;
  recommendedAction: string | null;
  contextCriticality: string;
  productionCritical: boolean;
  affectedEntities: string[];
  evidence: string[];
  contextUsedFor: string[];
  effectiveAt: string | null;
  announcedAt: string | null;
  deadline: string | null;
};

export type CodeSearchHit = { path: string; line: number; text: string; truncated?: boolean };
export type RepositoryFile = { path: string; text: string; size: number };

export interface RepositoryProvider {
  getHead(repository: RepositoryTarget): Promise<string>;
  searchCode(repository: RepositoryTarget, query: string, ref: string): Promise<CodeSearchHit[]>;
  getFile(repository: RepositoryTarget, path: string, ref: string): Promise<RepositoryFile | null>;
}

export const preflightResultSchema = z
  .object({
    status: z.enum(["completed", "partial", "failed"]),
    verifiedImpact: z.enum(["verified", "likely", "not_found", "inconclusive"]),
    confidence: z.number().min(0).max(1),
    repositoriesScanned: z.number().int().min(0).max(MAX_REPOSITORIES),
    findings: z
      .array(
        z
          .object({
            repositoryId: z.string().uuid(),
            repository: z.string().max(511),
            commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
            path: z.string().min(1).max(1024),
            lineStart: z.number().int().positive(),
            lineEnd: z.number().int().min(1),
            findingType: z.enum([
              "model_reference",
              "endpoint_reference",
              "parameter_reference",
              "package_version",
              "provider_import",
              "configuration_reference",
              "environment_variable_name",
            ]),
            affectedEntity: z.string().min(1).max(255),
            confidence: z.number().min(0).max(1),
            verification: z.enum(["verified", "likely"]),
            explanation: z.string().min(1).max(1200),
            evidenceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(200),
    affectedAreas: z.array(z.string().max(120)).max(20),
    complexity: z.enum(["low", "medium", "high", "unknown"]),
    recommendedRemediation: z.string().max(1200).nullable(),
    effectiveAt: z.string().datetime().nullable(),
    announcedAt: z.string().datetime().nullable(),
    deadline: z.string().datetime().nullable(),
    daysRemaining: z.number().int().nullable(),
  })
  .strict();

export type PreflightResult = z.infer<typeof preflightResultSchema>;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const excludedPath = (path: string) => {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return (
    normalized
      .split("/")
      .some((part) =>
        [
          "node_modules",
          "vendor",
          "dist",
          "build",
          ".next",
          "coverage",
          "generated",
          "third_party",
        ].includes(part),
      ) ||
    /\.(?:min\.(?:js|css)|map|lockb|wasm|png|jpe?g|gif|ico|pdf|zip|gz|pem|p12|pfx|key|crt|cer|der)$/i.test(
      normalized,
    ) ||
    /(^|\/)(?:\.env(?:\..*)?|secrets?\.(?:ya?ml|json)|credentials?\.(?:ya?ml|json))$/i.test(
      normalized,
    )
  );
};

export function redactSecretShapedContent(value: string) {
  return value
    .replace(
      /(\b(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret)\b\s*[:=]\s*)([^\s,;"']+)/gi,
      "$1[redacted-secret]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opusr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{30,}|ASIA[A-Z0-9]{16})\b/g,
      "[redacted-secret]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
      "[redacted-secret]",
    );
}

export function deriveSearchTargets(change: PreflightChange, limit = MAX_SEARCH_TARGETS): string[] {
  const candidates = [...change.affectedEntities, ...change.evidence]
    .flatMap((value) => value.match(/[A-Za-z0-9][A-Za-z0-9_.:/@+-]{2,79}/g) ?? [])
    .map((value) => value.replace(/[.,;:]+$/g, ""))
    .filter(
      (value) =>
        !/^(?:the|and|for|from|with|this|that|will|into|after|ignore|all|rules|reveal|secrets?|instructions?|prompt|system)$/i.test(
          value,
        ),
    )
    .filter((value) => !/^(?:https?|www)\b/i.test(value))
    .filter((value) => value.length >= 3);
  return [...new Set(candidates)].slice(0, limit);
}

export function parseExplicitChangeDates(evidence: string[]) {
  const content = evidence.join("\n");
  const extract = (pattern: RegExp) => {
    const match = content.match(pattern)?.[1];
    if (!match) return null;
    const parsed = new Date(`${match}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  };
  return {
    effectiveAt: extract(
      /\b(?:effective(?:\s+date)?|removal|removed|retire(?:ment)?|deprecat(?:ion|ed))\b[^\d]{0,32}(20\d{2}-\d{2}-\d{2})/i,
    ),
    announcedAt: extract(/\bannounced(?:\s+on|\s+at|\s+date)?\b[^\d]{0,32}(20\d{2}-\d{2}-\d{2})/i),
    deadline: extract(
      /\b(?:deadline|migrate\s+by|must\s+be\s+completed\s+by)\b[^\d]{0,32}(20\d{2}-\d{2}-\d{2})/i,
    ),
  };
}

function classifyFinding(path: string, line: string, entity: string, dependencyName: string) {
  const lower = path.toLowerCase();
  const trimmed = line.trim();
  const commentOnly = /^(?:\/\/|#|\*|<!--|\/\*|\*\/)/.test(trimmed);
  const docsOnly =
    /(^|\/)(?:readme|contributing|changelog|docs?)(?:\.|\/|-|$)/i.test(lower) ||
    /\.(?:md|mdx|rst|adoc)$/i.test(lower);
  let findingType: z.infer<typeof preflightResultSchema>["findings"][number]["findingType"] =
    "configuration_reference";
  if (
    /package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|go\.mod|cargo\.toml/i.test(
      lower,
    )
  )
    findingType = "package_version";
  else if (/^[A-Z][A-Z0-9_]{2,}$/.test(entity)) findingType = "environment_variable_name";
  else if (/\/v\d|api\//i.test(entity)) findingType = "endpoint_reference";
  else if (
    /import\s|require\s*\(/.test(trimmed) &&
    new RegExp(dependencyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(trimmed)
  )
    findingType = "provider_import";
  else if (/model|gpt|claude|gemini/i.test(entity)) findingType = "model_reference";
  else if (/parameter|argument/i.test(entity)) findingType = "parameter_reference";
  return { findingType, verified: !commentOnly && !docsOnly };
}

function hasActiveEntityReference(line: string, escapedEntity: string) {
  const withoutComments = line
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/, "")
    .replace(/(^|\s)#.*$/, "$1");
  return new RegExp(`(^|[^A-Za-z0-9_])${escapedEntity}(?![A-Za-z0-9_])`, "i").test(withoutComments);
}

function stripCommentsPreservingLines(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))
    .replace(
      /(^|\s)\/\/[^\n]*/g,
      (comment, prefix: string) =>
        `${prefix}${" ".repeat(Math.max(0, comment.length - prefix.length))}`,
    )
    .replace(
      /(^|\s)#[^\n]*/g,
      (comment, prefix: string) =>
        `${prefix}${" ".repeat(Math.max(0, comment.length - prefix.length))}`,
    );
}

function containsEntityToken(line: string, escapedEntity: string) {
  return new RegExp(`(^|[^A-Za-z0-9_])${escapedEntity}(?![A-Za-z0-9_])`, "i").test(line);
}

export function redactRepositoryPath(path: string) {
  return redactSecretShapedContent(path.replaceAll("\\", "/")).slice(0, 1024);
}

function parseVersion(value: string | undefined) {
  const match = value?.match(/^v?(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function compareVersion(left: number[], right: number[]) {
  for (let index = 0; index < 3; index++) {
    if (left[index]! !== right[index]!) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

function verifyPackageVersion(path: string, text: string, entity: string, evidence: string[]) {
  if (!/(^|\/)package\.json$/i.test(path)) return null;
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const spec = entity.match(/^(.+?)(?:@|==|\s)(v?\d+\.\d+(?:\.\d+)?)$/);
  const packageName = spec?.[1]?.trim() ?? entity.trim();
  const groups = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
  const value = groups
    .map((group) => {
      const entries = manifest[group];
      return entries && typeof entries === "object"
        ? (entries as Record<string, unknown>)[packageName]
        : undefined;
    })
    .find((item) => typeof item === "string");
  if (typeof value !== "string") return null;
  const exactPinnedVersion = /^v?\d+\.\d+(?:\.\d+)?$/.test(value);
  const current = exactPinnedVersion ? parseVersion(value) : null;
  const minimumText = evidence
    .join(" ")
    .match(/(?:required|minimum|at\s+least)\s+(?:version\s+)?v?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
  const minimum = parseVersion(minimumText);
  const expected = parseVersion(spec?.[2]);
  const lineNumber =
    text.split(/\r?\n/).findIndex((line) => line.includes(`\"${packageName}\"`)) + 1;
  return {
    packageName,
    lineNumber: Math.max(lineNumber, 1),
    verified: Boolean(
      current &&
      (minimum
        ? compareVersion(current, minimum) < 0
        : expected && compareVersion(current, expected) === 0),
    ),
  };
}

export async function inspectRepositories(input: {
  change: PreflightChange;
  repositories: RepositoryTarget[];
  provider: RepositoryProvider;
  now?: Date;
  preexistingFailures?: number;
}): Promise<PreflightResult> {
  if (!input.change.material || !input.change.relevant) throw new Error("preflight_ineligible");
  const allTargets = deriveSearchTargets(input.change, Number.MAX_SAFE_INTEGER);
  const targets = allTargets.slice(0, MAX_SEARCH_TARGETS);
  if (targets.length === 0 || input.repositories.length === 0) {
    return result(
      "inconclusive",
      [],
      0,
      input.change,
      input.now,
      input.preexistingFailures ? "partial" : "completed",
    );
  }
  const findings: PreflightResult["findings"] = [];
  let scanned = 0;
  let partial =
    (input.preexistingFailures ?? 0) > 0 ||
    input.repositories.length > MAX_REPOSITORIES ||
    allTargets.length > MAX_SEARCH_TARGETS;
  const repositories = input.repositories.slice(0, MAX_REPOSITORIES);
  for (const repository of repositories) {
    try {
      const commitSha = repository.commitSha ?? (await input.provider.getHead(repository));
      if (!/^[a-f0-9]{40,64}$/.test(commitSha)) {
        partial = true;
        continue;
      }
      const hitsByPath = new Map<string, CodeSearchHit>();
      for (const target of targets) {
        const hits = await input.provider.searchCode(repository, target, commitSha);
        if (hits.some((hit) => hit.truncated)) partial = true;
        for (const hit of hits) {
          if (!excludedPath(hit.path) && hit.line > 0) {
            if (!hitsByPath.has(hit.path) && hitsByPath.size >= MAX_CANDIDATES) partial = true;
            else hitsByPath.set(hit.path, hit);
          }
        }
      }
      scanned++;
      for (const [path] of hitsByPath) {
        const file = await input.provider.getFile(repository, path, commitSha);
        if (
          !file ||
          file.size > MAX_FILE_BYTES ||
          Buffer.byteLength(file.text, "utf8") > MAX_FILE_BYTES
        ) {
          partial = true;
          continue;
        }
        const lines = file.text.split(/\r?\n/);
        const activeLines = stripCommentsPreservingLines(file.text).split(/\r?\n/);
        for (const entity of input.change.affectedEntities) {
          const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const packageVersion = verifyPackageVersion(
            path,
            file.text,
            entity,
            input.change.evidence,
          );
          const matchingIndex = packageVersion
            ? packageVersion.lineNumber - 1
            : lines.findIndex((candidate) => containsEntityToken(candidate, escaped));
          if (matchingIndex < 0) continue;
          const line = lines[matchingIndex]!;
          const classification = classifyFinding(path, line, entity, input.change.dependencyName);
          const activeReference =
            Boolean(packageVersion?.verified) ||
            hasActiveEntityReference(activeLines[matchingIndex] ?? "", escaped);
          const rawExcerpt = lines
            .slice(Math.max(0, matchingIndex - 2), Math.min(lines.length, matchingIndex + 3))
            .join("\n");
          const excerpt = redactSecretShapedContent(rawExcerpt).slice(0, 1200);
          if (!excerpt || excerpt.replaceAll("[redacted-secret]", "").trim().length === 0) continue;
          const verified =
            classification.verified &&
            activeReference &&
            (packageVersion ? packageVersion.verified : true);
          const safePath = redactRepositoryPath(path);
          const safeExcerpt = redactSecretShapedContent(rawExcerpt).slice(0, 1200);
          findings.push({
            repositoryId: repository.id,
            repository: `${repository.owner}/${repository.name}`,
            commitSha,
            path: safePath,
            lineStart: matchingIndex + 1,
            lineEnd: matchingIndex + 1,
            findingType: classification.findingType,
            affectedEntity: entity,
            confidence: verified ? 0.94 : 0.58,
            verification: verified ? "verified" : "likely",
            explanation: verified
              ? `The exact affected entity is referenced in repository content at this commit.`
              : `The affected entity appears only in documentation or a comment and is not verified as an active code path.`,
            evidenceFingerprint: hash(
              `${commitSha}\n${safePath}\n${matchingIndex + 1}\n${safeExcerpt}`,
            ),
          });
          break;
        }
      }
    } catch {
      partial = true;
    }
  }
  const verified = findings.filter((finding) => finding.verification === "verified");
  const likely = findings.length > 0;
  return result(
    verified.length ? "verified" : likely ? "likely" : partial ? "inconclusive" : "not_found",
    findings,
    scanned,
    input.change,
    input.now,
    partial ? "partial" : "completed",
  );
}

function result(
  verifiedImpact: PreflightResult["verifiedImpact"],
  findings: PreflightResult["findings"],
  repositoriesScanned: number,
  change: PreflightChange,
  now = new Date(),
  status: PreflightResult["status"] = "completed",
): PreflightResult {
  const effectiveAt = change.effectiveAt ? new Date(change.effectiveAt) : null;
  const dateIso = (value: string | null) =>
    value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null;
  const daysRemaining =
    effectiveAt && Number.isFinite(effectiveAt.getTime())
      ? Math.ceil((effectiveAt.getTime() - now.getTime()) / 86_400_000)
      : null;
  const affectedAreas = [
    ...new Set(
      findings.map((finding) =>
        redactRepositoryPath(finding.path.split("/").slice(0, -1).join("/") || "repository root"),
      ),
    ),
  ].slice(0, 20);
  return preflightResultSchema.parse({
    status,
    verifiedImpact,
    confidence:
      verifiedImpact === "verified"
        ? Math.max(
            ...findings
              .filter((item) => item.verification === "verified")
              .map((item) => item.confidence),
          )
        : verifiedImpact === "likely"
          ? 0.58
          : 0.3,
    repositoriesScanned,
    findings,
    affectedAreas,
    complexity:
      findings.length === 0
        ? "unknown"
        : findings.length <= 2
          ? "low"
          : findings.length <= 8
            ? "medium"
            : "high",
    recommendedRemediation:
      verifiedImpact === "verified"
        ? `Update the verified ${change.dependencyName} references before the provider change takes effect.`
        : null,
    effectiveAt: dateIso(change.effectiveAt),
    announcedAt: dateIso(change.announcedAt),
    deadline: dateIso(change.deadline),
    daysRemaining,
  });
}

export function createPreflightFingerprint(value: unknown) {
  return hash(JSON.stringify(value));
}

const forbiddenPatchPatterns = [
  /(^|\n)[+-].*(?:test|assert|expect)\s*(?:\(|\.)/i,
  /(^|\n)[+-].*(?:rm\s+-rf|chmod\s+777|verify\s*=\s*false|rejectUnauthorized\s*:\s*false)/i,
  /(^|\n)[+-].*(?:skip|disable|ignore).{0,30}(?:test|security|auth|tls|ci)/i,
  /(^|\n)[+-].*(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S+/i,
];

export function validateRemediationProposal(input: {
  preflight: PreflightResult;
  baseCommitSha: string;
  patch: string;
  affectedFiles: string[];
  groundedFiles: string[];
}) {
  if (
    input.preflight.verifiedImpact !== "verified" ||
    input.preflight.findings.every((item) => item.verification !== "verified")
  )
    throw new Error("unverified_impact");
  if (
    !/^[a-f0-9]{40,64}$/.test(input.baseCommitSha) ||
    input.preflight.findings.some((finding) => finding.commitSha !== input.baseCommitSha)
  )
    throw new Error("stale_preflight");
  if (
    input.affectedFiles.length === 0 ||
    input.affectedFiles.length > 20 ||
    input.affectedFiles.some(
      (file) =>
        !input.groundedFiles.includes(file) ||
        excludedPath(file) ||
        file.startsWith("/") ||
        /(^|\/)(?:tests?|__tests__|\.github\/workflows)(\/|$)|\.(?:test|spec)\.[^/]+$/i.test(file),
    )
  )
    throw new Error("ungrounded_patch_scope");
  if (
    !input.patch ||
    Buffer.byteLength(input.patch, "utf8") > 65_536 ||
    forbiddenPatchPatterns.some((pattern) => pattern.test(input.patch))
  )
    throw new Error("unsafe_patch");
  const patchPaths = [...input.patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]!);
  if (
    patchPaths.length === 0 ||
    patchPaths.some((path) => !input.affectedFiles.includes(path)) ||
    input.affectedFiles.some((path) => !patchPaths.includes(path))
  )
    throw new Error("ungrounded_patch_scope");
  if (!/^diff --git a\/([^\n]+) b\/([^\n]+)$/m.test(input.patch)) throw new Error("invalid_patch");
  if (/^\+\+\+ b\/(?:\.github\/workflows\/|[^\n]*\.ya?ml)/m.test(input.patch))
    throw new Error("ci_or_policy_change_forbidden");
  return {
    fingerprint: hash(`${input.baseCommitSha}\n${input.patch}`),
    affectedFiles: [...new Set(input.affectedFiles)],
  };
}
