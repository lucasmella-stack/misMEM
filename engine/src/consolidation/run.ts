import type { Database as DB } from "better-sqlite3";
import { consolidate } from "../tools.js";
import { embedPendingMemories } from "../embeddings/index.js";
import { classify } from "../pareto/classifier.js";
import { distill, loadLlmConfig, type LlmConfig, type DistilledMemory } from "./llm.js";
import { SYSTEM_PROMPT, buildUserPrompt, type EpisodeForPrompt } from "./prompts.js";

export type DistillFn = (
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
) => Promise<DistilledMemory[]>;

export interface RunOptions {
  minAgeHours?: number;
  minEpisodesPerScope?: number;
  maxEpisodesPerBatch?: number;
  scopeFilter?: string;
  dryRun?: boolean;
  /** Si true, pre-filtra episodios L0 (Pareto) y los marca como noise sin llamar al LLM. Default true. */
  paretoPrefilter?: boolean;
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
  memories_created: number;
  errors: { scope: string; error: string }[];
  duration_ms: number;
}

interface ScopeRow {
  scope: string;
  n: number;
}

interface EpisodeRow {
  id: string;
  body: string;
  created_at: number;
}

export async function runConsolidation(
  db: DB,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const t0 = Date.now();
  const minAgeHours = opts.minAgeHours ?? Number(process.env.MISMEM_CONSOLIDATION_MIN_AGE_HOURS ?? 24);
  const minEpisodes = opts.minEpisodesPerScope ?? Number(process.env.MISMEM_CONSOLIDATION_MIN_EPISODES ?? 3);
  const maxBatch = opts.maxEpisodesPerBatch ?? Number(process.env.MISMEM_CONSOLIDATION_MAX_BATCH ?? 60);
  const log = opts.log ?? ((m) => console.log(m));
  const cutoff = Date.now() - minAgeHours * 3600 * 1000;

  const summary: RunSummary = {
    scopes_seen: 0,
    scopes_processed: 0,
    scopes_skipped_too_few: 0,
    scopes_failed: 0,
    episodes_consolidated: 0,
    episodes_dropped_pareto_l0: 0,
    memories_created: 0,
    errors: [],
    duration_ms: 0,
  };

  const scopeWhere = opts.scopeFilter ? "AND scope = @scope" : "";
  const scopes = db
    .prepare(
      `SELECT scope, COUNT(*) AS n FROM episodes
       WHERE consolidated_into IS NULL AND created_at < @cutoff ${scopeWhere}
       GROUP BY scope
       ORDER BY n DESC`,
    )
    .all({ cutoff, scope: opts.scopeFilter ?? null }) as ScopeRow[];

  summary.scopes_seen = scopes.length;
  log(`[consolidation] scopes con episodios pendientes: ${scopes.length}`);

  const llm = opts.dryRun ? null : opts.llm ?? loadLlmConfig();
  const distillFn: DistillFn = opts.distillFn ?? distill;
  const paretoPrefilter = opts.paretoPrefilter ?? true;

  for (const { scope, n } of scopes) {
    if (n < minEpisodes) {
      summary.scopes_skipped_too_few++;
      log(`[consolidation] skip scope="${scope}" (${n} < ${minEpisodes})`);
      continue;
    }
    try {
      const created = await processScope(db, scope, cutoff, maxBatch, llm, distillFn, opts.dryRun ?? false, paretoPrefilter, log);
      summary.scopes_processed++;
      summary.memories_created += created.memories;
      summary.episodes_consolidated += created.episodes;
      summary.episodes_dropped_pareto_l0 += created.dropped_l0;
    } catch (err) {
      summary.scopes_failed++;
      const msg = err instanceof Error ? err.message : String(err);
      summary.errors.push({ scope, error: msg });
      log(`[consolidation] ERROR scope="${scope}": ${msg}`);
    }
  }

  // Backfill de embeddings para las memorias nuevas (y cualquier rezagada).
  // Opcional: si no hay Ollama, degrada sin afectar la consolidación.
  if (!opts.dryRun) {
    try {
      const emb = await embedPendingMemories(db, { timeoutMs: 120_000 });
      if (emb.pending > 0) {
        log(`[consolidation] embeddings: pendientes=${emb.pending} embebidas=${emb.embedded} fallidas=${emb.failed}`);
      }
    } catch {
      /* la capa semántica nunca rompe el ciclo de sueño */
    }
  }

  summary.duration_ms = Date.now() - t0;
  log(
    `[consolidation] DONE en ${summary.duration_ms}ms. memorias=${summary.memories_created} episodios=${summary.episodes_consolidated} fallos=${summary.scopes_failed}`,
  );
  return summary;
}

async function processScope(
  db: DB,
  scope: string,
  cutoff: number,
  maxBatch: number,
  llm: LlmConfig | null,
  distillFn: DistillFn,
  dryRun: boolean,
  paretoPrefilter: boolean,
  log: (m: string) => void,
): Promise<{ memories: number; episodes: number; dropped_l0: number }> {
  const episodes = db
    .prepare(
      `SELECT id, body, created_at FROM episodes
       WHERE scope = @scope AND consolidated_into IS NULL AND created_at < @cutoff
       ORDER BY created_at ASC
       LIMIT @max`,
    )
    .all({ scope, cutoff, max: maxBatch }) as EpisodeRow[];

  if (episodes.length === 0) return { memories: 0, episodes: 0, dropped_l0: 0 };

  // Pareto pre-filter: aparta L0 (ruido) y los marca con stub para forget posterior.
  let dropped_l0 = 0;
  let candidates = episodes;
  if (paretoPrefilter && !dryRun) {
    const noise: EpisodeRow[] = [];
    const keep: EpisodeRow[] = [];
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

  log(`[consolidation] scope="${scope}" -> destilando ${candidates.length} episodios (post-pareto)`);

  if (dryRun || !llm) {
    log(`[consolidation] dryRun: skip LLM call`);
    return { memories: 0, episodes: 0, dropped_l0 };
  }

  const forPrompt: EpisodeForPrompt[] = candidates.map((e) => ({
    id: e.id,
    body: e.body,
    created_at: e.created_at,
  }));
  const distilled = await distillFn(llm, SYSTEM_PROMPT, buildUserPrompt(scope, forPrompt));

  if (distilled.length === 0) {
    log(`[consolidation] scope="${scope}" -> LLM dijo "sin se\u00f1al", marcando ${candidates.length} como noise-consolidated`);
    const stub = consolidate(db, {
      scope,
      gist: `[noise] ${candidates.length} episodios sin se\u00f1al consolidable (${new Date(cutoff).toISOString().slice(0, 10)})`,
      source_episode_ids: candidates.map((e) => e.id),
    });
    db.prepare("UPDATE memories SET salience = 0.1 WHERE id = ?").run(stub.memory_id);
    return { memories: 1 + (dropped_l0 > 0 ? 1 : 0), episodes: stub.consolidated + dropped_l0, dropped_l0 };
  }

  const validIds = new Set(candidates.map((e) => e.id));
  let totalEpisodes = dropped_l0;
  let totalMemories = dropped_l0 > 0 ? 1 : 0;

  for (const m of distilled) {
    const evidence = m.evidence_episode_ids.filter((id) => validIds.has(id));
    if (evidence.length === 0) {
      log(`[consolidation] skip memoria sin evidencia v\u00e1lida: "${m.gist.slice(0, 60)}"`);
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
    totalMemories++;
    totalEpisodes += result.consolidated;
  }

  return { memories: totalMemories, episodes: totalEpisodes, dropped_l0 };
}
