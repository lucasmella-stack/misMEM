import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { m } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { api, type Layer, type SearchHit } from "../api";
import type { Selection } from "../App";
import { ago, percent } from "../format";
import { errorMessage } from "../lib/errors";
import { inkPercent } from "../lib/ink";
import { mergePages, nextPageOffset } from "../lib/pages";
import { SearchHeader } from "./SearchHeader";

interface ListProps {
  scope: string | undefined;
  selected: Selection | undefined;
  onSelect: (selection: Selection) => void;
}

/** Selección para cristalizar: id → ámbito, para exigir que sean del mismo. */
export type Picked = ReadonlyMap<string, string>;

const LAYER_NAME: Record<Layer, string> = { episode: "episodio", memory: "memoria", trait: "rasgo" };

/**
 * La tinta mezcla `ink` con `ink-muted`: el mínimo (0 %) sigue pasando AA, así que
 * una memoria vieja se aclara sin volverse ilegible.
 */
const tint = (salience: number): string =>
  `color-mix(in oklab, var(--color-ink) ${inkPercent(salience)}%, var(--color-ink-muted))`;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function Chip({ children, brand }: { children: ReactNode; brand?: boolean }) {
  return (
    <span className={cn("rounded-full bg-field px-2 py-0.5", brand ? "text-brand-text" : "text-ink-muted")}>{children}</span>
  );
}

function Row({
  layer,
  active,
  salience,
  onClick,
  text,
  meta,
  pick,
}: {
  layer: Layer;
  active: boolean;
  salience?: number;
  onClick: () => void;
  text: string;
  meta: ReactNode;
  pick?: { checked: boolean; onChange: () => void };
}) {
  return (
    <li className="flex items-start gap-2">
      {pick && (
        <input
          type="checkbox"
          className="mt-3 size-4 shrink-0 accent-[var(--color-brand)]"
          checked={pick.checked}
          onChange={pick.onChange}
          aria-label={`Seleccionar: ${text.slice(0, 80)}`}
        />
      )}
      <m.button
        type="button"
        onClick={onClick}
        whileTap={{ scale: 0.99 }}
        aria-current={active ? "true" : undefined}
        data-layer={layer}
        className={cn(
          "flex-1 rounded-lg border bg-surface-raised px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
          active ? "border-brand ring-1 ring-brand" : "border-edge hover:border-ink-faint",
        )}
      >
        <span
          className="block text-sm leading-relaxed"
          style={salience === undefined ? undefined : { color: tint(salience) }}
        >
          {text}
        </span>
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">{meta}</span>
      </m.button>
    </li>
  );
}

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5", "s6"];

function Loading({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <span role="status" className="sr-only">
        {label}
      </span>
      {SKELETON_ROWS.map((key) => (
        <Skeleton key={key} className="h-16 w-full bg-surface-raised" />
      ))}
    </div>
  );
}

/** Un fallo de recarga no borra lo que ya se veía: avisa encima y deja la lista. */
function Failure({ what, error, stale }: { what: string; error: unknown; stale: boolean }) {
  if (stale) {
    return (
      <p role="status" className="mb-2 rounded-md bg-field px-2 py-1.5 text-xs text-ink-muted">
        No se pudo actualizar {what}: {errorMessage(error)}. Se muestra lo último que llegó.
      </p>
    );
  }
  return (
    <p role="alert" className="rounded-md bg-field px-2 py-2 text-sm text-danger">
      No se pudo cargar {what}: {errorMessage(error)}
    </p>
  );
}

function Count({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs text-ink-muted">{children}</p>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-sm text-ink-muted">{children}</p>;
}

function LoadMore({
  remaining,
  busy,
  onClick,
}: {
  remaining: number;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      className="mt-1 w-full"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
    >
      {busy ? "Cargando…" : `Cargar más (${remaining})`}
    </Button>
  );
}

/** The row list and its paging footer are the same in both infinite lists. */
function PagedList<T>({
  rows,
  empty,
  hasNextPage,
  fetchingNextPage,
  remaining,
  onLoadMore,
  renderRow,
}: {
  rows: readonly T[];
  empty: ReactNode;
  hasNextPage: boolean;
  fetchingNextPage: boolean;
  remaining: number;
  onLoadMore: () => void;
  renderRow: (row: T) => ReactNode;
}) {
  return (
    <>
      {/* The load-more footer stays outside the empty check, as it was before the extraction. */}
      {rows.length === 0 ? empty : <ul className="flex flex-col gap-2">{rows.map(renderRow)}</ul>}
      {hasNextPage && <LoadMore remaining={remaining} busy={fetchingNextPage} onClick={onLoadMore} />}
    </>
  );
}

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

export function PendingList({ scope, selected, onSelect }: ListProps) {
  const query = useInfiniteQuery({
    queryKey: ["pending", scope ?? ""],
    queryFn: ({ pageParam, signal }) => api.pendingEpisodes(scope, pageParam, signal),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, lastOffset) =>
      nextPageOffset(lastOffset, last.rows.length, last.total),
  });

  if (query.isPending) return <Loading label="Cargando los episodios sin consolidar…" />;
  const rows = mergePages(query.data?.pages.map((page) => page.rows) ?? []);
  // The total comes from the last page so the header and "load more" agree on what is left.
  const total = query.data?.pages.at(-1)?.total ?? 0;
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

export function SearchResults({ term, scope, selected, onSelect }: ListProps & { term: string }) {
  const trimmed = term.trim();
  const query = useQuery({
    queryKey: ["search", scope ?? "", trimmed],
    queryFn: ({ signal }) => api.search(trimmed, scope, signal),
    enabled: trimmed.length > 0,
    // Al afinar la consulta se conserva la lista anterior mientras llega la nueva, pero
    // cambiar de ámbito no puede enseñar los hits del anterior bajo la cabecera nueva.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === (scope ?? "") ? previous : undefined,
  });

  if (!trimmed) {
    return <Empty>Escribe en la caja de búsqueda para recorrer toda la memoria.</Empty>;
  }
  if (query.isPending) return <Loading label="Buscando en la memoria…" />;
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

/** Un episodio llega con su texto en el hit; el detalle no tiene otra forma de pedirlo. */
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
