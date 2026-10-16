import { createHash } from "node:crypto";
import type { FixRiskAssessment } from "@/lib/fix-engine/risk";
import { isSafeRepoPath } from "@/lib/fix-engine/contracts";

export type FixDraftPrEligibility = {
  provenanceMode: "customer" | "evidence_only";
  productPolicyAllowsDraftPr: boolean;
  repositoryAllowlisted: boolean;
  installationRepositoryIdentity: string;
  repositoryIdentity: string;
  permissions: { contents: "read" | "write"; pull_requests: "read" | "write" };
  risk: FixRiskAssessment;
  verificationPassed: boolean;
  preflightRequired: boolean;
  preflightPassed: boolean;
  baseSha: string;
  currentDefaultBranchSha: string;
  unresolvedExternalOperation: boolean;
  reviewDisposition?: "none" | "review_required";
  reviewReason?: string | null;
};

export function assertDraftPrEligible(input: FixDraftPrEligibility): void {
  if (input.provenanceMode === "evidence_only") throw new Error("evidence_only_draft_pr_forbidden");
  if (!input.productPolicyAllowsDraftPr || !input.repositoryAllowlisted)
    throw new Error("draft_pr_policy_denied");
  if (input.installationRepositoryIdentity.toLowerCase() !== input.repositoryIdentity.toLowerCase())
    throw new Error("github_installation_scope_mismatch");
  if (input.permissions.contents !== "write" || input.permissions.pull_requests !== "write")
    throw new Error("github_write_permission_missing");
  if (input.risk.level !== "LOW" && input.risk.level !== "MEDIUM")
    throw new Error("draft_pr_risk_blocked");
  if (!input.verificationPassed || (input.preflightRequired && !input.preflightPassed))
    throw new Error("draft_pr_verification_required");
  if (
    !/^[a-f0-9]{40,64}$/i.test(input.baseSha) ||
    input.currentDefaultBranchSha.toLowerCase() !== input.baseSha.toLowerCase()
  ) {
    throw new Error("stale_base");
  }
  if (input.unresolvedExternalOperation) throw new Error("external_operation_unresolved");
}

export function deterministicFixBranch(identityKey: string) {
  if (!/^[a-f0-9]{64}$/i.test(identityKey)) throw new Error("invalid_fix_identity_key");
  return `auterim/fix/${identityKey.slice(0, 12).toLowerCase()}`;
}

export type GitHubChangedFile = { path: string; content?: string; deleted?: boolean };
export type DraftPrResult = { branch: string; headSha: string; url: string; reconciled: boolean };
export type GitHubWriteGrant = {
  repositoryIdentity: string;
  installationRepositoryIdentity: string;
  permissions: { contents: "read" | "write"; pull_requests: "read" | "write" };
};

export function validateDraftPrFiles(files: GitHubChangedFile[]): void {
  if (
    files.length < 1 ||
    files.length > 25 ||
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some(
      (file) =>
        !isSafeRepoPath(file.path) ||
        (!file.deleted &&
          (typeof file.content !== "string" ||
            Buffer.byteLength(file.content, "utf8") > 128 * 1024)),
    )
  ) {
    throw new Error("github_patch_file_invalid");
  }
}

export interface DraftPRProvider {
  createDraft(input: {
    owner: string;
    repository: string;
    defaultBranch: string;
    baseSha: string;
    identityKey: string;
    changedFiles: GitHubChangedFile[];
    eligibility: FixDraftPrEligibility;
  }): Promise<DraftPrResult>;
  reconcileDraft?(
    input: Parameters<DraftPRProvider["createDraft"]>[0],
  ): Promise<DraftPrResult | null>;
}

function candidateCommitMessage(identityKey: string, files: GitHubChangedFile[]) {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        [...files]
          .sort((left, right) => left.path.localeCompare(right.path))
          .map(({ path, content, deleted }) => ({
            path,
            content: content ?? null,
            deleted: deleted ?? false,
          })),
      ),
      "utf8",
    )
    .digest("hex");
  return `Auterim candidate fix ${identityKey.slice(0, 12)} ${fingerprint.slice(0, 12)}`;
}

export class InMemoryDraftPRProvider implements DraftPRProvider {
  readonly operations: string[] = [];
  private readonly outcomes = new Map<string, DraftPrResult>();

