// Owns FTS query building, rescue and ranking for recall, apart from tools.ts so a ranking change does not share a diff with the write paths.
import type { Database as DB } from "better-sqlite3";
import type { RecallInput, RecallHit } from "./schema.js";
import { excludeNoiseSql } from "./noise.js";
import { isRescueStopword, plain, searchTerms } from "./terms.js";
import type { SemanticHit } from "./embeddings/store.js";
import { effectiveSalience, type SalienceRow } from "./salience.js";

export const CANDIDATE_POOL_LIMIT = 50;
const MEMORY_FTS_SCAN_LIMIT = 200;
const RRF_K = 60;
// Menor que un puesto de RRF en la cima (1/61 - 1/62 ≈ 0.00026): ahí la saliencia
// sólo desempata. Más abajo los puestos se achican (≈ 0.00008 al final de los 50
// candidatos) y una saliencia alta puede adelantar dos o tres lugares.
const SALIENCE_RRF_WEIGHT = 0.0002;
// A trait is one broad rule, so it matches many questions by meaning and can crowd out the
// specific memory that answers them. On the golden corpus, letting the fusion return every
// trait dropped memory first hits from 329 to 293; keeping only the best one and up to two
// episodes (the rest of the result stays memories) restored 328 without losing a question
// type against the lexical baseline.
export const MAX_TRAIT_HITS = 1;
export const MAX_EPISODE_HITS = 2;
// A memory is already distilled and curated; an episode is raw and a trait is a compressed
// rule. On near-equal cosine, prefer the consolidated record. A layer still wins when its
// meaning is clearly closer, so this is a tie-break, not a restored layer order.
export const CONSOLIDATED_SEMANTIC_PRIOR = 0.05;
// A trait is one short, broad rule, so its cosine with any on-topic question runs high even
// when the rule is not what was asked. It must clear the shared threshold by a margin;
// episodes are long and specific enough to need a smaller one. Measured on the golden
// corpus: without either margin, general traits and long unrelated episodes made off-topic
// questions return something; 0.06 keeps 21/24 trait hits and 0.01 keeps 23/24 episode hits
// without raising the off-topic count.
export const TRAIT_SCORE_MARGIN = 0.06;
export const EPISODE_SCORE_MARGIN = 0.01;

const quoteFts = (term: string): string => `"${term.replace(/"/g, '""')}"`;

function escapeFts(query: string): string {
  // Cada palabra entre comillas: FTS5 las une con AND y los caracteres especiales no rompen el MATCH.
  // Sin palabras, un término vacío no matchea nada y evita una expresión inválida.
  const escaped = searchTerms(query).map(quoteFts).join(" ");
  return escaped || '""';
}

// El tokenizador no reduce a raíz: sin esto "controlo" no encuentra "controlan" ni "deudas"
// encuentra "deuda". Una palabra de 5 letras o más busca por su principio, sin las últimas
// tres (que es donde cambian género, número y conjugación) y nunca por menos de 4.
const PREFIX_FROM_LENGTH = 5;
const PREFIX_TRIM = 3;
const PREFIX_MIN = 4;

// El rescate puntúa con el mismo tokenizador que indexa FTS5 (unicode61): `_` y cualquier
// signo separan palabras. Si un lado parte y el otro no, se recupera por un criterio y se
// cuenta por otro, y el candidato se descarta con cero coincidencias.
const FTS_TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

