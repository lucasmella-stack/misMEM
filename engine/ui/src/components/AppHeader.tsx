import { useState, type FormEvent, type RefObject } from "react";
import { LogOutIcon, SearchIcon } from "lucide-react";
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
  canSignOut,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  themeChoice: ThemeChoice;
  onThemeChange: (choice: ThemeChoice) => void;
  onConsolidate: () => void;
  /** Only with credentials configured: without them there is no session to end. */
  canSignOut: boolean;
}) {
  const [failed, setFailed] = useState(false);
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
        {canSignOut && (
          <Button
            type="button"
            variant="outline"
            size="icon"
            title="Salir"
            aria-label="Salir"
            onClick={() => {
              setFailed(false);
              // A form would be blocked: the viewer's CSP sets form-action 'none'. The paths are
              // relative like `api.ts`, so misMEM keeps working mounted on another path, and only
              // a sign-out that happened navigates: `finally` showed the login form with the
              // cookie still alive.
              void fetch("../logout", { method: "POST" })
                .then((res) => (res.ok ? window.location.assign("../login") : setFailed(true)))
                .catch(() => setFailed(true));
            }}
          >
            <LogOutIcon aria-hidden="true" className="size-4" />
          </Button>
        )}
        {failed && (
          <p role="alert" className="text-ink-muted">
            No se pudo cerrar la sesión.
          </p>
        )}
      </div>
    </header>
  );
}
