import type { Database as DB } from "better-sqlite3";
import { consolidate } from "../tools.js";
import { envNonNegativeNumber, envPositiveNumber } from "../env.js";
import { AUTO_BACKFILL_MAX_ROWS, embedPendingMemories } from "../embeddings/store.js";
import { classify } from "../pareto/classifier.js";
import {
  distill,
  loadLlmConfig,
  LlmFatalError,
  LlmInvalidJsonError,
  LlmTruncatedError,
  type LlmConfig,
  type DistilledMemory,
} from "./llm.js";
import { SYSTEM_PROMPT, buildUserPrompt, type EpisodeForPrompt } from "./prompts.js";

type DistillFn = (
  cfg: LlmConfig,
  systemPrompt: string,
  userPrompt: string,
) => Promise<DistilledMemory[]>;

export interface RunOptions {
  minAgeHours?: number;
  minEpisodesPerScope?: number;
  /** Días sin episodios nuevos tras los que un ámbito chico se consolida igual. */
  quietDays?: number;
  maxEpisodesPerBatch?: number;
  scopeFilter?: string;
  dryRun?: boolean;
  /** Si true, pre-filtra episodios L0 (Pareto) y los marca como noise sin llamar al LLM. Default true. */
  paretoPrefilter?: boolean;
  /** Tope de caracteres de episodios por llamada; lo que no entra queda para la tanda siguiente. */
  maxPromptChars?: number;
  /** Un episodio más largo que esto viaja recortado (principio y final). */
  maxEpisodeChars?: number;
  /** Tope de llamadas al LLM por corrida; lo pendiente queda para la próxima. */
  maxCalls?: number;
  /** Tandas en que el LLM puede ignorar un episodio antes de darlo por ruido. */
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
  /** Episodios que el LLM no logró procesar ni solos: siguen pendientes para la próxima corrida. */
  episodes_skipped: number;
  /** Episodios que el LLM leyó y no citó, con strike pendiente: vuelven en la próxima corrida. */
  episodes_uncited_pending: number;
  memories_created: number;
  llm_calls: number;
  /** El proveedor rechazó credenciales o saldo y la corrida se cortó. */
  aborted: boolean;
  errors: { scope: string; error: string }[];
  duration_ms: number;
}

interface Limits {
  maxBatch: number;
  maxPromptChars: number;
  maxEpisodeChars: number;
  maxCalls: number;
}

// Lo que buildUserPrompt suma por episodio: id, fecha y separador.
const PROMPT_OVERHEAD_PER_EPISODE = 60;
const TRUNCATION_MARK = "\n[recortado]\n";
// Dos semanas sin episodios nuevos: ese ámbito ya no va a juntar el mínimo (una charla vieja
// importada, un proyecto que se dejó) y sin esto quedaba pendiente para siempre.
const DEFAULT_QUIET_DAYS = 14;
// Que el LLM no cite un episodio puede ser ruido real o un olvido suyo. Darlo por ruido
// a la primera lo ponía en la fila de borrado de forget; reintentarlo cuesta los tokens
// de una tanda que ya se paga, no una llamada extra.
const DEFAULT_UNCITED_STRIKES = 3;

export function truncateEpisode(body: string, max: number): string {
  if (body.length <= max) return body;
  const room = max - TRUNCATION_MARK.length;
  // Un tope más chico que la marca daría cortes negativos y un texto más largo que el tope.
  if (room <= 0) return body.slice(0, Math.max(0, max));
  const head = Math.ceil(room * 0.75);
  return body.slice(0, head) + TRUNCATION_MARK + body.slice(body.length - (room - head));
}

interface ScopeRow {
  scope: string;
  n: number;
  newest: number;
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

