// One batch of a scope: which episodes go in, what the LLM is asked and what is recorded of
// what it returned. `run.ts` repeats it until the scope is empty or the calls run out.
import type { Database as DB } from "better-sqlite3";
import { consolidate } from "../memory/consolidate.js";
import type { EpisodeRow } from "../store/rows.js";
import { fitPrompt } from "./budget.js";
import { classify } from "./pareto.js";
import {
  LlmInvalidJsonError,
  LlmTruncatedError,
  type DistilledMemory,
  type LlmConfig,
} from "./llm.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";

export type DistillFn = (
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
) => Promise<DistilledMemory[]>;

export interface Limits {
  maxBatch: number;
  maxPromptChars: number;
  maxEpisodeChars: number;
  maxCalls: number;
}

/** The fixed part of a run: it does not change across scopes or batches. */
export interface RunContext {
  db: DB;
  cutoff: number;
  limits: Limits;
  llm: LlmConfig | null;
  distillFn: DistillFn;
  dryRun: boolean;
  paretoPrefilter: boolean;
  log: (msg: string) => void;
  uncitedStrikes: number;
}

/**
 * What is spent and what counts as seen. Calls last the whole run; the batch cap and the
 * episodes already seen belong to each scope, and `beginScope` clears them.
 */
export interface RunState {
  llmCalls: number;
  /** How many episodes fit in one answer; it drops if an answer comes back truncated. */
  cap: { episodes: number };
  /** What did not fit even alone in this run: it is not retried until the next one. */
  skipped: Set<string>;
  /** What the LLM read and did not cite: it is not paid again in this run either. */
  deferred: Set<string>;
}

/** What one batch added to the summary; `skipped` warns that something is left for next time. */
interface ScopeOutcome {
  memories: number;
  episodes: number;
  dropped_l0: number;
  skipped?: boolean;
  /**
   * Memories distilled in this batch, so the run can ask the backfill for their vectors
   * first. Noise stubs are left out: the backfill never embeds them.
   */
  memory_ids?: string[];
}

/** Only the columns the batch query selects. */
type PendingEpisodeRow = Pick<EpisodeRow, "id" | "body" | "created_at">;

export function newRunState(): RunState {
  return {
    llmCalls: 0,
    cap: { episodes: Number.POSITIVE_INFINITY },
    skipped: new Set(),
    deferred: new Set(),
  };
}

/** Call spending is not touched: it belongs to the run, not to the scope. */
export function beginScope(state: RunState): void {
  state.cap.episodes = Number.POSITIVE_INFINITY;
  state.skipped.clear();
  state.deferred.clear();
}

/** There is call budget left; `limits.maxCalls` is the run's cap. */
export function hasCallsLeft(ctx: RunContext, state: RunState): boolean {
  return state.llmCalls < ctx.limits.maxCalls;
}

