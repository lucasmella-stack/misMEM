/**
 * La cabecera de resultados avisa cuando la lista se corta en el tope: sin eso, "no está"
 * y "está más abajo" se ven igual. Es una vista aparte para probar el aviso sin los hooks
 * de la consulta.
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
  return (
    <div className="mb-2 flex flex-col gap-1 text-xs">
      <p className="text-ink-muted">
        Resultados para <q className="text-ink-soft">{term}</q>
        {scope ? ` en ${scope}` : ""}
        {fetching ? " · buscando…" : ""}
      </p>
      {truncated && (
        <p role="status" className="text-ink-soft">
          {`${count} resultados, puede haber más: afina la consulta o elige un ámbito`}
        </p>
      )}
    </div>
  );
}