  const llm = opts.dryRun ? null : opts.llm ?? loadLlmConfig();
  const distillFn: DistillFn = opts.distillFn ?? distill;
  const paretoPrefilter = opts.paretoPrefilter ?? true;

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
    if (summary.llm_calls >= limits.maxCalls) {
      log(`[consolidation] tope de ${limits.maxCalls} llamadas: el resto queda para la próxima corrida`);
      break;
    }
    try {
      // Cuántos episodios entran en una respuesta; baja si una respuesta llega cortada.
      const cap = { episodes: Number.POSITIVE_INFINITY };
      const calls = {
        canCall: () => summary.llm_calls < limits.maxCalls,
        onCall: () => summary.llm_calls++,
      };
      // Lo que no entró ni solo en esta corrida: no se reintenta hasta la próxima.
      const skipped = new Set<string>();
      // Lo que el LLM leyó y no citó: tampoco se repaga en esta corrida.
      const deferred = new Set<string>();
      // Tandas hasta vaciar el ámbito o llegar al tope; una tanda sin avance corta.
      for (;;) {
        const created = await processScope(
          db, scope, cutoff, limits, llm, distillFn, opts.dryRun ?? false, paretoPrefilter, log,
          calls, cap, skipped, deferred, uncitedStrikes,
        );
        summary.memories_created += created.memories;
        summary.episodes_consolidated += created.episodes;
        summary.episodes_dropped_pareto_l0 += created.dropped_l0;
        if (created.episodes === 0 && !created.skipped) break;
        if ((pendingIn.get({ scope, cutoff }) as { n: number }).n === 0) break;
        if (summary.llm_calls >= limits.maxCalls) break;
      }
      summary.episodes_skipped += skipped.size;
      summary.episodes_uncited_pending += deferred.size;
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

  // Backfill de embeddings para las memorias nuevas (y cualquier rezagada).
  // Opcional: si no hay Ollama, degrada sin afectar la consolidación.
  if (!opts.dryRun) {
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
      /* la capa semántica nunca rompe el ciclo de sueño */
    }
  }

  summary.duration_ms = Date.now() - t0;
  log(
    `[consolidation] DONE en ${summary.duration_ms}ms. memorias=${summary.memories_created} episodios=${summary.episodes_consolidated} llamadas=${summary.llm_calls} fallos=${summary.scopes_failed}`,
  );
  return summary;
}