export async function processScope(
  ctx: RunContext,
  state: RunState,
  scope: string,
): Promise<ScopeOutcome> {
  const { db, cutoff, limits, llm, distillFn, dryRun, paretoPrefilter, log, uncitedStrikes } = ctx;
  const episodes = (
    db
      .prepare(
        `SELECT id, body, created_at FROM episodes
         WHERE scope = @scope AND consolidated_into IS NULL AND created_at < @cutoff
         ORDER BY created_at ASC
         LIMIT @max`,
      )
      .all({ scope, cutoff, max: limits.maxBatch + state.skipped.size + state.deferred.size }) as PendingEpisodeRow[]
  )
    .filter((e) => !state.skipped.has(e.id) && !state.deferred.has(e.id))
    .slice(0, limits.maxBatch);

  if (episodes.length === 0) return { memories: 0, episodes: 0, dropped_l0: 0 };

  // Pareto pre-filter: sets L0 (noise) aside and marks it with a stub for a later forget.
  let dropped_l0 = 0;
  let candidates = episodes;
  if (paretoPrefilter && !dryRun) {
    const noise: PendingEpisodeRow[] = [];
    const keep: PendingEpisodeRow[] = [];
    const seen: string[] = [];
    for (const e of episodes) {
      const r = classify(e.body, { neighbors: seen.slice(-5) });
      if (r.level === 0) noise.push(e);
      else keep.push(e);
      seen.push(e.body);
    }
    if (noise.length > 0) {
      const stub = consolidate(db, {
        scope,
        gist: `[pareto:l0] ${noise.length} episodios filtrados por baja importancia`,
        source_episode_ids: noise.map((e) => e.id),
      });
      db.prepare("UPDATE memories SET salience = 0.05 WHERE id = ?").run(stub.memory_id);
      dropped_l0 = noise.length;
      log(`[consolidation] scope="${scope}" pareto L0 -> ${noise.length} episodios drop`);
    }
    candidates = keep;
  }

  if (candidates.length === 0) {
    return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
  }

  // Only what fits the budget travels; the rest stays pending for the next batch.
  const forPrompt = fitPrompt(candidates, {
    maxEpisodes: state.cap.episodes,
    maxPromptChars: limits.maxPromptChars,
    maxEpisodeChars: limits.maxEpisodeChars,
  });
  candidates = candidates.slice(0, forPrompt.length);

  log(`[consolidation] scope="${scope}" -> destilando ${candidates.length} episodios (post-pareto)`);

  if (dryRun || !llm) {
    log(`[consolidation] dryRun: skip LLM call`);
    return { memories: 0, episodes: 0, dropped_l0 };
  }

  if (!hasCallsLeft(ctx, state)) return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
  let distilled: DistilledMemory[];
  for (;;) {
    state.llmCalls++;
    try {
      distilled = await distillFn(llm, SYSTEM_PROMPT, buildUserPrompt(scope, forPrompt));
      break;
    } catch (err) {
      const splittable = err instanceof LlmTruncatedError || err instanceof LlmInvalidJsonError;
      if (splittable && forPrompt.length === 1) {
        // Marking it noise deleted it with the next forget; failing blocked the scope every
        // night on the same episode. It stays pending and the run goes on with the rest.
        const why = err instanceof LlmTruncatedError ? "respuesta cortada" : "JSON inválido";
        log(`[consolidation] scope="${scope}" -> ${why} con 1 episodio: queda pendiente para la próxima corrida`);
        for (const e of candidates) state.skipped.add(e.id);
        // With invalid JSON the poison was the episode, not the size: the batch fills again.
        // With a truncated answer the small cap stays: the model does not fit more.
        if (err instanceof LlmInvalidJsonError) state.cap.episodes = Number.POSITIVE_INFINITY;
        return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0, skipped: true };
      }
      if (!splittable) throw err;
      state.cap.episodes = Math.floor(forPrompt.length / 2);
      forPrompt.length = state.cap.episodes;
      candidates = candidates.slice(0, state.cap.episodes);
      const why = err instanceof LlmTruncatedError ? "respuesta cortada" : "JSON inválido";
      log(`[consolidation] scope="${scope}" -> ${why}, reintento con ${state.cap.episodes} episodios`);
      if (!hasCallsLeft(ctx, state)) return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
    }
  }

  const validIds = new Set(candidates.map((e) => e.id));
  const cited = new Set<string>();
  let totalEpisodes = dropped_l0;
  let totalMemories = dropped_l0 > 0 ? 1 : 0;
  const createdIds: string[] = [];

  for (const m of distilled) {
    // An episode belongs to one memory: `consolidated_into` holds a single id. When the model
    // cites the same one twice, the first memory keeps it and the second looks for other
    // evidence, because consolidate() refuses to take an episode another memory already owns.
    const evidence = m.evidence_episode_ids.filter((id) => validIds.has(id) && !cited.has(id));
    if (evidence.length === 0) {
      // The gist is the user's own text and this log reaches console and the viewer, so it
      // carries the count instead: enough to tell a skip from a failure.
      log(
        `[consolidation] scope="${scope}" -> skip memoria: sus ${m.evidence_episode_ids.length} episodios citados ya estaban tomados o no son válidos`,
      );
      continue;
    }
    const result = consolidate(db, {
      scope,
      gist: m.gist,
      details: m.details ?? undefined,
      source_episode_ids: evidence,
    });
    const initialSalience = m.confidence ?? 0.7;
    db.prepare("UPDATE memories SET salience = ? WHERE id = ?").run(initialSalience, result.memory_id);
    for (const id of evidence) cited.add(id);
    totalMemories++;
    totalEpisodes += result.consolidated;
    createdIds.push(result.memory_id);
  }

  // What the LLM read and did not cite may carry no signal, or it may have missed it. Each
  // uncited batch adds a strike, and only at the last one does it become noise; while strikes
  // remain it returns next run. An empty list ("no signal") counts for the whole batch: before,
  // it sent everything to noise on the first try, and one bad model day (or an episode asking
  // for the empty list) wiped up to maxBatch; all invented leaves them pending and unstruck.
  if (distilled.length === 0) {
    log(`[consolidation] scope="${scope}" -> LLM dijo "sin se\u00f1al" para ${candidates.length} episodios: strike a todos`);
  }
  const uncited =
    distilled.length === 0 ? candidates : cited.size > 0 ? candidates.filter((e) => !cited.has(e.id)) : [];
  if (uncited.length > 0) {
    const bump = db.prepare("UPDATE episodes SET uncited_count = uncited_count + 1 WHERE id = ?");
    const strikesOf = db.prepare("SELECT uncited_count FROM episodes WHERE id = ?");
    const exhausted: PendingEpisodeRow[] = [];
    const retry: PendingEpisodeRow[] = [];
    db.transaction(() => {
      for (const e of uncited) {
        bump.run(e.id);
        const row = strikesOf.get(e.id) as { uncited_count: number };
        if (row.uncited_count >= uncitedStrikes) exhausted.push(e);
        else retry.push(e);
      }
    })();

    for (const e of retry) state.deferred.add(e.id);
    if (retry.length > 0) {
      log(`[consolidation] scope="${scope}" -> ${retry.length} sin citar con strike, vuelven en la próxima corrida`);
    }

    if (exhausted.length > 0) {
      const stub = consolidate(db, {
        scope,
        gist: `[noise] ${exhausted.length} episodio${exhausted.length === 1 ? "" : "s"} sin citar en ${uncitedStrikes} tandas`,
        source_episode_ids: exhausted.map((e) => e.id),
      });
      db.prepare("UPDATE memories SET salience = 0.05 WHERE id = ?").run(stub.memory_id);
      totalMemories++;
      totalEpisodes += stub.consolidated;
    }
  }

  return { memories: totalMemories, episodes: totalEpisodes, dropped_l0, memory_ids: createdIds };
}
