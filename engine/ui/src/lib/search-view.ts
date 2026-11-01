/** The views of the main panel. They live here so the search logic does not depend on React. */
export type View = "memories" | "traits" | "topics" | "pending" | "results" | "graph";

/**
 * Where the search box text leads. In the graph the text filters locally and instantly: jumping
 * to Results would unmount the view being looked at. With no text nobody moves, because clearing
 * the search must not change tab.
 */
export function viewAfterQuery(current: View, query: string): View {
  if (!query.trim()) return current;
  return current === "graph" ? "graph" : "results";
}