// How many matching words a rescued record needs. One is too easy: any record sharing a
// rare but unrelated word would come back. The exception is a one-word query, which cannot
// reach two. The rescue sees at most RELAXED_MAX_TERMS words, so a bar that grew with the
// query would stop growing at twelve and change silently if that cap moved; two is what
// the golden corpus supports.
const RELAXED_MIN_INFORMATIVE = 2;
// A query is mostly made of words no record contains when it is about something else. In
// that case the few words that do exist are not evidence: the astronomy question of the
// unit test keeps only "sistema" out of seven content words. Requiring 30 % of the query
// words (stopwords excluded, before the term cap) to exist keeps it out, while a real long
// question leaves most of its words in the corpus.
const RELAXED_MIN_PRESENT_RATIO = 0.3;
// A record matched only by generic words proves nothing, so at least one rare word is
// required. Two made no difference to off-topic questions once the added function words
// were stopwords (8/48 with 9 hits either way), but cost two colloquial questions and nine
// questions overall on the golden corpus, so one stays.
const RELAXED_MIN_RARE_MATCHES = 1;
// Un término es raro cuando aparece en pocas memorias; los que salen en muchas no
// distinguen una paráfrasis de una casualidad (la idea del IDF de bm25). El suelo de 3
// documentos protege corpus pequeños, donde una fracción sola marcaría casi todo como
// común; la fracción crece con la base para que "pocas" signifique lo mismo en una memoria
// de 300 recuerdos que en una de 3.000. Se calibra con `mismem-bench --off-topic` sobre el
// banco privado: se sube la fracción mientras las preguntas ajenas sigan sin traer nada y
// se elige la mayor que las deje a cero, para rescatar el máximo de paráfrasis sin colar
// falsos positivos.
const RELAXED_RARE_MIN_DOCS = 3;
const RELAXED_RARE_FRACTION = 0.05;
// El rescate es un último recurso, no una segunda lista: tres recuerdos bastan para
// recuperar la paráfrasis y no convierten la respuesta en un volcado. Este es el único
// tope del rescate; el estricto conserva el suyo de candidatos.
const RELAXED_MAX_RESULTS = 3;
// Tope de palabras para que la consulta de rescate no crezca sin límite.
const RELAXED_MAX_TERMS = 12;

interface RelaxedTerm {
  word: string;
  /** Principio por el que se busca; null si la palabra es demasiado corta y va exacta. */
  prefix: string | null;
}

interface RelaxedQuery {
  /** Términos que se buscan y se cuentan, ya sin prefijos repetidos. */
  terms: RelaxedTerm[];
  /**
   * Distinct content words before merging prefixes and before the term cap: it says whether
   * the query has a single word, and it is the denominator of the presence gate, which is
   * measured over the whole question and not over what the rescue actually searches.
   */
  wordCount: number;
}

/**
 * Las palabras del rescate, ya normalizadas y sin repetir. La raíz aproximada sale de los
 * mismos constantes que la búsqueda por prefijo: quitar las últimas tres letras es donde
 * cambian género, número y conjugación. Cada palabra se parte como la parte FTS5, porque
 * un identificador con guion bajo son dos tokens para el índice y uno solo aquí.
 */
function relaxedTerms(query: string): RelaxedQuery {
  const seen = new Set<string>();
  const terms: RelaxedTerm[] = [];
  for (const term of searchTerms(query)) {
    for (const word of plain(term).split(FTS_TOKEN_SPLIT)) {
      // The rescue drops filler the strict query keeps, through its own list: the strict
      // AND needs those words to match when they are the whole query, but an OR over them
      // only adds candidates that share nothing.
      if (!word || seen.has(word) || isRescueStopword(word)) continue;
      seen.add(word);
      terms.push({
        word,
        prefix:
          word.length < PREFIX_FROM_LENGTH
            ? null
            : word.slice(0, Math.max(PREFIX_MIN, word.length - PREFIX_TRIM)),
      });
    }
  }
  return {
    terms: dedupeByPrefix(terms).slice(0, RELAXED_MAX_TERMS),
    wordCount: terms.length,
  };
}

/**
 * Junta los términos que buscan por el mismo principio: `decidir` (`deci`) y `decision`
 * (`decis`) los satisface el mismo token, así que dejarlos sueltos permitiría cumplir el
 * mínimo de dos coincidencias con una sola palabra. Se queda el prefijo más largo, que es
 * el más específico y el que menos candidatos ajenos arrastra.
 */
function dedupeByPrefix(terms: RelaxedTerm[]): RelaxedTerm[] {
  const kept: RelaxedTerm[] = [];
  const prefixes: string[] = [];
  for (const term of terms) {
    const prefix = term.prefix ?? term.word;
    const clash = prefixes.findIndex(
      (other) => prefix.startsWith(other) || other.startsWith(prefix),
    );
    if (clash === -1) {
      kept.push(term);
      prefixes.push(prefix);
    } else if (prefix.length > (prefixes[clash]?.length ?? 0)) {
      kept[clash] = term;
      prefixes[clash] = prefix;
    }
  }
  return kept;
}

