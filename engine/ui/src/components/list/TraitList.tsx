import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { ago } from "@/format";
import { mergePages, nextPageOffset } from "@/lib/pages";
import { Chip, Count, Empty, Failure, Loading, type ListProps, PagedList, Row } from "./primitives";

export function TraitList({ scope, selected, onSelect }: ListProps) {
  const query = useInfiniteQuery({
    queryKey: ["traits", scope ?? ""],
    queryFn: ({ pageParam, signal }) => api.traits(scope, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, lastOffset) =>
      nextPageOffset(lastOffset, last.rows.length, last.total),
  });

  if (query.isPending) return <Loading label="Cargando los rasgos…" />;
  const rows = mergePages(query.data?.pages.map((page) => page.rows) ?? []);
  // The total comes from the last page so the header and "load more" agree on what is left.
  const total = query.data?.pages.at(-1)?.total ?? 0;
  const remaining = Math.max(0, total - rows.length);

  return (
    <div className="flex flex-col gap-2">
      {query.isError && <Failure what="los rasgos" error={query.error} stale={rows.length > 0} />}
      {rows.length > 0 && (
        <Count>
          {remaining > 0
            ? `${rows.length} de ${total} rasgos · se muestran los más fuertes`
            : `${rows.length} ${rows.length === 1 ? "rasgo" : "rasgos"}`}
        </Count>
      )}
      <PagedList
        rows={rows}
        empty={query.isError ? null : <Empty>Ningún patrón se ha cristalizado como rasgo todavía.</Empty>}
        hasNextPage={query.hasNextPage}
        fetchingNextPage={query.isFetchingNextPage}
        remaining={remaining}
        onLoadMore={() => void query.fetchNextPage()}
        renderRow={(trait) => (
          <Row
            key={trait.id}
            layer="trait"
            active={selected?.layer === "trait" && selected.id === trait.id}
            onClick={() => onSelect({ layer: "trait", id: trait.id })}
            text={trait.text}
            meta={
              <>
                <Chip>{trait.scope}</Chip>
                <Chip brand>fuerza {trait.strength}</Chip>
                {trait.polarity !== "neutral" && <Chip>{trait.polarity}</Chip>}
                <Chip>{ago(trait.updated_at)}</Chip>
              </>
            }
          />
        )}
      />
    </div>
  );
}
