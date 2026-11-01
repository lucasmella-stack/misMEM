import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { api } from "./api";
import { AppHeader } from "./components/AppHeader";
import { Consolidate } from "./components/Consolidate";
import { CrystallizeDialog } from "./components/CrystallizeDialog";
import { DetailPanel } from "./components/Detail";
import { MemoryList } from "./components/list/MemoryList";
import { PendingList } from "./components/list/PendingList";
import { SearchResults } from "./components/list/SearchResults";
import { TraitList } from "./components/list/TraitList";
import { PickedBar } from "./components/PickedBar";
import { Scopes } from "./components/Scopes";
import { useDebounced } from "./hooks/use-debounced";
import { useGlobalShortcuts } from "./hooks/use-global-shortcuts";
import { useTheme } from "./hooks/use-theme";
import type { Selection } from "./lib/selection";
import { viewAfterQuery, type View } from "./lib/search-view";

// The graph is heavier than the rest: it is only downloaded when its tab opens.
const GraphView = lazy(() => import("./components/GraphView"));

const VIEWS: Array<{ id: View; label: string; short: string }> = [
  { id: "memories", label: "Memorias", short: "Memorias" },
  { id: "traits", label: "Rasgos", short: "Rasgos" },
  { id: "pending", label: "Sin consolidar", short: "Pendientes" },
  { id: "results", label: "Resultados", short: "Buscar" },
  { id: "graph", label: "Grafo", short: "Grafo" },
];

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
  const searchRef = useRef<HTMLInputElement>(null);

  const scopesQuery = useQuery({ queryKey: ["scopes"], queryFn: ({ signal }) => api.scopes(signal) });
  // Whether there is a session to end. It does not change while the page is open.
  const sessionQuery = useQuery({
    queryKey: ["session"],
    queryFn: ({ signal }) => api.session(signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const scopeList = scopesQuery.data?.scopes;

  // Search waits 250 ms after the last keystroke; TanStack's `signal` cancels the previous one.
  const debouncedDraft = useDebounced(draft, 250);
  useEffect(() => {
    const next = debouncedDraft.trim();
    setQuery(next);
    setView((current) => viewAfterQuery(current, next));
  }, [debouncedDraft]);

  // The graph mounts the first time it opens and is never unmounted: Radix drops inactive
  // tabs, and with them the camera, the settled simulation and the settings.
  const [graphSeen, setGraphSeen] = useState(false);
  useEffect(() => {
    if (view === "graph") setGraphSeen(true);
  }, [view]);

  const { choice: themeChoice, setChoice: setThemeChoice, resolved: resolvedTheme } = useTheme();

  const refresh = useCallback(() => void queryClient.invalidateQueries(), [queryClient]);

  useGlobalShortcuts(searchRef, setSelected);

  const changeScope = (next: string | undefined) => {
    setScope(next);
    setSelected(undefined);
    setPicked(null);
  };

  const changeView = (next: View) => {
    // Lists do not filter by text: entering one clears the box, because a visible text that
    // filters nothing is misleading. The graph does use it as a local filter, so entering it
    // keeps the query.
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
    // Without this the dialog stays marked as open and reappears when picking the first memory
    // of the next selection, without pressing "Cristalizar como rasgo" again.
    setCrystallizing(false);
    setPicked(null);
    refresh();
    setSelected({ layer: "trait", id: traitId });
    setView("traits");
  };

  // In the graph with no selection the empty detail column adds nothing: the graph keeps its
  // width. Below md the detail goes in a Sheet and takes no column.
  const graphAlone = view === "graph" && !selected;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-surface text-ink">
      <AppHeader
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={submitSearch}
        searchRef={searchRef}
        themeChoice={themeChoice}
        onThemeChange={setThemeChoice}
        onConsolidate={() => setConsolidating(true)}
        canSignOut={sessionQuery.data?.active === true}
      />

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
              {/* forceMount: switching tabs cannot drop the camera or the simulation. */}
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

          {picked && (
            <PickedBar picked={picked} pickedScope={pickedScope} onCrystallize={() => setCrystallizing(true)} />
          )}
        </main>

        {/* `contents` keeps the <aside> as a cell; in the graph with no selection it is hidden
            and the grid loses that column so the graph can breathe. */}
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