/**
 * La consulta de rescate cuando la estricta no encontró nada: una sola expresión con OR de
 * todas las palabras. FTS5 ya no decide si el recuerdo vale; sólo trae candidatos baratos.
 */
function relaxedFts(terms: RelaxedTerm[]): string {
  const expressions = terms.map(({ word, prefix }) =>
    prefix ? `${quoteFts(prefix)}*` : quoteFts(word),
  );
  return expressions.join(" OR ") || '""';
}

/**
 * En cuántas memorias distintas aparece el término, con el mismo prefijo que usa el
 * rescate. Se mide sobre `memories_fts` (gist + details, el mismo texto que se puntúa) y
 * no sobre la capa que se rescata: las memorias son el corpus consolidado donde se
 * acumula el vocabulario genérico, mientras rasgos y episodios son dispersos y ahí casi
 * todo parecería raro. Ese cero sólo dice que el término no está en las memorias, no que
 * no exista en el recall: rasgos y episodios no viven en esta tabla. Cuenta sin filtrar
 * por scope porque el vocabulario es de la persona, no del proyecto, y así el umbral no
 * cambia de una memoria pequeña a otra grande. El ruido que `forget` conserva no es
 * conocimiento: se excluye igual que en la búsqueda, o empujaría un término real por
 * encima de `rare`.
 */
function documentFrequency(db: DB, term: RelaxedTerm): number {
  const q = term.prefix ? `${quoteFts(term.prefix)}*` : quoteFts(term.word);
  const row = db
    .prepare(
      `SELECT count(*) AS n
       FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
       WHERE memories_fts MATCH ? AND ${excludeNoiseSql("m")}`,
    )
    .get(q) as { n: number };
  return row.n;
}

/**
 * A query word with its weight. The frequency is measured over the consolidated memories
 * (the layer where generic vocabulary accumulates), so 0 means "no memory has it": it can
 * still live in a trait or a pending episode, which is why presence is also checked
 * against the candidates, not only against this count.
 */
interface PlannedTerm {
  term: RelaxedTerm;
  /** Memories where the term appears; 0 means it may still live in traits or episodes. */
  frequency: number;
  /** Surfaces rarer words first when ordering the rescue; log(1 + N / (1 + df)). */
  idf: number;
  /** Rare enough to tell records apart, or present in every memory (tiny corpus topic). */
  informative: boolean;
}

/**
 * What the rescue is allowed to demand from this query. `wordCount` is the number of
 * distinct content words in the question, before the term cap; `terms` keeps only the ones
 * at least one candidate contains. Words no record has are context noise: they cannot
 * match, and counting them made long questions ask for more coincidences than their answer
 * could possibly provide.
 */
interface RelaxedPlan {
  terms: PlannedTerm[];
  /** Content words of the question, without the rescue's term cap. */
  wordCount: number;
}

/**
 * One pass of document frequencies for every query term. The rescue used to run this same
 * count to decide rarity; it now also decides which words exist at all, so a long question
 * stops paying for the names and filler no record contains. Total and frequency come from
 * the same noise-filtered set so both comparisons talk about the same corpus.
 */
function planTerms(
  db: DB,
  terms: readonly RelaxedTerm[],
  wordCount: number,
  rows: readonly RankedCandidate[],
): RelaxedPlan {
  const total = (
    db
      .prepare(
        `SELECT count(*) AS n
         FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
         WHERE ${excludeNoiseSql("m")}`,
      )
      .get() as { n: number }
  ).n;
  const rare = Math.max(RELAXED_RARE_MIN_DOCS, Math.ceil(total * RELAXED_RARE_FRACTION));
  const candidateTokens = rows.map((row) => tokensOf(row.search_text ?? row.text));
  const planned: PlannedTerm[] = [];
  for (const term of terms) {
    const frequency = documentFrequency(db, term);
    const inCandidates = candidateTokens.some((tokens) => termInTokens(tokens, term));
    // A word that is neither in the memories nor in any candidate cannot match anything;
    // keeping it only inflated the required number of coincidences.
    if (frequency === 0 && !inCandidates) continue;
    planned.push({
      term,
      frequency,
      idf: Math.log(1 + total / (1 + frequency)),
      // A term present in every memory is the corpus topic, not noise, and a term absent
      // from the memories may still distinguish an episode or a trait.
      informative: frequency <= rare || frequency === total,
    });
  }
  return { terms: planned, wordCount };
}

