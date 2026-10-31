import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { actions, api, type ConsolidationState, type ScopeCount } from "../api";
import { errorMessage } from "../lib/errors";

interface Props {
  open: boolean;
  scope: string | undefined;
  scopes: ScopeCount[] | undefined;
  onClose: () => void;
}

const POLL_MS = 2000;

type Phase = "loading" | "error" | "confirm" | "running" | "done";

/**
 * Consolidate now: confirms the cost, starts the run on the server and shows how it goes.
 * If one is already running when it opens (another tab), it shows that one instead of starting another.
 */
export function Consolidate({ open, scope, scopes, onClose }: Props) {
  const queryClient = useQueryClient();
  const [onlyScope, setOnlyScope] = useState(Boolean(scope));
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string>();
  const [startedHere, setStartedHere] = useState(false);
  const wasRunning = useRef(false);

  const jobQuery = useQuery({
    queryKey: ["consolidation"],
    queryFn: ({ signal }) => api.consolidation(signal),
    enabled: open,
    retry: false,
    // TanStack never overlaps requests, and a failing poll stops the interval instead of
    // hammering the server; the error phase below tells the user.
    refetchInterval: (query) => (query.state.data?.running && !query.state.error ? POLL_MS : false),
  });

  useEffect(() => {
    if (!open) return;
    setOnlyScope(Boolean(scope));
    setStartedHere(false);
    setStartError(undefined);
    wasRunning.current = false;
  }, [open, scope]);

  // The run finished: lists and scopes can already read new memories.
  const job = jobQuery.data;
  useEffect(() => {
    if (!job) return;
    if (job.running) {
      wasRunning.current = true;
      return;
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      void queryClient.invalidateQueries();
    }
  }, [job, queryClient]);

  const pendingInScope = scopes
    ?.filter((entry) => !(onlyScope && scope) || entry.scope === scope)
    .reduce((total, entry) => total + entry.episodes_pending, 0);

  const phase: Phase = !job
    ? jobQuery.isError
      ? "error"
      : "loading"
    : job.running
      ? "running"
      : startedHere
        ? "done"
        : "confirm";

  const start = async () => {
    setStarting(true);
    setStartError(undefined);
    try {
      const state = await actions.consolidate(onlyScope ? scope : undefined);
      queryClient.setQueryData<ConsolidationState>(["consolidation"], state);
      setStartedHere(true);
      toast.success("Consolidación lanzada.");
    } catch (err) {
      setStartError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  };

  const log = job?.log ?? [];
  const lastLine = log[log.length - 1] ?? "";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Consolidar ahora</DialogTitle>
          <DialogDescription>
            Un LLM lee los episodios sin consolidar y los resume en memorias.
          </DialogDescription>
        </DialogHeader>

        {phase === "loading" && (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span role="status" className="sr-only">
              Comprobando si ya hay una consolidación en curso…
            </span>
            <Skeleton className="h-5 w-2/3 bg-field" />
            <Skeleton className="h-16 w-full bg-field" />
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-2">
            <p role="alert" className="rounded-md bg-field px-2 py-1.5 text-sm text-danger">
              No se pudo consultar el estado de la consolidación: {errorMessage(jobQuery.error)}
            </p>
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => void jobQuery.refetch()}>
                Reintentar
              </Button>
            </div>
          </div>
        )}

        {phase === "confirm" && (
          <div className="flex flex-col gap-3 text-sm text-ink-soft">
            <p>
              Cada tanda es una llamada a la API del proveedor configurado en el servidor, así que cuesta dinero; los
              topes de la consolidación siguen valiendo.
            </p>
            {pendingInScope !== undefined && (
              <p className="text-ink-muted">
                Hay {pendingInScope === 1 ? "1 episodio" : `${pendingInScope} episodios`} sin consolidar. Los de menos de
                un día esperan a la próxima.
              </p>
            )}
            {scope && (
              <label htmlFor="consolidate-only-scope" className="flex items-center justify-between gap-3">
                <span>Sólo el ámbito {scope}</span>
                <Switch
                  id="consolidate-only-scope"
                  checked={onlyScope}
                  onCheckedChange={setOnlyScope}
                  aria-label={`Sólo el ámbito ${scope}`}
                />
              </label>
            )}
          </div>
        )}

        {(phase === "running" || phase === "done") && job && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-ink-soft">
              {job.running
                ? `En curso${job.scope ? ` en ${job.scope}` : ""}. Puedes cerrar esto: sigue en el servidor.`
                : job.error
                  ? `Falló: ${job.error}`
                  : "Terminó."}
            </p>
            {job.summary && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                <dt className="text-ink-muted">Memorias nuevas</dt>
                <dd className="tabular-nums text-ink-soft">{job.summary.memories_created}</dd>
                <dt className="text-ink-muted">Episodios consolidados</dt>
                <dd className="tabular-nums text-ink-soft">{job.summary.episodes_consolidated}</dd>
                <dt className="text-ink-muted">Llamadas al LLM</dt>
                <dd className="tabular-nums text-ink-soft">{job.summary.llm_calls}</dd>
                <dt className="text-ink-muted">Ámbitos con error</dt>
                <dd className="tabular-nums text-ink-soft">{job.summary.scopes_failed}</dd>
              </dl>
            )}
            {/* The visible log is not a live region: announcing ten lines would flood a
                screen reader, so only the last line goes to the sr-only paragraph. */}
            <pre className="max-h-40 overflow-auto rounded-md bg-field p-2 text-[11px] leading-relaxed text-ink-soft">
              {log.slice(-10).join("\n") || "Esperando la primera línea…"}
            </pre>
            <p className="sr-only" aria-live="polite">
              {lastLine}
            </p>
          </div>
        )}

        {jobQuery.isError && job && (
          <p role="status" className="rounded-md bg-field px-2 py-1.5 text-sm text-ink-muted">
            Se perdió la conexión al consultar el avance: {errorMessage(jobQuery.error)}. Vuelve a intentarlo para
            seguir la corrida.
            <Button type="button" variant="ghost" size="xs" className="ml-2" onClick={() => void jobQuery.refetch()}>
              Reintentar
            </Button>
          </p>
        )}

        {startError && (
          <p role="alert" className="rounded-md bg-field px-2 py-1.5 text-sm text-danger">
            No se pudo: {startError}
          </p>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {phase === "confirm" ? "Cancelar" : "Cerrar"}
          </Button>
          {phase === "confirm" && (
            <Button type="button" onClick={() => void start()} disabled={starting} aria-busy={starting}>
              {starting ? "Arrancando…" : "Consolidar ahora"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
