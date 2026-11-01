import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/api";
import { ago, percent } from "@/format";
import { mergePages, nextPageOffset } from "@/lib/pages";
import { Chip, Empty, Failure, Loading, type ListProps, PagedList, type Picked, Row } from "./primitives";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function MemoryList({
  scope,
  selected,
  onSelect,
  picked,
  onPick,
  picking,
  onTogglePicking,
}: ListProps & {
  picked?: Picked;
  onPick?: (id: string, scope: string) => void;
  picking?: boolean;
  onTogglePicking?: () => void;
}) {
  const query = useInfiniteQuery({
    queryKey: ["memories", scope ?? ""],
    queryFn: ({ pageParam, signal }) => api.memories(scope, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, lastOffset) =>
      nextPageOffset(lastOffset, last.memories.length, last.total),
  });

  if (query.isPending) return <Loading label="Cargando las memorias…" />;
  const rows = mergePages(query.data?.pages.map((page) => page.memories) ?? []);
  // The total comes from the last page so the header and "load more" agree on what is left.
  const total = query.data?.pages.at(-1)?.total ?? 0;
  const remaining = Math.max(0, total - rows.length);

  return (
    <div className="flex flex-col gap-2">
      {query.isError && <Failure what="las memorias" error={query.error} stale={rows.length > 0} />}
      {rows.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-ink-muted">
            {`${rows.length} de ${total} memorias`}
            <span className="hidden sm:inline"> · por saliencia de hoy</span>
          </p>
          {onTogglePicking && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="shrink-0"
              aria-pressed={picking}
              onClick={onTogglePicking}
            >
              {picking ? "Terminar selección" : "Seleccionar"}
            </Button>
          )}
        </div>
      )}
      <PagedList
        rows={rows}
        empty={query.isError ? null : <Empty>Todavía no hay memorias consolidadas en este ámbito.</Empty>}
        hasNextPage={query.hasNextPage}
        fetchingNextPage={query.isFetchingNextPage}
        remaining={remaining}
        onLoadMore={() => void query.fetchNextPage()}
        renderRow={(memory) => (
          <Row
            key={memory.id}
            layer="memory"
            active={selected?.layer === "memory" && selected.id === memory.id}
            salience={memory.salience}
            onClick={() => onSelect({ layer: "memory", id: memory.id })}
            pick={
              picked && onPick ? { checked: picked.has(memory.id), onChange: () => onPick(memory.id, memory.scope) } : undefined
            }
            text={memory.text}
            meta={
              <>
                <Chip>{memory.scope}</Chip>
                <Chip>{ago(memory.created_at)}</Chip>
                <Chip>{plural(memory.sources ?? 0, "fuente", "fuentes")}</Chip>
                {(memory.traits ?? 0) > 0 && (
                  <Chip brand>{plural(memory.traits ?? 0, "rasgo la cita", "rasgos la citan")}</Chip>
                )}
                <Chip>{percent(memory.salience)}</Chip>
              </>
            }
          />
        )}
      />
    </div>
  );
}