/** FTS5 splits on every non-letter, including `_`; the rescue has to count the same way. */
function tokensOf(text: string): string[] {
  return plain(text)
    .split(FTS_TOKEN_SPLIT)
    .filter(Boolean);
}

/**
 * Whether a token satisfies a query term. A token shorter than PREFIX_FROM_LENGTH cannot
 * match by prefix: "solar" trims to "sola", and without the guard any four-letter word
 * counted as an inflection, rescuing an unrelated question ("una sola pasada").
 */
function termInTokens(tokens: readonly string[], { word, prefix }: RelaxedTerm): boolean {
  return tokens.some((token) =>
    prefix
      ? token.length >= PREFIX_FROM_LENGTH && token.startsWith(prefix)
      : token === word,
  );
}

interface TraitCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

interface MemoryCandidate extends SalienceRow {
  id: string;
  scope: string;
  /** Lo que se devuelve: el gist. */
  text: string;
  /** Lo que indexa FTS5 y sobre lo que se cuenta: gist y detalles. */
  search_text: string;
  created_at: number;
  fts_rank: number;
}

interface EpisodeCandidate {
  id: string;
  scope: string;
  text: string;
  created_at: number;
}

/** Lo mínimo para ordenar candidatos rescatados: texto, id y puesto de FTS5. */
interface RankedCandidate {
  id: string;
  /** Lo que se devuelve al cliente. */
  text: string;
  /** Lo que indexa FTS5; si falta, se puntúa `text` (rasgos y episodios). */
  search_text?: string;
  fts_rank: number;
}

type TraitRow = TraitCandidate & { fts_rank: number };
type EpisodeRow = EpisodeCandidate & { fts_rank: number };

/**
 * Keeps only rescued candidates that clear the bar and orders them by how much they
 * explain the question, not by salience or age. The cap keeps the rescue a last resort
 * instead of a second result list.
 */
function relaxRows<T extends RankedCandidate>(rows: T[], plan: RelaxedPlan): T[] {
  if (rows.length === 0) return [];
  const terms = plan.terms;
  if (terms.length === 0 || !terms.some(({ informative }) => informative)) return [];
  // If most of the question is about things no record contains, the few words that do
  // exist are not evidence; this keeps a long off-topic question from being rescued by two
  // generic words while a real long question still passes with most of its words present.
  if (terms.length / plan.wordCount < RELAXED_MIN_PRESENT_RATIO) return [];
  // A one-word query cannot reach two matches; anything else asks for two. The exception
  // is the original query having one word, not the plan keeping one term: two forms of the
  // same word dedupe to a single prefix and must still count as one coincidence, or
  // "decidir decision" rescues a memory that only says "decision".
  const singleWord = plan.wordCount === 1;
  const required = singleWord ? 1 : RELAXED_MIN_INFORMATIVE;
  // A one-word query has only one term to match, so asking for two rare ones would make
  // the rescue unreachable ("deudas" against "la deuda").
  const rareRequired = singleWord ? 1 : RELAXED_MIN_RARE_MATCHES;
  return rows
    .map((row) => {
      const tokens = tokensOf(row.search_text ?? row.text);
      const matched = terms.filter(({ term }) => termInTokens(tokens, term));
      return {
        row,
        matches: matched.length,
        informative: matched.filter(({ informative }) => informative).length,
        weight: matched.reduce((sum, { idf }) => sum + idf, 0),
      };
    })
    // A candidate made only of common words proves nothing; one rare word is the minimum
    // signal, and the count of all matches still has to clear two.
    .filter(
      ({ matches, informative }) => matches >= required && informative >= rareRequired,
    )
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        b.informative - a.informative ||
        b.matches - a.matches ||
        Number(a.row.fts_rank) - Number(b.row.fts_rank) ||
        a.row.id.localeCompare(b.row.id),
    )
    .slice(0, RELAXED_MAX_RESULTS)
    .map(({ row }) => row);
}

