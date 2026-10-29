// The semantic index only speaks up when it needs a reindex: a healthy or disabled index
// stays silent, and a failed lookup must never get in the way of the rest of the viewer.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { embeddingWarning } from "../lib/embeddings";

export function EmbeddingNotice() {
  const query = useQuery({
    queryKey: ["embeddings"],
    queryFn: ({ signal }) => api.embeddings(signal),
    staleTime: 60_000,
  });
  const message = embeddingWarning(query.data);
  if (!message) return null;

  return (
    <p
      role="status"
      className="border-b border-edge bg-field px-3 py-1.5 text-xs text-ink-soft sm:px-4"
    >
      {message}
    </p>
  );
}
