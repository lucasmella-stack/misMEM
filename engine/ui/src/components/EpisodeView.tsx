// Owns the episode view of the detail panel: a read-only pending episode taken from the selection.
import { useEffect } from "react";
import type { Selection } from "@/lib/selection";
import { ago, exact } from "../format";
import { truncate } from "./DetailParts";

export function EpisodeView({
  selection,
  onAnnounce,
}: {
  selection: Selection;
  onAnnounce: (text: string) => void;
}) {
  const episode = selection.episode;
  useEffect(() => {
    onAnnounce(episode ? `Episodio abierto: ${truncate(episode.text, 120)}` : "Episodio abierto");
  }, [episode, onAnnounce]);

  if (!episode) {
    return (
      <p className="text-sm text-ink-muted">
        Este episodio no trae su texto en la selección. Ábrelo desde «Sin consolidar» o desde los resultados.
      </p>
    );
  }
  return (
    <>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-ink-muted">Episodio sin consolidar</p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{episode.text}</p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-muted">Ámbito</dt>
        <dd className="text-ink-soft">{episode.scope}</dd>
        <dt className="text-ink-muted">Capturado</dt>
        <dd className="text-ink-soft" title={exact(episode.created_at)}>
          {ago(episode.created_at)}
        </dd>
      </dl>
      <p className="mt-4 text-sm text-ink-muted">La próxima consolidación lo leerá junto con el resto de su ámbito.</p>
    </>
  );
}
