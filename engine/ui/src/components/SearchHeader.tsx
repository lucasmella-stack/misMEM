/**
 * The results header warns when the list is cut at the cap: without it, "not there" and
 * "further down" look the same. It is a separate view so the warning can be tested
 * without the query hooks.
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
      {truncated && (
        <p role="status" className="text-ink-soft">
          {`${count} resultados, puede haber más: ${advice}`}
        </p>
      )}
    </div>
  );
}
