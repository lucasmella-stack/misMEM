// Owns the memory view of the detail panel: its edit form and the unconsolidate and forget confirmations.
import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { actions, api, isMissing, type ForgetChallenge, type MemoryDetail } from "../api";
import { percent, when } from "../format";
import { embeddingSummary } from "../lib/embeddings";
import { errorMessage } from "../lib/errors";
import { inkPercent } from "../lib/ink";
import {
  ConfirmDialog,
  DetailFailure,
  DetailLoading,
  SectionTitle,
  tint,
  truncate,
  type DetailViewProps,
} from "./DetailParts";

export function MemoryView({ id, onSelect, onChanged, onAnnounce }: DetailViewProps) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["memory", id], queryFn: ({ signal }) => api.memory(id, signal) });
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"unconsolidate" | "forget" | null>(null);
  const [challenge, setChallenge] = useState<ForgetChallenge>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const data = query.data;
  useEffect(() => {
    if (data) onAnnounce(`Memoria abierta: ${truncate(data.memory.text, 120)}`);
  }, [data, onAnnounce]);

  if (!data) {
    return query.isError ? <DetailFailure what="la memoria" error={query.error} /> : <DetailLoading label="Cargando la memoria…" />;
  }
  const { memory, episodes, traits } = data;
  const linked = episodes.filter((episode) => !isMissing(episode) && episode.linked_here).length;

  const save = async (gist: string, details: string | null) => {
    await actions.editMemory(memory.id, gist, details);
    // D6: el detalle pinta el texto nuevo antes de que termine la recarga.
    queryClient.setQueryData<MemoryDetail>(["memory", memory.id], (previous) =>
      previous ? { ...previous, memory: { ...previous.memory, text: gist, details } } : previous,
    );
    setEditing(false);
    toast.success("Memoria corregida.");
    void queryClient.invalidateQueries();
  };

  // Olvidar va en dos pasos (viewer-actions.ts): el servidor dice qué se pierde y da el token
  // que confirma; sin él no borra. El diálogo enseña ese impacto, no uno calculado aquí.
  const askForget = async () => {
    setConfirm("forget");
    setChallenge(undefined);
    setActionError(undefined);
    try {
      setChallenge(await actions.forgetMemoryChallenge(memory.id));
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const runAction = async (kind: "unconsolidate" | "forget") => {
    setBusy(true);
    setActionError(undefined);
    try {
      if (kind === "unconsolidate") {
        const out = await actions.unconsolidate(memory.id);
        setConfirm(null);
        toast.success(
          out.episodes_released === 1
            ? "Consolidación deshecha: el episodio vuelve a estar pendiente."
            : `Consolidación deshecha: ${out.episodes_released} episodios vuelven a estar pendientes.`,
        );
      } else {
        if (!challenge) return;
        const out = await actions.forgetMemory(memory.id, challenge.confirm_token);
        setConfirm(null);
        toast.success(
          out.episodes_deleted === 1
            ? "Memoria olvidada con su episodio."
            : `Memoria olvidada con ${out.episodes_deleted} episodios.`,
        );
      }
      onChanged(null);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(message);
      toast.error(`No se pudo: ${message}`);
      // El token se gastó en el intento: sin uno nuevo, el siguiente clic tampoco borraría.
      if (kind === "forget") {
        setChallenge(undefined);
        actions.forgetMemoryChallenge(memory.id).then(setChallenge, () => undefined);
      }
    } finally {
      setBusy(false);
    }
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
        <dd className="text-ink-soft">{when(memory.created_at)}</dd>
        <dt className="text-ink-muted">Último uso</dt>
        <dd className="text-ink-soft">{when(memory.last_accessed_at)}</dd>
        <dt className="text-ink-muted">Usos</dt>
        <dd className="text-ink-soft">{memory.use_count}</dd>
        <dt className="text-ink-muted">Vector</dt>
        <dd className="text-ink-soft">{embeddingSummary(memory.embedding)}</dd>
      </dl>

      {!editing && (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Acciones sobre la memoria">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Corregir
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirm("unconsolidate")}>
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
                    <span>{when(episode.created_at)}</span>
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
        onDismiss={() => {
          setConfirm(null);
          setChallenge(undefined);
          setActionError(undefined);
        }}
        onConfirm={() => void runAction(confirm ?? "forget")}
      />
    </>
  );
}

function unconsolidateText(linked: number): string {
  return linked === 0
    ? "La memoria desaparece; no tenía episodios atados."
    : `La memoria desaparece y ${linked === 1 ? "su episodio vuelve" : `sus ${linked} episodios vuelven`} a estar sin consolidar. La próxima consolidación ${linked === 1 ? "lo" : "los"} leerá de nuevo.`;
}

function forgetText(linked: number, traits: number): string {
  const base =
    linked === 0
      ? "Se borra la memoria."
      : `Se borran la memoria y ${linked === 1 ? "su episodio" : `sus ${linked} episodios`}.`;
  const citing =
    traits === 0
      ? ""
      : traits === 1
        ? " Un rasgo la cita y seguirá existiendo sin ella."
        : ` ${traits} rasgos la citan y seguirán existiendo sin ella.`;
  return `${base} No se puede deshacer.${citing}`;
}

function EditForm({
  gist,
  details,
  onSave,
  onCancel,
}: {
  gist: string;
  details: string | null;
  onSave: (gist: string, details: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [draftGist, setDraftGist] = useState(gist);
  const [draftDetails, setDraftDetails] = useState(details ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onSave(draftGist, draftDetails.trim() || null);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        <span>Lo que recuerda</span>
        <textarea
          className="min-h-20 w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          value={draftGist}
          onChange={(event) => setDraftGist(event.target.value)}
          rows={3}
          required
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        <span>Detalles</span>
        <textarea
          className="min-h-28 w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          value={draftDetails}
          onChange={(event) => setDraftDetails(event.target.value)}
          rows={6}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          No se pudo guardar: {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !draftGist.trim()}>
          {busy ? "Guardando…" : "Guardar cambios"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
