/**
 * The results header says the list was cut at the cap: "not there" and "further down" look alike.
 */
export function SearchHeader({
  term,
  scope,
  count,
  truncated,
  fetching,
}: {
  term: string;
  scope?: string;
  count: number;
  truncated: boolean;
  fetching: boolean;
}) {
  // With a scope already chosen, "pick one" is advice the person cannot follow.
  const advice = scope
    ? "afina la consulta o busca en toda la memoria"
    : "afina la consulta o elige un ámbito";
  return (
    <div className="mb-2 flex flex-col gap-1 text-xs">
      <p className="text-ink-muted">
        Resultados para <q className="text-ink-soft">{term}</q>
        {scope ? ` en ${scope}` : ""}
        {fetching ? " · buscando…" : ""}
      </p>
      {/* Always mounted: a live region has to exist before its content changes to be announced. */}
      <p role="status" aria-live="polite" className={truncated ? "text-ink-soft" : undefined}>
        {truncated ? `${count} resultados, puede haber más: ${advice}` : null}
      </p>
    </div>
  );
}
