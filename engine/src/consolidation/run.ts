import type { Database as DB } from "better-sqlite3";
import { envNonNegativeNumber, envPositiveNumber } from "../env.js";
import { AUTO_BACKFILL_MAX_ROWS, embedPendingMemories } from "../embeddings/store.js";
import { distill, loadLlmConfig, LlmFatalError, type LlmConfig } from "./llm.js";
import {
  beginScope,
  hasCallsLeft,
  newRunState,
  processScope,
  type DistillFn,
  type Limits,
  type RunContext,
  type RunState,
} from "./scope.js";

export interface RunOptions {
  minAgeHours?: number;
  minEpisodesPerScope?: number;
  /** Days without new episodes after which a small scope consolidates anyway. */
  quietDays?: number;
  maxEpisodesPerBatch?: number;
  scopeFilter?: string;
  dryRun?: boolean;
  /** If true, pre-filters L0 episodes (Pareto) and marks them as noise without calling the LLM. Default true. */
  paretoPrefilter?: boolean;
  /** Per-call cap on episode characters; what does not fit stays for the next batch. */
  maxPromptChars?: number;
  /** An episode longer than this travels truncated (head and tail). */
  maxEpisodeChars?: number;
  /** Cap on LLM calls per run; what is left waits for the next one. */
  maxCalls?: number;
  /** Batches in which the LLM may ignore an episode before it counts as noise. */
  uncitedStrikes?: number;
  llm?: LlmConfig;
  distillFn?: DistillFn;
  log?: (msg: string) => void;
}

export interface RunSummary {
  scopes_seen: number;
  scopes_processed: number;
  scopes_skipped_too_few: number;
  scopes_failed: number;
  episodes_consolidated: number;
  episodes_dropped_pareto_l0: number;
  /** Episodes the LLM could not process even alone: they stay pending for the next run. */
  episodes_skipped: number;
  /** Episodes the LLM read and did not cite, with a pending strike: they come back next run. */
  episodes_uncited_pending: number;
  memories_created: number;
  llm_calls: number;
  /** The provider rejected credentials or balance and the run stopped. */
  aborted: boolean;
  errors: { scope: string; error: string }[];
  duration_ms: number;
}

// Two weeks with no new episodes: that scope will not reach the minimum (an old imported
// chat, an abandoned project), and without this it stayed pending forever.
const DEFAULT_QUIET_DAYS = 14;
// The LLM not citing an episode can be real noise or its own mistake. Calling it noise on
// the first try put it in forget's deletion queue; retrying costs the tokens of a batch
// already paid, not an extra call.
const DEFAULT_UNCITED_STRIKES = 3;

interface ScopeRow {
  scope: string;
  n: number;
  newest: number;
}