export function lexicalCandidates(
  db: DB,
  input: ReturnType<typeof RecallInput.parse>,
  at: number,
  /** Sin capa semántica que responda, el rescate es lo único que encuentra una frase natural. */
  { rescue = true }: { rescue?: boolean } = {},
): {
  traits: RecallHit[];
  memories: RecallHit[];
  episodes: RecallHit[];
} {
  const strict = escapeFts(input.query);
  const scopeFilter = input.scope ? "AND t.scope = @scope" : "";

  const traitStmt = db.prepare(
    `SELECT t.id, t.scope, t.name AS text, t.created_at, rank AS fts_rank
     FROM traits_fts f JOIN traits t ON t.rowid = f.rowid
     WHERE traits_fts MATCH @q ${scopeFilter}
     ORDER BY rank, t.id LIMIT @limit`,
  );

  const memoryStmt = db.prepare(
    `SELECT m.id, m.scope, m.gist AS text,
            m.gist || ' ' || COALESCE(m.details, '') AS search_text,
            m.salience, m.created_at,
            m.last_accessed_at, m.salience_updated_at, rank AS fts_rank
     FROM memories_fts f JOIN memories m ON m.rowid = f.rowid
     WHERE memories_fts MATCH @q ${input.scope ? "AND m.scope = @scope" : ""}
       AND ${excludeNoiseSql("m")}
     ORDER BY rank, m.salience DESC, m.id LIMIT @limit`,
  );

  const episodeStmt = db.prepare(
    `SELECT e.id, e.scope, e.body AS text, e.created_at, rank AS fts_rank
     FROM episodes_fts f JOIN episodes e ON e.rowid = f.rowid
     WHERE episodes_fts MATCH @q ${input.scope ? "AND e.scope = @scope" : ""}
       AND e.consolidated_into IS NULL
     ORDER BY e.created_at DESC, e.id LIMIT @limit`,
  );

  const run = (q: string): {
    traits: TraitRow[];
    memories: MemoryCandidate[];
    episodes: EpisodeRow[];
  } => ({
    traits: traitStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as TraitRow[],
    memories: memoryStmt.all({
      q,
      scope: input.scope,
      limit: MEMORY_FTS_SCAN_LIMIT,
    }) as MemoryCandidate[],
    episodes: episodeStmt.all({ q, scope: input.scope, limit: CANDIDATE_POOL_LIMIT }) as EpisodeRow[],
  });

  // La estricta manda sobre la consulta entera: si encontró algo en cualquier capa, el
  // resultado es el de siempre. El rescate sólo entra cuando no hubo ni un candidato, para
  // que una paráfrasis no altere una búsqueda que ya funcionaba.
  const strictRows = run(strict);
  const strictEmpty =
    strictRows.traits.length === 0 &&
    strictRows.memories.length === 0 &&
    strictRows.episodes.length === 0;
  // Frequencies are only needed when the rescue actually runs: up to twelve counts over
  // memories_fts that a normal search must not pay.
  let rescuedPlan: RelaxedPlan | null = null;
  let rows = strictRows;
  if (strictEmpty && rescue) {
    const { terms, wordCount } = relaxedTerms(input.query);
    const relaxed = relaxedFts(terms);
    if (relaxed !== strict) {
      rows = run(relaxed);
      // The presence gate is measured over the whole question, not over the capped search:
      // a word past the cap was part of what the question is about, and letting the cap
      // shrink the denominator would pass questions mostly about things no record has.
      rescuedPlan = planTerms(
        db,
        terms,
        wordCount,
        [...rows.traits, ...rows.memories, ...rows.episodes],
      );
    }
  }
  const traits: RecallHit[] = (
    rescuedPlan
      ? relaxRows(rows.traits, rescuedPlan)
      : rows.traits
  ).map(({ fts_rank: _ftsRank, ...row }) => ({
    layer: "trait" as const,
    ...row,
  }));
  const episodes: RecallHit[] = (
    rescuedPlan
      ? relaxRows(rows.episodes, rescuedPlan)
      : rows.episodes
  ).map(({ fts_rank: _ftsRank, ...row }) => ({
    layer: "episode" as const,
    ...row,
  }));

  // El rescate ya viene ordenado por coincidencias y recortado a RELAXED_MAX_RESULTS. El
  // estricto conserva el orden de FTS5 y desempata por la saliencia ya decaída: la cruda
  // favorecía lo que se usó hace mucho y no es la que ve el cliente en el hit.
  const orderedMemories = rescuedPlan
    ? relaxRows(rows.memories, rescuedPlan)
    : rows.memories.sort(
        (a, b) =>
          Number(a.fts_rank) - Number(b.fts_rank) ||
          effectiveSalience(b, at) - effectiveSalience(a, at) ||
          a.id.localeCompare(b.id),
      );
  const memories: RecallHit[] = orderedMemories
    .slice(0, CANDIDATE_POOL_LIMIT)
    .map((r) => ({
      layer: "memory" as const,
      id: r.id,
      scope: r.scope,
      text: r.text,
      salience: effectiveSalience(r, at),
      created_at: r.created_at,
    }));

  return {
    traits,
    memories,
    episodes,
  };
}

