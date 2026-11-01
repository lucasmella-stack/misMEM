import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ThemeChoice } from "@/lib/theme";

const OPTIONS = [
  { id: "dark", label: "Tema oscuro", Icon: MoonIcon },
  { id: "light", label: "Tema claro", Icon: SunIcon },
  { id: "system", label: "Tema del sistema", Icon: MonitorIcon },
] as const;

/** Three buttons with aria-pressed: the state reads without relying on the icon or the colour. */
export function ThemeToggle({ choice, onChange }: { choice: ThemeChoice; onChange: (choice: ThemeChoice) => void }) {
  return (
    <div role="group" aria-label="Tema" className="flex items-center gap-0.5 rounded-md border border-edge p-0.5">
      {OPTIONS.map(({ id, label, Icon }) => (
        <Button
          key={id}
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-pressed={choice === id}
          title={label}
          onClick={() => onChange(id)}
          className={cn(choice === id && "bg-surface-raised text-brand-text")}
        >
          <Icon />
        </Button>
      ))}
    </div>
  );
}
