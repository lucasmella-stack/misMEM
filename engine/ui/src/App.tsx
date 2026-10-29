import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { actions, api, type EpisodeItem, type Layer, type Polarity } from "./api";
import { Scopes } from "./components/Scopes";
import { EmbeddingNotice } from "./components/EmbeddingNotice";
import { MemoryList, PendingList, SearchResults, TraitList } from "./components/Lists";
import { DetailPanel } from "./components/Detail";
import { Consolidate } from "./components/Consolidate";
import { ThemeToggle } from "./components/ThemeToggle";
import { errorMessage } from "./lib/errors";
import { viewAfterQuery, type View } from "./lib/search-view";
import { applyTheme, browserStorage, loadTheme, resolveTheme, saveTheme, type ThemeChoice } from "./lib/theme";

// El grafo pesa más que el resto: se baja sólo al abrir su pestaña.
const GraphView = lazy(() => import("./components/GraphView"));

// El tipo vive con la lógica de búsqueda y se reexporta: Detail y Lists ya lo tomaban de aquí.
export type { View } from "./lib/search-view";

/**
 * El episodio lleva su texto en la selección porque no hay endpoint de detalle por id:
 * el snapshot de la fila es lo único que lo tiene. Las demás capas se piden por id.
 */
export type Selection = { layer: Layer; id: string; episode?: EpisodeItem };

const VIEWS: Array<{ id: View; label: string; short: string }> = [
  { id: "memories", label: "Memorias", short: "Memorias" },
  { id: "traits", label: "Rasgos", short: "Rasgos" },
  { id: "pending", label: "Sin consolidar", short: "Pendientes" },
  { id: "results", label: "Resultados", short: "Buscar" },
  { id: "graph", label: "Grafo", short: "Grafo" },
];

const POLARITIES: Array<{ id: Polarity; label: string; hint: string }> = [
  { id: "neutral", label: "Neutra", hint: "un patrón, sin juicio" },
  { id: "light", label: "Luz", hint: "algo que conviene repetir" },
  { id: "shadow", label: "Sombra", hint: "algo que conviene evitar" },
];

