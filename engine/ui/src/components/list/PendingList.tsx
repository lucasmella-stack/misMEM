import { useInfiniteQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { ago } from "@/format";
import { mergePages } from "@/lib/pages";
import { Chip, Count, Empty, Failure, Loading, type ListProps, PagedList, Row } from "./primitives";

export function PendingList({ scope, selected, onSelect }: ListProps) {
  const query = useInfiniteQuery({
    queryKey: ["pending", scope ?? ""],
    queryFn: ({ pageParam, signal }) => api.pendingEpisodes(scope, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, lastOffset) =>
      lastOffset + last.rows.length < last.total ? lastOffset + last.rows.length : undefined,
  });

  if (query.isPending) return <Loading label="Cargando los episodios sin consolidar…" />;
  const rows = mergePages(query.data?.pages.map((page) => page.rows) ?? []);
  const total = query.data?.pages[0]?.total ?? 0;
  const remaining = Math.max(0, total - rows.length);

  return (
    <div className="flex flex-col gap-2">
      {query.isError && <Failure what="los pendientes" error={query.error} stale={rows.length > 0} />}
      {rows.length > 0 && <Count>{`${rows.length} de ${total} episodios sin consolidar`}</Count>}
      <PagedList
        rows={rows}
        empty={query.isError ? null : <Empty>Nada pendiente: todo lo capturado ya pasó por la consolidación.</Empty>}
        hasNextPage={query.hasNextPage}
        fetchingNextPage={query.isFetchingNextPage}
        remaining={remaining}
        onLoadMore={() => void query.fetchNextPage()}
        renderRow={(episode) => (
          <Row
            key={episode.id}
            layer="episode"
            active={selected?.layer === "episode" && selected.id === episode.id}
            onClick={() => onSelect({ layer: "episode", id: episode.id, episode })}
            text={episode.text}
            meta={
              <>
                <Chip>{episode.scope}</Chip>
                <Chip>{ago(episode.created_at)}</Chip>
              </>
            }
          />
        )}
      />
    </div>
  );
}
