import type { DiscoveryObservation, ScanDiff, ScanResult } from "./types.js";

function comparable(observation: DiscoveryObservation) {
  return JSON.stringify({
    evidenceFamily: observation.evidenceFamily,
    normalizedIdentifier: observation.normalizedIdentifier,
    providerCandidate: observation.providerCandidate,
    confidence: observation.confidence,
    reasonCode: observation.reasonCode,
    safeRelativePath: observation.safeRelativePath,
    subproject: observation.subproject,
    metadata: observation.metadata,
  });
}

export function compareScans(previous: ScanResult, current: ScanResult): ScanDiff {
  const before = new Map(previous.observations.map((item) => [item.id, item]));
  const after = new Map(current.observations.map((item) => [item.id, item]));
  const added: DiscoveryObservation[] = [];
  const removed: DiscoveryObservation[] = [];
  const changed: ScanDiff["changed"] = [];
  let unchanged = 0;
  for (const [id, item] of after) {
    const prior = before.get(id);
    if (!prior) added.push(item);
    else if (comparable(prior) !== comparable(item))
      changed.push({ previous: prior, current: item });
    else unchanged += 1;
  }
  for (const [id, item] of before) if (!after.has(id)) removed.push(item);
  const sort = (left: DiscoveryObservation, right: DiscoveryObservation) =>
    left.evidenceFamily.localeCompare(right.evidenceFamily) ||
    left.normalizedIdentifier.localeCompare(right.normalizedIdentifier) ||
    (left.safeRelativePath ?? "").localeCompare(right.safeRelativePath ?? "") ||
    left.id.localeCompare(right.id);
  added.sort(sort);
  removed.sort(sort);
  changed.sort((left, right) => sort(left.current, right.current));
  return { added, removed, changed, unchanged };
}

export function renderReview(result: ScanResult): string {
  const providers = new Map<string, { name: string; count: number; confidence: number }>();
  const unknown = new Map<string, number>();
  const envNames: string[] = [];
  const frameworks = new Set<string>();
  const frameworkIdentifiers = new Set(
    result.observations
      .filter((item) => item.evidenceFamily === "framework_runtime")
      .map((item) => item.normalizedIdentifier),
  );
  const runtimes = new Set<string>();
  const packageManagers = new Set<string>();
  const subprojects = new Set<string>();
  for (const item of result.observations) {
    const candidate = item.providerCandidate;
    if (candidate.status === "known" && candidate.providerSlug && candidate.providerName) {
      const current = providers.get(candidate.providerSlug) ?? {
        name: candidate.providerName,
        count: 0,
        confidence: 0,
      };
      current.count += 1;
      current.confidence = Math.max(current.confidence, item.confidence);
      providers.set(candidate.providerSlug, current);
    } else if (
      item.evidenceFamily === "package_manifest" &&
      !frameworkIdentifiers.has(item.normalizedIdentifier)
    ) {
      unknown.set(item.normalizedIdentifier, (unknown.get(item.normalizedIdentifier) ?? 0) + 1);
    }
    if (item.evidenceFamily === "environment_variable_name")
      envNames.push(item.normalizedIdentifier);
    if (item.evidenceFamily === "framework_runtime") {
      if (item.metadata.configKind && item.metadata.configKind !== "runtime")
        frameworks.add(item.metadata.configKind);
      if (item.metadata.runtimeName && item.metadata.runtimeName !== "unknown")
        runtimes.add(item.metadata.runtimeName);
    }
    if (item.evidenceFamily === "lockfile_identity") {
      const manager = packageManagerName(item.normalizedIdentifier);
      if (manager) packageManagers.add(manager);
    }
    if (item.subproject) subprojects.add(item.subproject);
  }

  const lines = [
    `Local dependency review: ${result.projectSummary.rootName}`,
    `Status: ${result.status}${result.stats.truncated ? ` (partial: ${result.stats.partialReasons.join(", ")})` : ""}`,
    `Evidence: ${result.observations.length} observations across ${result.stats.manifestsParsed} manifests and ${result.stats.sourceFilesInspected} source files.`,
    `Traversal: ${result.stats.filesVisited} files visited; ${result.stats.ignoredDirectories} directories ignored; ${result.stats.ignoredSensitiveFiles} sensitive files and ${result.stats.ignoredSensitiveDirectories} sensitive directories skipped; ${result.stats.symlinksSkipped} symlinks skipped.`,
    "",
    "Recognized providers:",
  ];
  if (providers.size === 0) lines.push("  None recognized");
  else {
    for (const [slug, value] of [...providers].sort((left, right) =>
      left[1].name.localeCompare(right[1].name),
    )) {
      lines.push(
        `  ${value.name} (${slug}) — ${value.count} signals, confidence up to ${Math.round(value.confidence * 100)}%`,
      );
    }
  }
  if (packageManagers.size > 0)
    lines.push("", `Package managers: ${[...packageManagers].sort().join(", ")}`);
  if (frameworks.size > 0) lines.push(`Frameworks: ${[...frameworks].sort().join(", ")}`);
  if (runtimes.size > 0) lines.push(`Runtimes: ${[...runtimes].sort().join(", ")}`);
  if (subprojects.size > 0) {
    const listed = [...subprojects].sort().slice(0, 10);
    lines.push(
      `Subprojects: ${listed.join(", ")}${subprojects.size > 10 ? `, +${subprojects.size - 10} more` : ""}`,
    );
  }
  if (unknown.size > 0) {
    lines.push("", `Unmapped direct package names: ${unknown.size}`);
    for (const name of [...unknown.keys()].sort().slice(0, 20)) lines.push(`  ${name}`);
    if (unknown.size > 20) lines.push(`  … and ${unknown.size - 20} more`);
  }
  if (envNames.length > 0) {
    const uniqueNames = [...new Set(envNames)].sort();
    lines.push("", `Environment variable names only: ${uniqueNames.join(", ")}`);
  }
  const git = result.projectSummary.git;
  if (git.host || git.owner || git.repository) {
    lines.push(
      "",
      `Git origin: ${[git.host, git.owner && git.repository ? `${git.owner}/${git.repository}` : null].filter(Boolean).join(" / ")}`,
    );
  }
  lines.push(
    "",
    "Connected submission may include the project folder name, safe relative paths, and sanitized Git remote identity.",
    "Source files, environment values, and credentials are not included. Review these derived fields before consent.",
  );
  return lines.join("\n");
}

function packageManagerName(lockfile: string) {
  if (lockfile === "package-lock.json") return "npm";
  if (lockfile === "pnpm-lock.yaml") return "pnpm";
  if (lockfile === "yarn.lock") return "yarn";
  if (lockfile === "bun.lock" || lockfile === "bun.lockb") return "bun";
  if (lockfile === "poetry.lock") return "Poetry";
  if (lockfile === "uv.lock") return "uv";
  if (lockfile === "pipfile.lock") return "Pipenv";
  if (lockfile === "go.sum") return "Go modules";
  if (lockfile === "cargo.lock") return "Cargo";
  if (lockfile === "composer.lock") return "Composer";
  if (lockfile === "gemfile.lock") return "Bundler";
  return null;
}
