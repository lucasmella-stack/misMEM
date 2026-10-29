// The semantic index only speaks up when it needs a reindex: a healthy or disabled index
// stays silent, and a failed lookup must never get in the way of the rest of the viewer.
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { embeddingWarning } from "../lib/embeddings";
import { EmbeddingNoticeView } from "./EmbeddingNoticeView";

export function EmbeddingNotice() {
  const query = useQuery({
    queryKey: ["embeddings"],
    queryFn: ({ signal }) => api.embeddings(signal),
    staleTime: 60_000,
  });
  return <EmbeddingNoticeView message={embeddingWarning(query.data)} />;
}
