import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { actions, type Polarity } from "../api";
import { errorMessage } from "../lib/errors";

const POLARITIES: Array<{ id: Polarity; label: string; hint: string }> = [
  { id: "neutral", label: "Neutra", hint: "un patrón, sin juicio" },
  { id: "light", label: "Luz", hint: "algo que conviene repetir" },
  { id: "shadow", label: "Sombra", hint: "algo que conviene evitar" },
];

export function CrystallizeDialog({
  scope,
  ids,
  onClose,
  onDone,
}: {
  scope: string;
  ids: string[];
  onClose: () => void;
  onDone: (traitId: string) => void;
}) {
  const [name, setName] = useState("");
  const [polarity, setPolarity] = useState<Polarity>("neutral");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const out = await actions.crystallize(scope, name.trim(), polarity, ids);
      toast.success(out.created ? "Rasgo cristalizado." : "Rasgo reforzado.");
      onDone(out.trait_id);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cristalizar como rasgo</DialogTitle>
          <DialogDescription>
            Un rasgo es un patrón estable que{" "}
            {ids.length === 1 ? "1 memoria sostiene" : `las ${ids.length} memorias sostienen`} en {scope}. Si ya existe
            uno con el mismo nombre, gana fuerza en vez de duplicarse.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <label htmlFor="trait-name" className="flex flex-col gap-1 text-xs text-ink-muted">
            <span>Nombre</span>
            <Input
              id="trait-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoFocus
              placeholder="Prefiere soluciones sin dependencias"
              className="bg-field"
            />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs text-ink-muted">Polaridad</legend>
            {POLARITIES.map((entry) => (
              <label key={entry.id} className="flex items-start gap-2 text-sm text-ink-soft">
                <input
                  type="radio"
                  name="polarity"
                  value={entry.id}
                  checked={polarity === entry.id}
                  onChange={() => setPolarity(entry.id)}
                  className="mt-0.5 accent-[var(--color-brand)]"
                />
                <span>
                  {entry.label}
                  <span className="block text-xs text-ink-muted">{entry.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-danger">
              No se pudo: {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Un momento…" : "Cristalizar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
