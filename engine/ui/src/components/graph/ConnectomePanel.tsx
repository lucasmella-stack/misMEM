import type { ConnectomeSummary } from "../../api";
import { PANEL_MAX_HUBS, THIN_SAMPLE_TURNS, hubGlow } from "../../lib/graph";

interface Props {
  summary: ConnectomeSummary;
  /** Label per node id: a hub shown as a ULID tells nobody anything. */
  labels: Map<string, string>;
  /**
   * The same reference the canvas normalizes against, and the same set it draws. Measured
   * once outside: two maxima gave one node a full halo here and a dim dot there.
   */
  maxHubStrength: number;
  drawn: ReadonlySet<string>;
  onSelect: (id: string) => void;
}

/**
 * The side of the connectome view: how big the sample is and which memories are worth entering
 * through. It leads with the sample because with few turns every figure below it is noise.
 */
export function ConnectomePanel({ summary, labels, maxHubStrength, drawn, onSelect }: Props) {
  // Turns alone never dilute the degeneracy: NPMI scores a pair seen once at the maximum no
  // matter how long the sample runs. What tells evidence from coincidence is a pair repeating.
  const thin = summary.max_n < 2 || summary.turns < THIN_SAMPLE_TURNS;
  // Offering a way in that is not on screen sends the camera after a node nobody drew.
  const visibles = summary.hubs.filter((hub) => drawn.has(hub.id));

  return (
    <aside className="absolute top-3 right-3 z-10 flex max-h-[calc(100%-1.5rem)] w-[min(16rem,calc(100%-1.5rem))] flex-col gap-2 overflow-y-auto rounded-lg border border-edge bg-surface-raised/95 px-3 py-2 text-xs shadow-lg backdrop-blur-sm">
      <h2 className="font-semibold text-ink-soft">Conectoma</h2>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-ink-muted">
        <dt>Turnos medidos</dt>
        <dd className="text-right tabular-nums text-ink-soft">{summary.turns}</dd>
        <dt>Pares</dt>
        <dd className="text-right tabular-nums text-ink-soft">
          {summary.shown} de {summary.pairs}
        </dd>
        <dt>Soporte mínimo</dt>
        <dd className="text-right tabular-nums text-ink-soft">{summary.min_n}</dd>
      </dl>

      {thin && (
        <p className="rounded-md border border-edge px-2 py-1.5 text-ink-muted">
          {summary.max_n < 2
            ? "Ningún par se repitió todavía: dos recuerdos usados una vez, esa vez juntos, dan el máximo. La cifra se separa cuando un par vuelve a salir junto, no con los turnos."
            : `Con ${summary.turns} ${summary.turns === 1 ? "turno medido" : "turnos medidos"} la muestra todavía es corta para comparar unos pares con otros.`}
        </p>
      )}

      {visibles.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h3 className="font-semibold text-ink-soft">Por dónde entrar</h3>
          <p className="text-ink-muted">Ordenados por asociación acumulada, no por vecinos.</p>
          <ul className="flex flex-col gap-0.5">
            {visibles.slice(0, PANEL_MAX_HUBS).map((hub) => (
              <li key={hub.id}>
                <button
                  type="button"
                  onClick={() => onSelect(hub.id)}
                  className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-surface"
                >
                  <span
                    aria-hidden="true"
                    className="size-2 shrink-0 rounded-full bg-brand"
                    style={{ opacity: 0.25 + 0.75 * hubGlow(hub.strength, maxHubStrength, hub.support) }}
                  />
                  <span className="min-w-0 flex-1 truncate text-ink-soft">
                    {labels.get(hub.id) ?? hub.id}
                  </span>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    {hub.strength.toFixed(2)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-ink-muted">
          {summary.pairs === 0
            ? "Todavía no se midió ningún par: hace falta que un turno use dos recuerdos juntos."
            : summary.shown === 0
              ? `Hay ${summary.pairs} ${summary.pairs === 1 ? "par medido" : "pares medidos"}, pero ninguno entre los recuerdos que el grafo dibuja. Busca uno de ellos o quita el ámbito.`
              : "Ningún par dibujado supera el soporte mínimo. Baja el soporte o deja que se acumule uso."}
        </p>
      )}
    </aside>
  );
}
