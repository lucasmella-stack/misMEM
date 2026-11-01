import { m } from "motion/react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { Layer } from "@/api";
import { inkPercent } from "@/lib/ink";
import type { Selection } from "@/lib/selection";
import { errorMessage } from "@/lib/errors";

export interface ListProps {
  scope: string | undefined;
  selected: Selection | undefined;
  onSelect: (selection: Selection) => void;
}

/** Selection for crystallizing: id → scope, so they can be required to share one. */
export type Picked = ReadonlyMap<string, string>;

/**
 * The tint mixes `ink` with `ink-muted`: the floor (0 %) still passes AA, so an old memory
 * fades without becoming unreadable.
 */
const tint = (salience: number): string =>
  `color-mix(in oklab, var(--color-ink) ${inkPercent(salience)}%, var(--color-ink-muted))`;

export function Chip({ children, brand }: { children: ReactNode; brand?: boolean }) {
  return (
    <span className={cn("rounded-full bg-field px-2 py-0.5", brand ? "text-brand-text" : "text-ink-muted")}>{children}</span>
  );
}

export function Row({
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

export function Loading({ label }: { label: string }) {
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

/** A refetch failure does not erase what was already shown: it warns above and leaves the list. */
export function Failure({ what, error, stale }: { what: string; error: unknown; stale: boolean }) {
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

export function Count({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-xs text-ink-muted">{children}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
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
export function PagedList<T>({
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
      {/* The load-more footer stays outside the empty check so it still shows when no row did. */}
      {rows.length === 0 ? empty : <ul className="flex flex-col gap-2">{rows.map(renderRow)}</ul>}
      {hasNextPage && <LoadMore remaining={remaining} busy={fetchingNextPage} onClick={onLoadMore} />}
    </>
  );
}
