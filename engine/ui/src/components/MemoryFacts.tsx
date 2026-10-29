// Presentational half of the memory detail: it takes plain data so tests can render it without
// a query client. The active model only decides whether the stored vector is still searchable.
import { when } from "../format";
import { embeddingSummary } from "../lib/embeddings";

export function MemoryFacts({
  memory,
  activeModel,
}: {
  memory: {
    scope: string;
    created_at: number;
    last_accessed_at: number | null;
    use_count: number;
    embedding: { model: string; dims: number; created_at: number } | null;
  };
  activeModel?: string;
}) {
  return (
    <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-ink-muted">Ámbito</dt>
      <dd className="text-ink-soft">{memory.scope}</dd>
      <dt className="text-ink-muted">Consolidada</dt>
      <dd className="text-ink-soft">{when(memory.created_at)}</dd>
      <dt className="text-ink-muted">Último uso</dt>
      <dd className="text-ink-soft">{when(memory.last_accessed_at)}</dd>
      <dt className="text-ink-muted">Usos</dt>
      <dd className="text-ink-soft">{memory.use_count}</dd>
      <dt className="text-ink-muted">Vector</dt>
      <dd className="text-ink-soft">{embeddingSummary(memory.embedding, undefined, activeModel)}</dd>
    </dl>
  );
}
