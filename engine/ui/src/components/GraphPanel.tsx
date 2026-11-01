import { useMemo, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { scopePalette } from "@/lib/graph";

/**
 * Everything the panel lets you adjust, in one flat object. The query and the selected node do
 * not live here: App sends them and the graph mixes them in when filtering.
 */
export interface GraphSettings {
  traits: boolean;
  orphans: boolean;
  related: boolean;
  episodes: boolean;
  coUse: boolean;
  coUseMinN: number;
  localEnabled: boolean;
  depth: 1 | 2 | 3;
  colorByScope: boolean;
  arrows: boolean;
  textThreshold: number;
  nodeSize: number;
  center: number;
  repulsion: number;
  link: number;
  distance: number;
}

/** The values of the approved mock-up: the same ones seen when the graph opens. */
export const DEFAULT_SETTINGS: GraphSettings = {
  traits: true,
  orphans: true,
  related: true,
  episodes: false,
  // Off by default: it is a second reading of the same graph, and the drawing that opens is
  // the one the mock-up approved.
  coUse: false,
  coUseMinN: 1,
  localEnabled: false,
  depth: 2,
  colorByScope: true,
  // Off by default: the approved mock-up had none and they add ink to the drawing.
  arrows: false,
  textThreshold: 1.6,
  nodeSize: 1,
  center: 0.06,
  repulsion: 45,
  link: 0.4,
  distance: 40,
};

interface Props {
  settings: GraphSettings;
  onChange: (patch: Partial<GraphSettings>) => void;
  /** One scope per node, in arrival order: the panel counts and colours. */
  scopes: string[];
  /** Width of the graph container: decides whether the panel starts expanded. */
  width: number;
}

function ToggleRow({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span id={id} className="text-ink-muted">
        {label}
      </span>
      <Switch id={`${id}-switch`} size="sm" aria-labelledby={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SliderRow({
  id,
  label,
  value,
  min,
  max,
  step,
  onValueChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onValueChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-ink-muted">
        <span id={id}>{label}</span>
        <span className="tabular-nums text-ink-soft">{value}</span>
      </div>
      <Slider
        aria-labelledby={id}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => {
          const first = next[0];
          if (first !== undefined) onValueChange(first);
        }}
      />
    </div>
  );
}

function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-b border-edge py-1 last:border-b-0">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 text-left font-semibold text-ink-soft [&[data-state=open]>svg]:rotate-180">
        {title}
        <ChevronDownIcon aria-hidden="true" className="size-3.5 transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2.5 pt-2 pb-1">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function GraphPanel({ settings, onChange, scopes, width }: Props) {
  // In a narrow container the panel covers half the graph: it starts collapsed and opens when
  // touched. While the parent has not measured (width 0) it stays collapsed and expands as soon
  // as a desktop width arrives; after that the person's choice rules.
  const [open, setOpen] = useState<boolean>();
  const expanded = open ?? width >= 900;

  const palette = useMemo(() => scopePalette(scopes), [scopes]);
  const unpainted = scopes.some((scope) => !palette.has(scope));

  return (
    <Collapsible
      open={expanded}
      onOpenChange={setOpen}
      className="absolute top-3 left-3 z-10 max-h-[calc(100%-1.5rem)] w-[min(17rem,calc(100%-1.5rem))] overflow-y-auto rounded-lg border border-edge bg-surface-raised/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur-sm"
    >
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={expanded ? "Plegar los ajustes del grafo" : "Desplegar los ajustes del grafo"}
          className="h-8 w-full justify-between px-0 font-semibold text-ink-soft [&[data-state=open]>svg]:rotate-180"
        >
          Ajustes del grafo
          <ChevronDownIcon aria-hidden="true" className="size-3.5 transition-transform" />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        <Section title="Filtros" defaultOpen>
          <ToggleRow id="gp-traits" label="Rasgos" checked={settings.traits} onChange={(v) => onChange({ traits: v })} />
          <ToggleRow id="gp-orphans" label="Huérfanas" checked={settings.orphans} onChange={(v) => onChange({ orphans: v })} />
          <ToggleRow
            id="gp-related"
            label="Aristas por parecido"
            checked={settings.related}
            onChange={(v) => onChange({ related: v })}
          />
          <ToggleRow
            id="gp-episodes"
            label="Episodios"
            checked={settings.episodes}
            onChange={(v) => onChange({ episodes: v })}
          />
        </Section>

        <Section title="Conectoma" defaultOpen>
          <ToggleRow
            id="gp-co-use"
            label="Aristas por co-uso"
            checked={settings.coUse}
            onChange={(v) => onChange({ coUse: v })}
          />
          {settings.coUse && (
            <SliderRow
              id="gp-co-use-min-n"
              label="Soporte mínimo"
              value={settings.coUseMinN}
              min={1}
              max={10}
              step={1}
              onValueChange={(v) => onChange({ coUseMinN: v })}
            />
          )}
        </Section>

        <Section title="Grupos" defaultOpen>
          <ToggleRow
            id="gp-scope"
            label="Color por ámbito"
            checked={settings.colorByScope}
            onChange={(v) => onChange({ colorByScope: v })}
          />
          {settings.colorByScope && (
            <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto" aria-label="Colores por ámbito">
              {[...palette.entries()].map(([scope, color]) => (
                <li key={scope} className="flex items-center gap-2 text-ink-muted">
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="truncate">{scope}</span>
                </li>
              ))}
              {unpainted && (
                <li className="flex items-center gap-2 text-ink-muted">
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-ink-muted" />
                  <span>resto</span>
                </li>
              )}
            </ul>
          )}
        </Section>

        <Section title="Visualización">
          <ToggleRow
            id="gp-arrows"
            label="Flechas"
            checked={settings.arrows}
            onChange={(v) => onChange({ arrows: v })}
          />
          <SliderRow
            id="gp-text"
            label="Umbral de texto"
            value={settings.textThreshold}
            min={0.3}
            max={4}
            step={0.1}
            onValueChange={(v) => onChange({ textThreshold: v })}
          />
          <SliderRow
            id="gp-size"
            label="Tamaño de nodo"
            value={settings.nodeSize}
            min={0.5}
            max={3}
            step={0.1}
            onValueChange={(v) => onChange({ nodeSize: v })}
          />
        </Section>

        <Section title="Fuerzas" defaultOpen>
          <SliderRow
            id="gp-center"
            label="Centro"
            value={settings.center}
            min={0}
            max={0.3}
            step={0.01}
            onValueChange={(v) => onChange({ center: v })}
          />
          <SliderRow
            id="gp-repel"
            label="Repulsión"
            value={settings.repulsion}
            min={5}
            max={200}
            step={5}
            onValueChange={(v) => onChange({ repulsion: v })}
          />
          <SliderRow
            id="gp-link"
            label="Enlace"
            value={settings.link}
            min={0}
            max={1}
            step={0.05}
            onValueChange={(v) => onChange({ link: v })}
          />
          <SliderRow
            id="gp-dist"
            label="Distancia"
            value={settings.distance}
            min={10}
            max={150}
            step={5}
            onValueChange={(v) => onChange({ distance: v })}
          />
        </Section>

        <Section title="Grafo local" defaultOpen>
          <ToggleRow
            id="gp-local"
            label="Sólo alrededor de la selección"
            checked={settings.localEnabled}
            onChange={(v) => onChange({ localEnabled: v })}
          />
          <SliderRow
            id="gp-depth"
            label="Profundidad"
            value={settings.depth}
            min={1}
            max={3}
            step={1}
            onValueChange={(v) => onChange({ depth: v >= 3 ? 3 : v <= 1 ? 1 : 2 })}
          />
        </Section>
      </CollapsibleContent>
    </Collapsible>
  );
}
