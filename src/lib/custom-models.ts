// Custom picker: search the live inject list, and pin models the host
// already has in memory so the user can pick them without scrolling.

export function filterCustomModels<T extends { id: string; label: string }>(
  options: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter(
    (option) => option.label.toLowerCase().includes(needle) || option.id.toLowerCase().includes(needle),
  );
}

export function partitionCustomModels<T extends { id: string; loaded?: boolean }>(
  options: readonly T[],
): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const option of options) {
    if (option.loaded) pinned.push(option);
    else rest.push(option);
  }
  return { pinned, rest };
}
