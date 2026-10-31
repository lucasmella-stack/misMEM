// Owns the memory view of the detail panel: the record and its wiring. The edit form, the two-step
// confirmation and their copy live in their own modules.
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useMemoryActions } from "@/hooks/use-memory-actions";
import { actions, api, isMissing, type MemoryDetail } from "../api";
import { ago, exact, percent } from "../format";
import { errorMessage } from "../lib/errors";
import { inkPercent } from "../lib/ink";
import { forgetText, unconsolidateText } from "../lib/memory-text";
import {
  ConfirmDialog,
  DetailFailure,
  DetailLoading,
  SectionTitle,
  tint,
  truncate,
  type DetailViewProps,
} from "./DetailParts";
import { EditForm } from "./memory/EditForm";

export function MemoryView({ id, onSelect, onChanged, onAnnounce }: DetailViewProps) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["memory", id], queryFn: ({ signal }) => api.memory(id, signal) });
  const [editing, setEditing] = useState(false);

  const data = query.data;
  useEffect(() => {
    if (data) onAnnounce(`Memoria abierta: ${truncate(data.memory.text, 120)}`);
  }, [data, onAnnounce]);

  const { confirm, challenge, busy, actionError, openUnconsolidate, askForget, runAction, dismiss } = useMemoryActions(
    data?.memory.id,
    onChanged,
  );

  if (!data) {
    return query.isError ? <DetailFailure what="la memoria" error={query.error} /> : <DetailLoading label="Cargando la memoria…" />;
  }
  const { memory, episodes, traits } = data;
  const linked = episodes.filter((episode) => !isMissing(episode) && episode.linked_here).length;

  const save = async (gist: string, details: string | null) => {
    await actions.editMemory(memory.id, gist, details);
    // D6: the detail renders the new text before the refetch finishes.
    queryClient.setQueryData<MemoryDetail>(["memory", memory.id], (previous) =>
      previous ? { ...previous, memory: { ...previous.memory, text: gist, details } } : previous,
    );
    setEditing(false);
    toast.success("Memoria corregida.");
    void queryClient.invalidateQueries();
  };

  return (
    <>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-brand-text">Memoria</p>

      {editing ? (
        <EditForm
          gist={memory.text}
          details={memory.details}
          onCancel={() => setEditing(false)}
          onSave={save}
        />
      ) : (
        <>
          <p className="text-sm leading-relaxed" style={{ color: tint(memory.salience) }}>
            {memory.text}
          </p>
          {memory.details && memory.details !== memory.text && (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{memory.details}</p>
          )}
        </>
      )}

      {query.isError && (
        <p role="status" className="mt-2 rounded-md bg-field px-2 py-1.5 text-xs text-ink-muted">
          No se pudo actualizar la memoria: {errorMessage(query.error)}. Se muestra lo último que llegó.
        </p>
      )}

      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={memory.salience}
        aria-valuetext={`Saliencia ${percent(memory.salience)}`}
        className="mt-4"
      >
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-ink-muted">Saliencia hoy</span>
          <span className="tabular-nums text-ink-soft">{percent(memory.salience)}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-field">
          <div className="h-full rounded-full bg-brand" style={{ width: `${inkPercent(memory.salience)}%` }} />
        </div>
        {memory.stored_salience !== memory.salience && (
          <p className="mt-1 text-[11px] text-ink-muted">
            guardada {percent(memory.stored_salience)}; se reduce a la mitad cada 90 días sin uso
          </p>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-muted">Ámbito</dt>
        <dd className="text-ink-soft">{memory.scope}</dd>
        <dt className="text-ink-muted">Consolidada</dt>
        <dd className="text-ink-soft" title={exact(memory.created_at)}>
          {ago(memory.created_at)}
        </dd>
        <dt className="text-ink-muted">Último uso</dt>
        <dd className="text-ink-soft">{ago(memory.last_accessed_at)}</dd>
      </dl>

      {!editing && (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Acciones sobre la memoria">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Corregir
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={openUnconsolidate}>
            Deshacer consolidación
          </Button>
          <Button type="button" variant="outline" size="sm" className="text-danger" onClick={() => void askForget()}>
            Olvidar
          </Button>
        </div>
      )}

      <section className="mt-5">
        <SectionTitle>De dónde sale</SectionTitle>
        {episodes.length === 0 ? (
          <p className="text-sm text-ink-muted">No consta ningún episodio de origen.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {episodes.map((episode) =>
              isMissing(episode) ? (
                <li key={episode.id} className="rounded-md bg-field px-2.5 py-2 text-sm text-ink-muted">
                  Episodio borrado por <code className="text-ink-soft">forget</code>: queda el resumen, no el original.
                </li>
              ) : (
                <li key={episode.id} className="rounded-md bg-field px-2.5 py-2">
                  <p className="text-sm leading-relaxed text-ink-soft">{episode.text}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
                    <span title={exact(episode.created_at)}>{ago(episode.created_at)}</span>
                    {episode.linked_here === false && <span>ahora consolidado en otra memoria</span>}
                  </p>
                </li>
              ),
            )}
          </ol>
        )}
      </section>

      <section className="mt-5">
        <SectionTitle>Rasgos que la citan</SectionTitle>
        {traits.length === 0 ? (
          <p className="text-sm text-ink-muted">Ningún rasgo la cita todavía.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {traits.map((trait) => (
              <li key={trait.id}>
                <button
                  type="button"
                  className="rounded-md text-left text-sm text-brand-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                  onClick={() => onSelect({ layer: "trait", id: trait.id })}
                >
                  {trait.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === "forget" ? "Olvidar esta memoria" : "Deshacer la consolidación"}
        description={
          confirm === "forget"
            ? challenge
              ? forgetText(challenge.impact.episodes ?? 0, challenge.impact.traits_citing ?? 0)
              : actionError
                ? "No se puede olvidar esta memoria ahora."
                : "Mirando qué se perdería…"
            : unconsolidateText(linked)
        }
        confirmLabel={confirm === "forget" ? "Olvidar" : "Deshacer consolidación"}
        variant={confirm === "forget" ? "destructive" : "default"}
        busy={busy}
        blocked={confirm === "forget" && !challenge}
        error={actionError}
        onDismiss={dismiss}
        onConfirm={() => void runAction(confirm ?? "forget")}
      />
    </>
  );
}
