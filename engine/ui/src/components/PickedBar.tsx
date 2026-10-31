import { Button } from "@/components/ui/button";

/** The selection bar for crystallizing: how many memories go and whether they share a scope. */
export function PickedBar({
  picked,
  pickedScope,
  onCrystallize,
}: {
  picked: ReadonlyMap<string, string>;
  pickedScope: string | undefined;
  onCrystallize: () => void;
}) {
  if (picked.size === 0) return null;
  const distinctScopes = new Set(picked.values()).size > 1;
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-edge bg-surface-raised px-3 py-2 text-xs">
      <p role="status" className="text-ink-soft">
        {picked.size === 1 ? "1 memoria seleccionada" : `${picked.size} memorias seleccionadas`}
        {distinctScopes && ", de ámbitos distintos: un rasgo sólo junta memorias de uno"}
      </p>
      <Button type="button" size="sm" className="ml-auto" disabled={!pickedScope} onClick={onCrystallize}>
        Cristalizar como rasgo
      </Button>
    </div>
  );
}
