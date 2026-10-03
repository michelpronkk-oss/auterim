import { createHash } from "node:crypto";
import { validateRemediationProposal, type PreflightResult } from "@/lib/preflight/preflight";

export type GroundedFinding = PreflightResult["findings"][number];

export function buildRemediationGuidance(input: {
  preflightRunId: string;
  result: PreflightResult;
  findings: GroundedFinding[];
}) {
  const verified = input.findings.filter((finding) => finding.verification === "verified");
  if (input.result.verifiedImpact !== "verified" || verified.length === 0) {
    throw new Error("remediation_requires_verified_impact");
  }
  const affectedFiles = [...new Set(verified.map((finding) => finding.path))].slice(0, 20);
  if (affectedFiles.length === 0) throw new Error("remediation_requires_grounded_files");
  const rationale = `Verified references were found at the recorded commit in ${affectedFiles.length} file${affectedFiles.length === 1 ? "" : "s"}. The provider evidence does not name a safe replacement value, so this proposal gives a grounded migration task without inventing a code edit.`;
  const migrationNotes =
    "Confirm the provider-supported replacement and compatibility requirements from the authoritative provider documentation before changing production configuration.";
  const validationRequirements = [
    "Update only the verified references listed in this proposal.",
    "Run the repository's existing relevant test suite and type checks.",
    "Review provider migration notes and verify behavior in a non-production environment.",
  ];
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        preflightRunId: input.preflightRunId,
        findings: verified.map((finding) => finding.evidenceFingerprint).sort(),
      }),
    )
    .digest("hex");
  return {
    proposalKind: "grounded_guidance" as const,
    affectedFiles,
    rationale,
    migrationNotes,
    validationRequirements,
    fingerprint,
  };
}

export interface DraftPullRequestProvider {
  createBranch(input: {
    owner: string;
    repository: string;
    baseSha: string;
    branch: string;
  }): Promise<void>;
  applyPatch(input: {
    owner: string;
    repository: string;
    branch: string;
    patch: string;
    affectedFiles: string[];
  }): Promise<void>;
  commitChanges(input: {
    owner: string;
    repository: string;
    branch: string;
    message: string;
  }): Promise<{ headSha: string }>;
  createDraftPullRequest(input: {
    owner: string;
    repository: string;
    baseBranch: string;
    headBranch: string;
    title: string;
    body: string;
  }): Promise<{ url: string }>;
}

export function validateDraftPullRequest(input: {
  baseBranch: string;
  headBranch: string;
  patchPrepared: boolean;
}) {
  if (!input.patchPrepared) throw new Error("draft_pr_requires_patch");
  if (
    !input.baseBranch ||
    input.headBranch === input.baseBranch ||
    !/^auterim\/fix\/[a-f0-9]{8,40}$/.test(input.headBranch)
  ) {
    throw new Error("draft_pr_requires_isolated_branch");
  }
  return true;
}

export class MockDraftPullRequestProvider implements DraftPullRequestProvider {
  readonly operations: string[] = [];
  async createBranch() {
    this.operations.push("create_branch");
  }
  async applyPatch() {
    this.operations.push("apply_patch");
  }
  async commitChanges() {
    this.operations.push("commit");
    return { headSha: "c".repeat(40) };
  }
  async createDraftPullRequest(
    input: Parameters<DraftPullRequestProvider["createDraftPullRequest"]>[0],
  ) {
    this.operations.push("create_draft_pull_request");
    return { url: `https://github.com/${input.owner}/${input.repository}/pull/fixture` };
  }
}

export async function prepareDraftPullRequest(input: {
  provider: DraftPullRequestProvider;
  preflight: PreflightResult;
  groundedFiles: string[];
  owner: string;
  repository: string;
  defaultBranch: string;
  baseSha: string;
  headBranch: string;
  title: string;
  body: string;
  patch: string;
  affectedFiles: string[];
}) {
  validateRemediationProposal({
    preflight: input.preflight,
    baseCommitSha: input.baseSha,
    patch: input.patch,
    affectedFiles: input.affectedFiles,
    groundedFiles: input.groundedFiles,
  });
  validateDraftPullRequest({
    baseBranch: input.defaultBranch,
    headBranch: input.headBranch,
    patchPrepared: Boolean(input.patch),
  });
  if (!/^[a-f0-9]{40,64}$/.test(input.baseSha)) throw new Error("invalid_base_commit");
  if (
    !input.owner ||
    !input.repository ||
    !input.title.trim() ||
    input.title.length > 120 ||
    input.body.length > 10_000
  )
    throw new Error("invalid_draft_pr_metadata");
  await input.provider.createBranch({
    owner: input.owner,
    repository: input.repository,
    baseSha: input.baseSha,
    branch: input.headBranch,
  });
  await input.provider.applyPatch({
    owner: input.owner,
    repository: input.repository,
    branch: input.headBranch,
    patch: input.patch,
    affectedFiles: input.affectedFiles,
  });
  await input.provider.commitChanges({
    owner: input.owner,
    repository: input.repository,
    branch: input.headBranch,
    message: input.title.slice(0, 120),
  });
  const draft = await input.provider.createDraftPullRequest({
    owner: input.owner,
    repository: input.repository,
    baseBranch: input.defaultBranch,
    headBranch: input.headBranch,
    title: input.title,
    body: input.body,
  });
  if (!draft.url.startsWith(`https://github.com/${input.owner}/${input.repository}/pull/`))
    throw new Error("invalid_draft_pr_url");
  return {
    url: draft.url,
    branch: input.headBranch,
    status: "draft_pr_prepared" as const,
    merged: false,
    deployed: false,
  };
}
