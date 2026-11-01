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

/**
 * Whether merging dropped a row: a write shifts the window under offset paging, the repeated row
 * shrinks the unique count, and the raw offset is already at the total, so the missing row cannot
 * be reached by loading further.
 */
export function pagesLostRows(pages: ReadonlyArray<ReadonlyArray<{ id: string }>>): boolean {
  const raw = pages.reduce((sum, page) => sum + page.length, 0);
  return mergePages(pages).length < raw;
}

/**
 * The offset of the next page, or nothing once the loaded rows reach the total. A short page
 * still continues while rows remain, because the total is the authority on what is left; an
 * empty one stops, or a delete between the count and the read would ask for the same page again.
 */
export function nextPageOffset(lastOffset: number, loaded: number, total: number): number | undefined {
  return loaded > 0 && lastOffset + loaded < total ? lastOffset + loaded : undefined;
}