/** Radix monta los diálogos fuera de <dialog>: Escape debe respetar ambos mundos. */
function hasOpenDialog(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]',
    ),
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function App() {
  const queryClient = useQueryClient();
  const [scope, setScope] = useState<string | undefined>();
  const [view, setView] = useState<View>("memories");
  const [selected, setSelected] = useState<Selection | undefined>();
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Map<string, string> | null>(null);
  const [crystallizing, setCrystallizing] = useState(false);
  const [consolidating, setConsolidating] = useState(false);
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(() => loadTheme(browserStorage()));
  const [prefersDark, setPrefersDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const searchRef = useRef<HTMLInputElement>(null);

  const scopesQuery = useQuery({ queryKey: ["scopes"], queryFn: ({ signal }) => api.scopes(signal) });
  const scopeList = scopesQuery.data?.scopes;

  // Buscar espera 250 ms tras la última tecla; el `signal` de TanStack cancela la anterior.
  const debouncedDraft = useDebounced(draft, 250);
  useEffect(() => {
    const next = debouncedDraft.trim();
    setQuery(next);
    setView((current) => viewAfterQuery(current, next));
  }, [debouncedDraft]);

  // El grafo se monta la primera vez que se abre y ya no se desmonta: Radix tira las
  // pestañas inactivas, y con ellas la cámara, la simulación asentada y los ajustes.
  const [graphSeen, setGraphSeen] = useState(false);
  useEffect(() => {
    if (view === "graph") setGraphSeen(true);
  }, [view]);

  const resolvedTheme = resolveTheme(themeChoice, prefersDark);
  useEffect(() => {
    applyTheme(document.documentElement, resolvedTheme);
    saveTheme(browserStorage(), themeChoice);
  }, [themeChoice, resolvedTheme]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const editing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "/" && !editing && !hasOpenDialog() && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Escape cierra el detalle salvo que lo esté usando un diálogo abierto, que se cierra solo.
      if (event.key === "Escape" && !hasOpenDialog()) setSelected(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const refresh = useCallback(() => void queryClient.invalidateQueries(), [queryClient]);

  const changeScope = (next: string | undefined) => {
    setScope(next);
    setSelected(undefined);
    setPicked(null);
  };

  const changeView = (next: View) => {
    // Las listas no filtran por texto: al entrar en una se limpia la caja, porque un texto
    // visible que no filtra nada engaña. El grafo sí la usa como filtro local, así que al
    // entrar en él la consulta se conserva.
    if (next === "memories" || next === "traits" || next === "pending") {
      setDraft("");
      setQuery("");
    }
    setView(next);
    if (next !== "memories") setPicked(null);
  };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const term = draft.trim();
    setQuery(term);
    setView((current) => viewAfterQuery(current, term));
  };

  const togglePick = (id: string, memoryScope: string) =>
    setPicked((previous) => {
      const next = new Map(previous ?? []);
      if (next.has(id)) next.delete(id);
      else next.set(id, memoryScope);
      return next;
    });

  const pickedScopes = new Set(picked?.values() ?? []);
  const pickedScope = pickedScopes.size === 1 ? [...pickedScopes][0] : undefined;

  const totalTraits = useMemo(() => {
    if (!scopeList) return undefined;
    if (scope) return scopeList.find((entry) => entry.scope === scope)?.traits ?? 0;
    return scopeList.reduce((total, entry) => total + entry.traits, 0);
  }, [scopeList, scope]);

  const changed = (next?: Selection | null) => {
    refresh();
    if (next !== undefined) setSelected(next ?? undefined);
  };

  const crystallized = (traitId: string) => {
    // Sin esto el diálogo sigue marcado como abierto y reaparece al elegir la primera
    // memoria de la siguiente selección, sin volver a pulsar "Cristalizar como rasgo".
    setCrystallizing(false);
    setPicked(null);
    refresh();
    setSelected({ layer: "trait", id: traitId });
    setView("traits");
  };

  // En el grafo sin selección la columna de detalle vacía no aporta: el grafo se queda
  // su ancho. Por debajo de md el detalle va en un Sheet y no ocupa columna.
  const graphAlone = view === "graph" && !selected;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface text-ink">
      <header className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2 sm:gap-3 sm:px-4">
        <a href="./" className="font-semibold tracking-tight" aria-label="misMEM, inicio">
          mis<span className="text-brand-text">MEM</span>
        </a>
        <form
          role="search"
          onSubmit={submitSearch}
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
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Buscar en la memoria (/)"
              aria-label="Buscar en la memoria"
              className="bg-field pl-8"
            />
          </div>
        </form>
        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle choice={themeChoice} onChange={setThemeChoice} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            onClick={() => setConsolidating(true)}
          >
            Consolidar ahora
          </Button>
        </div>
      </header>

      <EmbeddingNotice />

      <div
        className={`flex min-h-0 flex-1 flex-col md:grid md:overflow-hidden ${
          graphAlone
            ? "md:grid-cols-[minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]"
            : "md:grid-cols-[minmax(0,1fr)_380px] lg:grid-cols-[220px_minmax(0,1fr)_380px]"
        }`}
      >
        <nav
          aria-label="Ámbitos"
          className="shrink-0 border-b border-edge md:col-span-2 lg:col-span-1 lg:min-h-0 lg:overflow-y-auto lg:border-r lg:border-b-0"
        >
          <Scopes
            scopes={scopeList}
            isPending={scopesQuery.isPending}
            error={scopesQuery.error}
            current={scope}
            onChange={changeScope}
          />
        </nav>

        <main className="flex min-h-0 flex-1 flex-col">
          <Tabs
            value={view}
            onValueChange={(value) => changeView(value as View)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="flex min-w-0 items-center gap-2 border-b border-edge px-3 py-2">
              <div className="min-w-0 flex-1 overflow-x-auto">
                <TabsList className="bg-field">
                  {VIEWS.map((entry) => (
                    <TabsTrigger
                      key={entry.id}
                      value={entry.id}
                      className="px-1.5 text-xs md:px-2 md:text-sm xl:px-2.5"
                    >
                      <span className="xl:hidden">{entry.short}</span>
                      <span className="hidden xl:inline">{entry.label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <TabsContent value="memories" className="m-0">
                <MemoryList
                  scope={scope}
                  selected={selected}
                  onSelect={setSelected}
                  picked={picked ?? undefined}
                  onPick={picked ? togglePick : undefined}
                  picking={picked !== null}
                  onTogglePicking={() => setPicked(picked ? null : new Map())}
                />
              </TabsContent>
              <TabsContent value="traits" className="m-0">
                <TraitList scope={scope} selected={selected} onSelect={setSelected} totalTraits={totalTraits} />
              </TabsContent>
              <TabsContent value="pending" className="m-0">
                <PendingList scope={scope} selected={selected} onSelect={setSelected} />
              </TabsContent>
              <TabsContent value="results" className="m-0">
                <SearchResults term={query} scope={scope} selected={selected} onSelect={setSelected} />
              </TabsContent>
              {/* forceMount: cambiar de pestaña no puede tirar la cámara ni la simulación. */}
              {(graphSeen || view === "graph") && (
                <TabsContent
                  value="graph"
                  forceMount
                  className="m-0 h-full data-[state=inactive]:hidden"
                >
                  <Suspense fallback={<p className="text-sm text-ink-muted">Cargando el grafo…</p>}>
                    <GraphView
                      scope={scope}
                      query={query}
                      selectedId={selected?.id}
                      active={view === "graph"}
                      onSelect={(layer, id) => setSelected({ layer, id })}
                    />
                  </Suspense>
                </TabsContent>
              )}
            </div>
          </Tabs>

          {picked && picked.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-edge bg-surface-raised px-3 py-2 text-xs">
              <p role="status" className="text-ink-soft">
                {picked.size === 1 ? "1 memoria seleccionada" : `${picked.size} memorias seleccionadas`}
                {pickedScopes.size > 1 && ", de ámbitos distintos: un rasgo sólo junta memorias de uno"}
              </p>
              <Button
                type="button"
                size="sm"
                className="ml-auto"
                disabled={!pickedScope}
                onClick={() => setCrystallizing(true)}
              >
                Cristalizar como rasgo
              </Button>
            </div>
          )}
        </main>

        {/* `contents` mantiene el <aside> como celda; en el grafo sin selección se oculta y la
            rejilla pierde esa columna para que el grafo respire. */}
        <div className={graphAlone ? "hidden" : "contents"}>
          <DetailPanel
            selected={selected}
            onSelect={setSelected}
            onClose={() => setSelected(undefined)}
            onChanged={changed}
          />
        </div>
      </div>

      <Consolidate
        open={consolidating}
        scope={scope}
        scopes={scopeList}
        onClose={() => setConsolidating(false)}
      />

      {crystallizing && picked && pickedScope && (
        <CrystallizeDialog
          scope={pickedScope}
          ids={[...picked.keys()]}
          onClose={() => setCrystallizing(false)}
          onDone={crystallized}
        />
      )}

      <Toaster theme={resolvedTheme} position="bottom-right" />
    </div>
  );
}

function CrystallizeDialog({
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