export function semanticHitToRecall(hit: SemanticHit, at: number): RecallHit {
  return {
    layer: "memory",
    id: hit.id,
    scope: hit.scope,
    text: hit.text,
    salience: effectiveSalience(hit, at),
    created_at: hit.created_at,
    via: "semantic",
  };
}

/**
 * Si la búsqueda semántica de esta consulta tiene algo que puntuar: algún vector del mismo
 * modelo (si se filtró por modelo) y mismas dimensiones en el ámbito. Sin ninguno, el vector
 * de la consulta no encuentra nada y el recall queda en manos de lo léxico.
 *
 * Lleva los mismos filtros de selección que `semanticSearchMemories` (ámbito, modelo, dims y
 * ruido), no su corte por puntuación: un vector de ruido nunca se puntúa, así que no puede
 * encender la capa. El backfill no excluía el ruido hasta tarde, así que hay bases con vectores
 * de memorias `[noise]` y `[pareto:l0]`.
 */
export function hasComparableVectors(
  db: DB,
  opts: { model?: string; dims: number; scope?: string },
): boolean {
  const filters = [
    opts.scope ? "m.scope = @scope" : null,
    opts.model ? "e.model = @model" : null,
    "e.dims = @dims",
    excludeNoiseSql("m"),
  ].filter((value): value is string => value !== null);
  return (
    db
      .prepare(
        `SELECT 1 FROM memory_embeddings e JOIN memories m ON m.id = e.memory_id
         WHERE ${filters.join(" AND ")} LIMIT 1`,
      )
      .get({ scope: opts.scope, model: opts.model, dims: opts.dims }) !== undefined
  );
}

export interface RankedSource {
  hits: readonly RecallHit[];
  /** Relative weight of the source in the fusion; 1 for the words of the query. */
  weight: number;
}

/**
 * One list for all three layers: each source contributes 1/(K + rank), so a hit found by
 * several signals (exact words, meaning, the rescue) rises, and no layer keeps a fixed
 * step over another. Salience only breaks ties, as it did among memories.
 */
export function fuseHits(sources: readonly RankedSource[]): RecallHit[] {
  const candidates = new Map<string, { hit: RecallHit; rrf: number }>();

  for (const source of sources) {
    source.hits.forEach((hit, index) => {
      // Every layer has the same source weight. A 1.15 trait multiplier was measured to
      // move a trait nine ranks ahead of a memory at the top (1.15/61 vs 1/61); on the
      // golden corpus that made memories lose the first place without a compensating win.
      const contribution = source.weight / (RRF_K + index + 1);
      const key = `${hit.layer}:${hit.id}`;
      const current = candidates.get(key);
      if (current) {
        current.rrf += contribution;
        return;
      }
      candidates.set(key, { hit, rrf: contribution });
    });
  }

  return [...candidates.values()]
    .sort((a, b) => {
      const scoreA = a.rrf + (a.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      const scoreB = b.rrf + (b.hit.salience ?? 0) * SALIENCE_RRF_WEIGHT;
      return (
        scoreB - scoreA ||
        (b.hit.salience ?? 0) - (a.hit.salience ?? 0) ||
        b.hit.created_at - a.hit.created_at ||
        a.hit.id.localeCompare(b.hit.id)
      );
    })
    .map(({ hit }) => hit);
}
