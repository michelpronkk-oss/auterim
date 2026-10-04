export function hasUnresolvedDiscoveryCandidates(
  candidates: ReadonlyArray<{ suggestedStatus: string }>,
): boolean {
  return candidates.some((candidate) => candidate.suggestedStatus === "candidate");
}
