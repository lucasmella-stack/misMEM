import { useQuery } from "@tanstack/react-query";
import { api, type Layer, type SearchHit } from "@/api";
import { SearchHeader } from "@/components/SearchHeader";
import { ago } from "@/format";
import { cn } from "@/lib/utils";
import type { Selection } from "@/lib/selection";
import { Chip, Empty, Failure, Loading, type ListProps, Row } from "./primitives";

const LAYER_NAME: Record<Layer, string> = { episode: "episodio", memory: "memoria", trait: "rasgo" };

export function SearchResults({ term, scope, selected, onSelect }: ListProps & { term: string }) {
  const trimmed = term.trim();
  const query = useQuery({
    queryKey: ["search", scope ?? "", trimmed],
    queryFn: ({ signal }) => api.search(trimmed, scope, signal),
    enabled: trimmed.length > 0,
    // Refining the query keeps the previous list while the new one arrives, but switching scope
    // cannot show the previous scope's hits under the new header.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (scope ?? "") ? previous : undefined,
  });

  if (!trimmed) {
    return <Empty>Escribe en la caja de búsqueda para recorrer toda la memoria.</Empty>;
  }
  // The header, and its live region, sit first in the same wrapper while loading and after, so React
  // keeps that node and a screen reader announces the cap notice when it appears.
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-2">
        <SearchHeader term={trimmed} scope={scope} count={0} truncated={false} fetching />
        <Loading label="Buscando en la memoria…" />
      </div>
    );
  }
  const hits = query.data?.hits ?? [];

  return (
    <div className="flex flex-col gap-2">
      <SearchHeader
        term={trimmed}
        scope={scope}
        count={hits.length}
        truncated={query.data?.truncated ?? false}
        fetching={query.isFetching}
      />
      {query.isError && <Failure what="los resultados" error={query.error} stale={hits.length > 0} />}
      {hits.length === 0 ? (
        query.isError ? null : <Empty>Nada coincide. Prueba con otras palabras o en toda la memoria.</Empty>
      ) : (
        <ul className={cn("flex flex-col gap-2 transition-opacity", query.isFetching && "opacity-70")}>
          {hits.map((hit) => (
            <Row
              key={`${hit.layer}-${hit.id}`}
              layer={hit.layer}
              active={selected?.layer === hit.layer && selected.id === hit.id}
              salience={hit.layer === "memory" ? hit.salience : undefined}
              onClick={() => onSelect(selectionOf(hit))}
              text={hit.text}
              meta={
                <>
                  <Chip brand={hit.layer === "trait"}>{LAYER_NAME[hit.layer]}</Chip>
                  <Chip>{hit.scope}</Chip>
                  <Chip>{ago(hit.created_at)}</Chip>
                  {hit.via === "semantic" && <Chip>por significado</Chip>}
                </>
              }
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** An episode arrives with its text in the hit; the detail has no other way to ask for it. */
function selectionOf(hit: SearchHit): Selection {
  if (hit.layer === "episode") {
    return {
      layer: "episode",
      id: hit.id,
      episode: { id: hit.id, scope: hit.scope, text: hit.text, created_at: hit.created_at },
    };
  }
  return { layer: hit.layer, id: hit.id };
}
