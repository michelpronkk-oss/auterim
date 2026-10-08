export type WorkspaceOption = {
  workspaceId: string;
  name: string;
  role: string;
  active: boolean;
  selectorLabel: string;
};

type WorkspaceOptionInput = Omit<WorkspaceOption, "selectorLabel">;

/** Keeps each authorized workspace ID once and makes identical names distinguishable. */
export function normalizeWorkspaceOptions(options: WorkspaceOptionInput[]): WorkspaceOption[] {
  const uniqueById = new Map<string, WorkspaceOptionInput>();
  for (const option of options) {
    if (!uniqueById.has(option.workspaceId)) uniqueById.set(option.workspaceId, option);
  }

  const unique = [...uniqueById.values()];
  const nameCounts = new Map<string, number>();
  for (const option of unique) {
    const key = option.name.trim().toLowerCase();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }

  return unique.map((option) => {
    const name = option.name.trim() || "Workspace";
    const nameKey = name.toLowerCase();
    const hasDuplicateName = (nameCounts.get(nameKey) ?? 0) > 1;
    const duplicateIds = hasDuplicateName
      ? unique
          .filter((candidate) => candidate.name.trim().toLowerCase() === nameKey)
          .map((candidate) => candidate.workspaceId)
      : [];
    let idPrefixLength = 8;
    while (
      hasDuplicateName &&
      duplicateIds.some(
        (id) =>
          id !== option.workspaceId &&
          id.slice(0, idPrefixLength) === option.workspaceId.slice(0, idPrefixLength),
      ) &&
      idPrefixLength < option.workspaceId.length
    ) {
      idPrefixLength = Math.min(option.workspaceId.length, idPrefixLength + 4);
    }
    return {
      ...option,
      name,
      selectorLabel: hasDuplicateName
        ? `${name} · ${option.workspaceId.slice(0, idPrefixLength)}`
        : name,
    };
  });
}

/** Restores a selected ID only while it remains in the caller's authorized options. */
export function resolveSelectedWorkspaceId(
  options: Array<Pick<WorkspaceOption, "workspaceId" | "active">>,
  preferredId: string | null | undefined,
): string {
  if (preferredId && options.some((option) => option.workspaceId === preferredId))
    return preferredId;
  return options.find((option) => option.active)?.workspaceId ?? options[0]?.workspaceId ?? "";
}