  async createDraft(input: Parameters<DraftPRProvider["createDraft"]>[0]): Promise<DraftPrResult> {
    assertDraftPrEligible(input.eligibility);
    validateDraftPrFiles(input.changedFiles);
    const key = input.identityKey;
    const previous = this.outcomes.get(key);
    if (previous) return { ...previous, reconciled: true };
    const result = {
      branch: deterministicFixBranch(key),
      headSha: createHash("sha1").update(`${key}:fixture-head`).digest("hex"),
      url: `https://github.com/${input.owner}/${input.repository}/pull/fixture-${key.slice(0, 8)}`,
      reconciled: false,
    };
    this.operations.push("create_branch", "create_commit", "create_draft_pr");
    this.outcomes.set(key, result);
    return result;
  }
}

type GitHubResponse = Record<string, unknown>;

/** Real GitHub App write adapter. It makes no requests unless constructed with an exact scoped grant and invoked after eligibility passes. */
export class GitHubAppDraftPRProvider implements DraftPRProvider {
  constructor(
    private readonly dependencies: {
      installationToken: () => Promise<string>;
      verifiedGrant: GitHubWriteGrant;
      fetcher?: typeof fetch;
      apiBaseUrl?: string;
    },
  ) {}

  private async request(
    token: string,
    path: string,
    init: RequestInit = {},
  ): Promise<GitHubResponse> {
    const fetcher = this.dependencies.fetcher ?? fetch;
    let response: Response;
    try {
      response = await fetcher(
        `${this.dependencies.apiBaseUrl ?? "https://api.github.com"}${path}`,
        {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(15_000),
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...init.headers,
          },
        },
      );
    } catch {
      throw new Error("github_write_transport_ambiguous");
    }
    const body = (await response.json().catch(() => ({}))) as GitHubResponse;
    if (!response.ok) {
      if (response.status === 404) throw new Error("github_resource_not_found");
      if (response.status === 409 || response.status === 422)
        throw new Error("github_write_conflict");
      if (response.status >= 500) throw new Error("github_write_provider_unavailable");
      throw new Error("github_write_rejected");
    }
    return body;
  }

  async reconcileDraft(input: Parameters<DraftPRProvider["createDraft"]>[0]) {
    if (
      `${input.owner}/${input.repository}`.toLowerCase() !==
      this.dependencies.verifiedGrant.repositoryIdentity.toLowerCase()
    ) {
      throw new Error("github_repository_identity_mismatch");
    }
    assertDraftPrEligible({
      ...input.eligibility,
      installationRepositoryIdentity:
        this.dependencies.verifiedGrant.installationRepositoryIdentity,
      repositoryIdentity: this.dependencies.verifiedGrant.repositoryIdentity,
      permissions: this.dependencies.verifiedGrant.permissions,
      baseSha: input.baseSha,
      currentDefaultBranchSha: input.eligibility.currentDefaultBranchSha,
    });
    validateDraftPrFiles(input.changedFiles);
    const owner = encodeURIComponent(input.owner);
    const repository = encodeURIComponent(input.repository);
    const branch = deterministicFixBranch(input.identityKey.toLowerCase());
    const branchRef = `heads/${branch}`;
    const branchPath = `/repos/${owner}/${repository}/git/ref/${branchRef.split("/").map(encodeURIComponent).join("/")}`;
    const token = await this.dependencies.installationToken();
    const [defaultRef, branchRefResult] = await Promise.all([
      this.request(
        token,
        `/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(input.defaultBranch)}`,
      ),
      this.request(token, branchPath).catch((error) => {
        if (error instanceof Error && error.message === "github_resource_not_found") return null;
        throw error;
      }),
    ]);
    const defaultObject = defaultRef.object as Record<string, unknown> | undefined;
    if (String(defaultObject?.sha ?? "").toLowerCase() !== input.baseSha.toLowerCase())
      throw new Error("stale_base");
    const branchObject = branchRefResult?.object as Record<string, unknown> | undefined;
    const branchSha = typeof branchObject?.sha === "string" ? branchObject.sha : null;
    if (!branchSha) return null;
    const commit = await this.request(
      token,
      `/repos/${owner}/${repository}/git/commits/${encodeURIComponent(branchSha)}`,
    );
    const parents = Array.isArray(commit.parents) ? commit.parents : [];
    if (
      commit.message !==
        candidateCommitMessage(input.identityKey.toLowerCase(), input.changedFiles) ||
      !parents.some(
        (parent) =>
          parent &&
          typeof parent === "object" &&
          String((parent as Record<string, unknown>).sha ?? "").toLowerCase() ===
            input.baseSha.toLowerCase(),
      )
    ) {
      throw new Error("github_branch_reconciliation_conflict");
    }
    const pulls = await this.request(
      token,
      `/repos/${owner}/${repository}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${input.owner}:${branch}`)}&base=${encodeURIComponent(input.defaultBranch)}`,
    );
    const list = Array.isArray(pulls) ? pulls : [];
    const found = list.find(
      (item) =>
        item &&
        typeof item === "object" &&
        ((item as Record<string, unknown>).head as Record<string, unknown> | undefined)?.ref ===
          branch,
    ) as Record<string, unknown> | undefined;
    if (!found) return null;
    const head = found.head as Record<string, unknown> | undefined;
    const base = found.base as Record<string, unknown> | undefined;
    if (
      found.state !== "open" ||
      found.draft !== true ||
      head?.sha !== branchSha ||
      base?.ref !== input.defaultBranch ||
      String(base?.sha ?? "").toLowerCase() !== input.baseSha.toLowerCase() ||
      typeof found.html_url !== "string"
    ) {
      throw new Error("github_existing_pull_reconciliation_conflict");
    }
    return { branch, headSha: branchSha, url: found.html_url, reconciled: true };
  }

  async createDraft(input: Parameters<DraftPRProvider["createDraft"]>[0]): Promise<DraftPrResult> {
    if (
      `${input.owner}/${input.repository}`.toLowerCase() !==
      this.dependencies.verifiedGrant.repositoryIdentity.toLowerCase()
    ) {
      throw new Error("github_repository_identity_mismatch");
    }
    assertDraftPrEligible({
      ...input.eligibility,
      installationRepositoryIdentity:
        this.dependencies.verifiedGrant.installationRepositoryIdentity,
      repositoryIdentity: this.dependencies.verifiedGrant.repositoryIdentity,
      permissions: this.dependencies.verifiedGrant.permissions,
      baseSha: input.baseSha,
      currentDefaultBranchSha: input.eligibility.currentDefaultBranchSha,
    });
    validateDraftPrFiles(input.changedFiles);
    const owner = encodeURIComponent(input.owner);
    const repository = encodeURIComponent(input.repository);
    const identity = input.identityKey.toLowerCase();
    const branch = deterministicFixBranch(identity);
    const branchRef = `heads/${branch}`;
    const commitMessage = candidateCommitMessage(identity, input.changedFiles);
    const token = await this.dependencies.installationToken();
    const base = await this.request(
      token,
      `/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(input.defaultBranch)}`,
    );
    const baseObject = base.object as Record<string, unknown> | undefined;
    const baseSha = typeof baseObject?.sha === "string" ? baseObject.sha : "";
    if (baseSha.toLowerCase() !== input.baseSha.toLowerCase()) throw new Error("stale_base");

    const baseCommit = await this.request(
      token,
      `/repos/${owner}/${repository}/git/commits/${input.baseSha}`,
    );
    const baseTree = baseCommit.tree as Record<string, unknown> | undefined;
    if (typeof baseTree?.sha !== "string") throw new Error("github_base_tree_unavailable");
    const treeEntries: Array<Record<string, unknown>> = [];
    for (const file of input.changedFiles) {
      if (file.deleted) {
        treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
        continue;
      }
      if (typeof file.content !== "string" || Buffer.byteLength(file.content, "utf8") > 128 * 1024)
        throw new Error("github_patch_file_invalid");
      const blob = await this.request(token, `/repos/${owner}/${repository}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: Buffer.from(file.content, "utf8").toString("base64"),
          encoding: "base64",
        }),
      });
      if (typeof blob.sha !== "string") throw new Error("github_blob_create_failed");
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    if (treeEntries.length === 0) throw new Error("github_empty_patch");
    const tree = await this.request(token, `/repos/${owner}/${repository}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTree.sha, tree: treeEntries }),
    });
    if (typeof tree.sha !== "string") throw new Error("github_tree_create_failed");
    const commit = await this.request(token, `/repos/${owner}/${repository}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: commitMessage,
        tree: tree.sha,
        parents: [input.baseSha],
        author: {
          name: "Auterim",
          email: "fix-engine@auterim.invalid",
          date: "2000-01-01T00:00:00Z",
        },
        committer: {
          name: "Auterim",
          email: "fix-engine@auterim.invalid",
          date: "2000-01-01T00:00:00Z",
        },
      }),
    });
    if (typeof commit.sha !== "string") throw new Error("github_commit_create_failed");
    const branchPath = `/repos/${owner}/${repository}/git/ref/${branchRef
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    let currentBranchSha: string | null = null;
    try {
      const current = await this.request(token, branchPath);
      const object = current.object as Record<string, unknown> | undefined;
      currentBranchSha = typeof object?.sha === "string" ? object.sha : null;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "github_resource_not_found") throw error;
    }
    if (currentBranchSha && currentBranchSha !== commit.sha)
      throw new Error("github_branch_reconciliation_conflict");
    if (!currentBranchSha) {
      try {
        await this.request(token, `/repos/${owner}/${repository}/git/refs`, {
          method: "POST",
          body: JSON.stringify({ ref: `refs/${branchRef}`, sha: commit.sha }),
        });
        currentBranchSha = commit.sha;
      } catch {
        const current = await this.request(token, branchPath);
        const object = current.object as Record<string, unknown> | undefined;
        currentBranchSha = typeof object?.sha === "string" ? object.sha : null;
        if (currentBranchSha !== commit.sha)
          throw new Error("github_branch_reconciliation_conflict");
      }
    }

    const existing = await this.request(
      token,
      `/repos/${owner}/${repository}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${input.owner}:${branch}`)}&base=${encodeURIComponent(input.defaultBranch)}`,
    );
    const existingList = Array.isArray(existing) ? existing : [];
    const existingForBranch = existingList.find(
      (item) =>
        item &&
        typeof item === "object" &&
        ((item as Record<string, unknown>).head as Record<string, unknown> | undefined)?.ref ===
          branch,
    ) as Record<string, unknown> | undefined;
    if (existingForBranch) {
      const existingHead = existingForBranch.head as Record<string, unknown> | undefined;
      const existingBase = existingForBranch.base as Record<string, unknown> | undefined;
      if (
        existingForBranch.state !== "open" ||
        existingForBranch.draft !== true ||
        existingHead?.sha !== commit.sha ||
        existingBase?.ref !== input.defaultBranch ||
        String(existingBase?.sha ?? "").toLowerCase() !== input.baseSha.toLowerCase() ||
        typeof existingForBranch.html_url !== "string"
      ) {
        throw new Error("github_existing_pull_reconciliation_conflict");
      }
      return {
        branch,
        headSha: String(commit.sha),
        url: String(existingForBranch.html_url),
        reconciled: true,
      };
    }
    const reconciled = existingList.find(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as Record<string, unknown>).draft === true &&
        ((item as Record<string, unknown>).head as Record<string, unknown> | undefined)?.sha ===
          commit.sha &&
        ((item as Record<string, unknown>).base as Record<string, unknown> | undefined)?.ref ===
          input.defaultBranch,
    ) as Record<string, unknown> | undefined;
    if (reconciled && typeof reconciled.html_url === "string")
      return { branch, headSha: String(commit.sha), url: reconciled.html_url, reconciled: true };
    let pull: GitHubResponse;
    const reviewLine =
      input.eligibility.reviewDisposition === "review_required"
        ? `\n\nAuterim policy requires human review${/^[a-z0-9_]{1,80}$/.test(input.eligibility.reviewReason ?? "") ? ` (${input.eligibility.reviewReason})` : "."}`
        : "";
    try {
      pull = await this.request(token, `/repos/${owner}/${repository}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: "Auterim proposed compatibility fix",
          body: `Generated from exact evidence at ${input.baseSha}. This is a draft for human review; it has not been merged or deployed.${reviewLine}`,
          head: branch,
          base: input.defaultBranch,
          draft: true,
        }),
      });
    } catch (error) {
      const afterError = await this.request(
        token,
        `/repos/${owner}/${repository}/pulls?state=open&head=${encodeURIComponent(`${input.owner}:${branch}`)}&base=${encodeURIComponent(input.defaultBranch)}`,
      );
      const candidate = Array.isArray(afterError)
        ? afterError.find(
            (item) =>
              item &&
              typeof item === "object" &&
              (item as Record<string, unknown>).draft === true &&
              ((item as Record<string, unknown>).head as Record<string, unknown> | undefined)
                ?.sha === commit.sha,
          )
        : undefined;
      if (candidate && typeof (candidate as Record<string, unknown>).html_url === "string")
        return {
          branch,
          headSha: String(commit.sha),
          url: String((candidate as Record<string, unknown>).html_url),
          reconciled: true,
        };
      if (error instanceof Error && /ambiguous|unavailable/.test(error.message))
        throw new Error("github_draft_pr_ambiguous");
      throw error;
    }
    if (typeof pull.html_url !== "string") throw new Error("github_draft_pr_identity_missing");
    return { branch, headSha: String(commit.sha), url: pull.html_url, reconciled: false };
  }
}
