import { createHash } from "node:crypto";
import {
  validateRemediationProposal,
  type PreflightResult,
  type RepositoryFile,
} from "@/lib/preflight/preflight";

export type ExplicitReplacementEvidence = {
  authoritative: true;
  oldExpression: string;
  newExpression: string;
  evidenceId: string;
};

export type PreparedPatch = {
  outcome: "PATCH_PREPARED";
  patch: string;
  baseCommitSha: string;
  affectedFiles: string[];
  matchedEvidenceIds: string[];
  fingerprint: string;
};

export type PatchPreparationResult =
  | PreparedPatch
  | { outcome: "NO_SAFE_PATCH"; reason: string }
  | { outcome: "INSUFFICIENT_EVIDENCE"; reason: string }
  | { outcome: "NEEDS_HUMAN_REVIEW"; reason: string };

const forbiddenReplacement =
  /(?:api[_-]?key|secret|password|token)\s*[:=]\s*\S+|\[redacted-secret\]/i;

function safePath(path: string) {
  return (
    path.length <= 1024 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    !/(^|\/)(?:tests?|__tests__|\.github\/workflows)(\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path)
  );
}

function makeSingleFileDiff(path: string, lineNumber: number, oldLine: string, newLine: string) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${lineNumber},1 +${lineNumber},1 @@`,
    `-${oldLine}`,
    `+${newLine}`,
    "",
  ].join("\n");
}

/**
 * Build only an exact, evidence-backed replacement at the commit that Preflight verified.
 * This deliberately does not infer a migration from prose or call a model.
 */
export function prepareGroundedPatch(input: {
  preflight: PreflightResult;
  files: ReadonlyMap<string, RepositoryFile>;
  replacement: ExplicitReplacementEvidence | null;
}): PatchPreparationResult {
  const verified = input.preflight.findings.filter(
    (finding) => finding.verification === "verified",
  );
  if (
    input.preflight.status !== "completed" ||
    input.preflight.verifiedImpact !== "verified" ||
    verified.length === 0
  ) {
    return { outcome: "INSUFFICIENT_EVIDENCE", reason: "verified_completed_preflight_required" };
  }
  if (!input.replacement?.authoritative) {
    return { outcome: "NO_SAFE_PATCH", reason: "explicit_authoritative_replacement_required" };
  }
  const { oldExpression, newExpression, evidenceId } = input.replacement;
  if (
    !evidenceId ||
    !oldExpression.trim() ||
    !newExpression.trim() ||
    oldExpression.length > 240 ||
    newExpression.length > 240 ||
    /[\r\n]/.test(oldExpression + newExpression) ||
    oldExpression === newExpression ||
    forbiddenReplacement.test(oldExpression) ||
    forbiddenReplacement.test(newExpression)
  ) {
    return { outcome: "NO_SAFE_PATCH", reason: "replacement_not_safe_or_exact" };
  }
  const commitShas = new Set(verified.map((finding) => finding.commitSha));
  const repositoryIds = new Set(verified.map((finding) => finding.repositoryId));
  if (commitShas.size !== 1 || repositoryIds.size !== 1) {
    return { outcome: "NEEDS_HUMAN_REVIEW", reason: "findings_span_multiple_repository_states" };
  }
  const baseCommitSha = [...commitShas][0]!;
  const chunks: string[] = [];
  const affectedFiles: string[] = [];
  for (const finding of verified) {
    if (!safePath(finding.path))
      return { outcome: "NO_SAFE_PATCH", reason: "unsafe_or_excluded_path" };
    const file = input.files.get(finding.path);
    if (!file || file.size > 256_000 || Buffer.byteLength(file.text, "utf8") > 256_000) {
      return { outcome: "INSUFFICIENT_EVIDENCE", reason: "pinned_file_unavailable_or_too_large" };
    }
    const lines = file.text.split(/\r?\n/);
    const line = lines[finding.lineStart - 1];
    if (!line || line.includes("[redacted-secret]") || !line.includes(oldExpression)) {
      return {
        outcome: "NO_SAFE_PATCH",
        reason: "verified_line_does_not_match_replacement_evidence",
      };
    }
    const occurrences = line.split(oldExpression).length - 1;
    if (occurrences !== 1)
      return { outcome: "NEEDS_HUMAN_REVIEW", reason: "replacement_is_ambiguous" };
    const nextLine = line.replace(oldExpression, newExpression);
    chunks.push(makeSingleFileDiff(finding.path, finding.lineStart, line, nextLine));
    affectedFiles.push(finding.path);
  }
  const patch = chunks.join("");
  try {
    const validated = validateRemediationProposal({
      preflight: input.preflight,
      baseCommitSha,
      patch,
      affectedFiles,
      groundedFiles: verified.map((finding) => finding.path),
    });
    return {
      outcome: "PATCH_PREPARED",
      patch,
      baseCommitSha,
      affectedFiles: validated.affectedFiles,
      matchedEvidenceIds: [evidenceId],
      fingerprint: createHash("sha256")
        .update(`${validated.fingerprint}\n${evidenceId}`)
        .digest("hex"),
    };
  } catch {
    return { outcome: "NO_SAFE_PATCH", reason: "patch_failed_static_safety_validation" };
  }
}
