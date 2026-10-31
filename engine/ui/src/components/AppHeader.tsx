import type { FormEvent, RefObject } from "react";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ThemeChoice } from "@/lib/theme";
import { ThemeToggle } from "./ThemeToggle";

export function AppHeader({
  draft,
  onDraftChange,
  onSubmit,
  searchRef,
  themeChoice,
  onThemeChange,
  onConsolidate,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  themeChoice: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  onConsolidate: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2 sm:gap-3 sm:px-4">
      <a href="./" className="font-semibold tracking-tight" aria-label="misMEM, inicio">
        mis<span className="text-brand-text">MEM</span>
      </a>
      <form
        role="search"
        onSubmit={onSubmit}
        className="order-last flex w-full min-w-0 items-center sm:order-none sm:w-auto sm:flex-1"
      >
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-muted"
          />
          <Input
            ref={searchRef}
            type="search"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            placeholder="Buscar en la memoria (/)"
            aria-label="Buscar en la memoria"
            className="bg-field pl-8"
          />
        </div>
      </form>
      <div className="ml-auto flex items-center gap-2">
        <ThemeToggle choice={themeChoice} onChange={onThemeChange} />
        <Button type="button" variant="outline" size="sm" aria-haspopup="dialog" onClick={onConsolidate}>
          Consolidar ahora
        </Button>
      </div>
    </header>
  );
}
