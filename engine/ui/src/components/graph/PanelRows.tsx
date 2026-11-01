// The rows the graph panel is built from. They live apart so the panel itself stays readable,
// and because a deferred slider carries real behaviour: it is the one a test drives.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";

/** How long a deferred slider waits before telling the parent: enough for a burst of arrow keys. */
export const COMMIT_DELAY_MS = 250;

/** Three options do not fit a switch, and the panel has no select: a row of radios does. */
export function ChoiceRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-ink-muted">{label}</span>
      <div className="flex gap-1" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded border px-2 py-1 ${
              value === option.value
                ? "border-brand bg-brand/15 text-ink"
                : "border-edge text-ink-muted hover:text-ink"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}


export function ToggleRow({
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


export function SliderRow({
  id,
  label,
  value,
  min,
  max,
  step,
  deferCommit,
  onValueChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** For a value whose change costs a request: the parent hears the last one, not every step. */
  deferCommit?: boolean;
  onValueChange: (value: number) => void;
}) {
  // The dragged value, shown right away. Without it a deferred slider would not move until the
  // parent answered, and the number would lag behind the thumb.
  const [draft, setDraft] = useState<number>();
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shown = draft ?? value;

  useEffect(() => () => clearTimeout(pending.current), []);

  const change = (next: number) => {
    if (!deferCommit) return onValueChange(next);
    setDraft(next);
    // Radix commits on every arrow key, so waiting for the release is not enough: five presses
    // were five requests. The timer collapses the burst and the last value is the one that counts.
    clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      setDraft(undefined);
      onValueChange(next);
    }, COMMIT_DELAY_MS);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-ink-muted">
        <span id={id}>{label}</span>
        <span className="tabular-nums text-ink-soft">{shown}</span>
      </div>
      <Slider
        aria-labelledby={id}
        value={[shown]}
        min={min}
        max={max}
        step={step}
        onValueChange={(next) => {
          const first = next[0];
          if (first !== undefined) change(first);
        }}
      />
    </div>
  );
}


export function Section({ title, defaultOpen, children }: { title: string; defaultOpen?: boolean; children: ReactNode }) {
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
