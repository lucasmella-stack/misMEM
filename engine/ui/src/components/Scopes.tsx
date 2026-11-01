import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ScopeCount } from "../api";
import { errorMessage } from "../lib/errors";

interface Props {
  scopes: ScopeCount[] | undefined;
  isPending: boolean;
  error: unknown;
  current: string | undefined;
  onChange: (scope: string | undefined) => void;
}

const SKELETON_ROWS = ["s1", "s2", "s3", "s4", "s5"];

/**
 * On wide screens it is a column; below that, a row that scrolls. A dropdown hid the scopes,
 * which is exactly what one comes here to see.
 */

export function Scopes({ scopes, isPending, error, current, onChange }: Props) {
  const list = scopes ?? [];
  const total = list.reduce((n, s) => n + s.memories, 0);

  if (isPending) {
    return (
      <div aria-busy="true" className="flex gap-1.5 p-2 lg:flex-col lg:p-3">
        <span role="status" className="sr-only">
          Cargando los ámbitos…
        </span>
        {SKELETON_ROWS.map((key) => (
          <Skeleton key={key} className="h-8 w-28 shrink-0 bg-field lg:w-full" />
        ))}
      </div>
    );
  }

  return (
    <div className="p-2 lg:p-3">
      {error !== undefined && error !== null && (
        <p role="status" className="mb-2 rounded-md bg-field px-2 py-1.5 text-xs text-ink-muted">
          {scopes === undefined
            ? `No se pudieron cargar los ámbitos: ${errorMessage(error)}.`
            : `No se pudieron actualizar los ámbitos: ${errorMessage(error)}. Se muestra lo último que llegó.`}
        </p>
      )}
      <ul aria-label="Ámbitos" className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
        <li className="shrink-0">
          <button
            type="button"
            aria-current={current === undefined ? "true" : undefined}
            onClick={() => onChange(undefined)}
            className={scopeClass(current === undefined)}
          >
            <span className="truncate">Toda la memoria</span>
            <span className="text-xs tabular-nums text-ink-muted">{scopes === undefined ? "…" : total}</span>
          </button>
        </li>
        {list.map((scope) => (
          <li key={scope.scope} className="shrink-0">
            <button
              type="button"
              aria-current={current === scope.scope ? "true" : undefined}
              onClick={() => onChange(scope.scope)}
              title={`${scope.memories} memorias, ${scope.traits} rasgos, ${scope.episodes_pending} episodios sin consolidar`}
              className={scopeClass(current === scope.scope)}
            >
              <span className="max-w-[14rem] truncate lg:max-w-none">{scope.scope}</span>
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-xs tabular-nums text-ink-muted">{scope.memories}</span>
                {scope.episodes_pending > 0 && (
                  <span className="rounded-full bg-brand/15 px-1.5 text-[11px] text-brand-text" aria-hidden="true">
                    +{scope.episodes_pending}
                  </span>
                )}
                {scope.episodes_pending > 0 && (
                  <span className="sr-only">{scope.episodes_pending} sin consolidar</span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function scopeClass(selected: boolean): string {
  return cn(
    "flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60",
    selected
      ? "border-brand bg-surface-raised text-ink"
      : "border-edge bg-surface-raised text-ink-soft hover:border-ink-faint lg:border-transparent lg:bg-transparent",
  );
}