async function processScope(
  db: DB,
  scope: string,
  cutoff: number,
  limits: Limits,
  llm: LlmConfig | null,
  distillFn: DistillFn,
  dryRun: boolean,
  paretoPrefilter: boolean,
  log: (m: string) => void,
  calls: { canCall: () => boolean; onCall: () => void },
  cap: { episodes: number },
  skipped: Set<string>,
  deferred: Set<string>,
  uncitedStrikes: number,
): Promise<{ memories: number; episodes: number; dropped_l0: number; skipped?: boolean }> {
  const episodes = (
    db
      .prepare(
        `SELECT id, body, created_at FROM episodes
         WHERE scope = @scope AND consolidated_into IS NULL AND created_at < @cutoff
         ORDER BY created_at ASC
         LIMIT @max`,
      )
      .all({ scope, cutoff, max: limits.maxBatch + skipped.size + deferred.size }) as EpisodeRow[]
  )
    .filter((e) => !skipped.has(e.id) && !deferred.has(e.id))
    .slice(0, limits.maxBatch);

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

  // Sólo viaja lo que entra en el presupuesto; el resto queda pendiente para la tanda siguiente.
  const forPrompt: EpisodeForPrompt[] = [];
  let used = 0;
  for (const e of candidates) {
    if (forPrompt.length >= cap.episodes) break;
    const body = truncateEpisode(e.body, limits.maxEpisodeChars);
    const cost = body.length + PROMPT_OVERHEAD_PER_EPISODE;
    if (forPrompt.length > 0 && used + cost > limits.maxPromptChars) break;
    forPrompt.push({ id: e.id, body, created_at: e.created_at });
    used += cost;
  }
  candidates = candidates.slice(0, forPrompt.length);

  log(`[consolidation] scope="${scope}" -> destilando ${candidates.length} episodios (post-pareto)`);

  if (dryRun || !llm) {
    log(`[consolidation] dryRun: skip LLM call`);
    return { memories: 0, episodes: 0, dropped_l0 };
  }

  if (!calls.canCall()) return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
  let distilled: DistilledMemory[];
  for (;;) {
    calls.onCall();
    try {
      distilled = await distillFn(llm, SYSTEM_PROMPT, buildUserPrompt(scope, forPrompt));
      break;
    } catch (err) {
      const splittable = err instanceof LlmTruncatedError || err instanceof LlmInvalidJsonError;
      if (splittable && forPrompt.length === 1) {
        // Marcarlo ruido lo borraba con el próximo forget; fallar trababa el ámbito cada noche
        // contra el mismo episodio. Queda pendiente y la corrida sigue con el resto.
        const why = err instanceof LlmTruncatedError ? "respuesta cortada" : "JSON inválido";
        log(`[consolidation] scope="${scope}" -> ${why} con 1 episodio: queda pendiente para la próxima corrida`);
        for (const e of candidates) skipped.add(e.id);
        // Con JSON inválido el veneno era el episodio, no el tamaño: la tanda vuelve a llenarse.
        // Con respuesta cortada el tope chico se mantiene: el modelo no entra más.
        if (err instanceof LlmInvalidJsonError) cap.episodes = Number.POSITIVE_INFINITY;
        return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0, skipped: true };
      }
      if (!splittable) throw err;
      cap.episodes = Math.floor(forPrompt.length / 2);
      forPrompt.length = cap.episodes;
      candidates = candidates.slice(0, cap.episodes);
      const why = err instanceof LlmTruncatedError ? "respuesta cortada" : "JSON inválido";
      log(`[consolidation] scope="${scope}" -> ${why}, reintento con ${cap.episodes} episodios`);
      if (!calls.canCall()) return { memories: dropped_l0 > 0 ? 1 : 0, episodes: dropped_l0, dropped_l0 };
    }
  }

  const validIds = new Set(candidates.map((e) => e.id));
  const cited = new Set<string>();
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
    for (const id of evidence) cited.add(id);
    totalMemories++;
    totalEpisodes += result.consolidated;
  }

  // Lo que el LLM leyó y no citó puede no tener señal, o puede habérsele pasado. Cada
  // tanda sin citar suma un strike y recién al agotarlos pasa a ruido; mientras le queden,
  // vuelve en la próxima corrida. Una lista vacía ("sin señal") cuenta igual para toda la
  // tanda: antes la mandaba entera a ruido a la primera, y un mal día del modelo (o un
  // episodio que le pide devolver la lista vacía) se llevaba hasta maxBatch episodios.
  // Una respuesta con todo inventado, en cambio, deja los episodios pendientes y sin strike.
  if (distilled.length === 0) {
    log(`[consolidation] scope="${scope}" -> LLM dijo "sin se\u00f1al" para ${candidates.length} episodios: strike a todos`);
  }
  const uncited =
    distilled.length === 0 ? candidates : cited.size > 0 ? candidates.filter((e) => !cited.has(e.id)) : [];
  if (uncited.length > 0) {
    const bump = db.prepare("UPDATE episodes SET uncited_count = uncited_count + 1 WHERE id = ?");
    const strikesOf = db.prepare("SELECT uncited_count FROM episodes WHERE id = ?");
    const exhausted: EpisodeRow[] = [];
    const retry: EpisodeRow[] = [];
    db.transaction(() => {
      for (const e of uncited) {
        bump.run(e.id);
        const row = strikesOf.get(e.id) as { uncited_count: number };
        if (row.uncited_count >= uncitedStrikes) exhausted.push(e);
        else retry.push(e);
      }
    })();

    for (const e of retry) deferred.add(e.id);
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

  return { memories: totalMemories, episodes: totalEpisodes, dropped_l0 };
}
