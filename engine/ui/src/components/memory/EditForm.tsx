import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "../../lib/errors";

export function EditForm({
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