export async function runConsolidation(
  db: DB,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const t0 = Date.now();
  const minAgeHours = opts.minAgeHours ?? envNonNegativeNumber("MISMEM_CONSOLIDATION_MIN_AGE_HOURS", 24);
  const minEpisodes = opts.minEpisodesPerScope ?? envPositiveNumber("MISMEM_CONSOLIDATION_MIN_EPISODES", 3);
  const quietDays = opts.quietDays ?? envPositiveNumber("MISMEM_CONSOLIDATION_QUIET_DAYS", DEFAULT_QUIET_DAYS);
  const quietBefore = Date.now() - quietDays * 86_400_000;
  const uncitedStrikes = opts.uncitedStrikes ?? envPositiveNumber("MISMEM_CONSOLIDATION_UNCITED_STRIKES", DEFAULT_UNCITED_STRIKES);
  const limits: Limits = {
    maxBatch: opts.maxEpisodesPerBatch ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_BATCH", 60),
    maxPromptChars: opts.maxPromptChars ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_PROMPT_CHARS", 60_000),
    maxEpisodeChars: opts.maxEpisodeChars ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS", 12_000),
    maxCalls: opts.maxCalls ?? envPositiveNumber("MISMEM_CONSOLIDATION_MAX_CALLS", 60),
  };
  const log = opts.log ?? ((m) => console.log(m));
  const cutoff = Date.now() - minAgeHours * 3600 * 1000;

  const summary: RunSummary = {
    scopes_seen: 0,
    scopes_processed: 0,
    scopes_skipped_too_few: 0,
    scopes_failed: 0,
    episodes_consolidated: 0,
    episodes_dropped_pareto_l0: 0,
    episodes_skipped: 0,
    episodes_uncited_pending: 0,
    memories_created: 0,
    llm_calls: 0,
    aborted: false,
    errors: [],
    duration_ms: 0,
  };

  const scopeWhere = opts.scopeFilter ? "AND scope = @scope" : "";
  const scopes = db
    .prepare(
      `SELECT scope, COUNT(*) AS n, MAX(created_at) AS newest FROM episodes
       WHERE consolidated_into IS NULL AND created_at < @cutoff ${scopeWhere}
       GROUP BY scope
       ORDER BY n DESC`,
    )
    .all({ cutoff, scope: opts.scopeFilter ?? null }) as ScopeRow[];

  summary.scopes_seen = scopes.length;
  log(`[consolidation] scopes con episodios pendientes: ${scopes.length}`);

  const ctx: RunContext = {
    db,
    cutoff,
    limits,
    llm: opts.dryRun ? null : opts.llm ?? loadLlmConfig(),
    distillFn: opts.distillFn ?? distill,
    dryRun: opts.dryRun ?? false,
    paretoPrefilter: opts.paretoPrefilter ?? true,
    log,
    uncitedStrikes,
  };
  const state: RunState = newRunState();

  const pendingIn = db.prepare(
    `SELECT COUNT(*) AS n FROM episodes
     WHERE scope = @scope AND consolidated_into IS NULL AND created_at < @cutoff`,
  );

  for (const { scope, n, newest } of scopes) {
    if (n < minEpisodes && newest >= quietBefore) {
      summary.scopes_skipped_too_few++;
      log(`[consolidation] skip scope="${scope}" (${n} < ${minEpisodes})`);
      continue;
    }
    if (!hasCallsLeft(ctx, state)) {
      log(`[consolidation] tope de ${limits.maxCalls} llamadas: el resto queda para la próxima corrida`);
      break;
    }
    try {
      beginScope(state);
      // Batches until the scope is empty or the cap is hit; a batch with no progress stops.
      for (;;) {
        const created = await processScope(ctx, state, scope);
        summary.memories_created += created.memories;
        summary.episodes_consolidated += created.episodes;
        summary.episodes_dropped_pareto_l0 += created.dropped_l0;
        if (created.episodes === 0 && !created.skipped) break;
        if ((pendingIn.get({ scope, cutoff }) as { n: number }).n === 0) break;
        if (!hasCallsLeft(ctx, state)) break;
      }
      summary.episodes_skipped += state.skipped.size;
      summary.episodes_uncited_pending += state.deferred.size;
      summary.scopes_processed++;
    } catch (err) {
      summary.scopes_failed++;
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push({ scope, error: msg });
      log(`[consolidation] ERROR scope="${scope}": ${msg}`);
      if (err instanceof LlmFatalError) {
        summary.aborted = true;
        log("[consolidation] el proveedor rechazó la clave o no hay saldo: corrida cortada");
        break;
      }
    }
  }

  // Copied here, before the backfill, so a future early return cannot report zero calls
  // on a run that already spent them.
  summary.llm_calls = state.llmCalls;

  // Embedding backfill for new memories (and any straggler).
  // Optional: without an embedding server it degrades without affecting consolidation.
  if (!ctx.dryRun) {
    try {
      const emb = await embedPendingMemories(db, {
        timeoutMs: 120_000,
        batchSize: 8,
        maxRows: AUTO_BACKFILL_MAX_ROWS,
      });
      if (emb.pending > 0) {
        log(`[consolidation] embeddings: pendientes=${emb.pending} embebidas=${emb.embedded} fallidas=${emb.failed}`);
      }
    } catch {
      /* the semantic layer never breaks the sleep cycle */
    }
  }

  summary.duration_ms = Date.now() - t0;
  log(
    `[consolidation] DONE en ${summary.duration_ms}ms. memorias=${summary.memories_created} episodios=${summary.episodes_consolidated} llamadas=${summary.llm_calls} fallos=${summary.scopes_failed}`,
  );
  return summary;
}
