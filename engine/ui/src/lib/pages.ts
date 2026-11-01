// Owns page concatenation without repeated rows: offset paging under a whole-cache invalidation
// makes a write shift rows, so the last row of one page can reappear on the next. The first
// order wins because that page is what the person was already reading.
export function mergePages<T extends { id: string }>(pages: ReadonlyArray<ReadonlyArray<T>>): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const row of page) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  return merged;
}
