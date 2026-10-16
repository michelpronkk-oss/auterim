import { createHash } from "node:crypto";
import { PatchProposalSchema, isSafeRepoPath, type FixPlan } from "@/lib/fix-engine/contracts";
import { containsHighEntropyQuotedCredential } from "@/lib/fix-engine/model";

export type ValidatedPatch = {
  fingerprint: string;
  changedPaths: string[];
  changedLines: number;
  byteCount: number;
  diff: string;
};

const MAX_PATCH_BYTES = 128 * 1024;
const MAX_FILES = 25;
const MAX_LINES = 2000;
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:ghp_|github_pat_|gho_|ghu_)[A-Za-z0-9_]{12,}/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][^"']{12,}["']/i,
];

function parseDiffPaths(diff: string) {
  const paths: string[] = [];
  const sections = diff.split(/(?=^diff --git )/m).filter((section) => section.length > 0);
  if (sections.length === 0 || sections[0]?.startsWith("diff --git ") !== true)
    throw new Error("patch_headers_invalid");
  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0] ?? "";
    const match = /^diff --git a\/([^\r\n]+) b\/([^\r\n]+)$/.exec(header);
    if (!match || match[1] !== match[2]) throw new Error("patch_rename_or_path_invalid");
    const oldHeaders = lines.filter((line) => line.startsWith("--- "));
    const newHeaders = lines.filter((line) => line.startsWith("+++ "));
    if (
      oldHeaders.length !== 1 ||
      newHeaders.length !== 1 ||
      oldHeaders[0] !== `--- a/${match[1]}` ||
      newHeaders[0] !== `+++ b/${match[2]}`
    ) {
      throw new Error("patch_path_header_mismatch");
    }
    if (!isSafeRepoPath(match[1]!)) throw new Error("patch_forbidden_path");
    paths.push(match[1]!);
  }
  if (new Set(paths).size !== paths.length) throw new Error("patch_duplicate_path");
  return paths;
}

export function validatePatchProposal(input: {
  proposal: unknown;
  plan: FixPlan;
  expectedBaseSha: string;
  expectedPlanFingerprint: string;
  expectedEvidenceFingerprint: string;
}): ValidatedPatch {
  const proposal = PatchProposalSchema.parse(input.proposal);
  if (proposal.baseSha.toLowerCase() !== input.expectedBaseSha.toLowerCase())
    throw new Error("patch_base_sha_mismatch");
  if (
    proposal.planFingerprint !== input.expectedPlanFingerprint ||
    proposal.evidenceFingerprint !== input.expectedEvidenceFingerprint
  ) {
    throw new Error("patch_provenance_mismatch");
  }
  const diff = proposal.unifiedDiff.replace(/\r\n/g, "\n");
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes > MAX_PATCH_BYTES) throw new Error("patch_size_exceeded");
  if (/^GIT binary patch|^Binary files /m.test(diff)) throw new Error("patch_binary_forbidden");
  if (
    /^(?:old mode|new mode|new file mode|deleted file mode|similarity index|rename from|rename to) /m.test(
      diff,
    )
  ) {
    throw new Error("patch_mode_or_rename_change_forbidden");
  }
  if (secretPatterns.some((pattern) => pattern.test(diff)))
    throw new Error("patch_secret_value_detected");
  if (containsHighEntropyQuotedCredential(diff)) throw new Error("patch_secret_value_detected");
  const paths = [...new Set(parseDiffPaths(diff))].sort();
  if (paths.length === 0) throw new Error("patch_noop");
  if (paths.length > MAX_FILES) throw new Error("patch_file_count_exceeded");
  if (paths.some((path) => !isSafeRepoPath(path))) throw new Error("patch_forbidden_path");
  const allowlisted = new Set(input.plan.allowedFiles.map((file) => file.path));
  if (paths.some((path) => !allowlisted.has(path))) throw new Error("patch_outside_plan");
  if (!/^--- a\/.+\n\+\+\+ b\/.+$/m.test(diff)) throw new Error("patch_headers_invalid");
  if (!/^@@ .* @@/m.test(diff)) throw new Error("patch_hunk_missing");
  const changedLines = diff
    .split("\n")
    .filter(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    ).length;
  if (changedLines === 0) throw new Error("patch_noop");
  if (changedLines > MAX_LINES) throw new Error("patch_line_count_exceeded");
  const fingerprint = createHash("sha256").update(diff, "utf8").digest("hex");
  return { fingerprint, changedPaths: paths, changedLines, byteCount: bytes, diff };
}

export const FIX_PATCH_LIMITS = {
  maxBytes: MAX_PATCH_BYTES,
  maxFiles: MAX_FILES,
  maxChangedLines: MAX_LINES,
} as const;
