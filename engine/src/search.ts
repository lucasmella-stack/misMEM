// Owns FTS query building, rescue and ranking for recall, apart from tools.ts so a ranking change does not share a diff with the write paths.
import type { Database as DB } from "better-sqlite3";
import type { RecallInput, RecallHit } from "./schema.js";
import { excludeNoiseSql } from "./noise.js";
import { plain, searchTerms } from "./terms.js";
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

// Cuántos términos informativos distintos tienen que coincidir. Con uno se colaría
// cualquier recuerdo que comparta una palabra rara pero ajena; con dos, el candidato tiene
// que hablar de lo mismo por dos sitios. Las palabras comunes no cuentan.
const RELAXED_MIN_INFORMATIVE = 2;
// En una pregunta larga, dos coincidencias no son prueba aunque sean raras: la proporción
// sube el mínimo con el tamaño de la consulta. Se mide sobre TODAS las palabras buscadas,
// no sólo las informativas: en un corpus diminuto casi todo sale raro y dos palabras
// comunes bastan para rescatar una pregunta ajena y larga, como comprueba el test de la
// pregunta de astronomía. Con la base informativa el banco de ajenas seguía a cero, pero
// ese caso se colaba. Las informativas siguen mandando en la cuenta de coincidencias y en
// el orden; aquí sólo fijan cuántas hacen falta.
const RELAXED_MIN_RATIO = 0.3;
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
  /** Palabras distintas antes de juntar prefijos: dice si la consulta es de una sola. */
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
      if (!word || seen.has(word)) continue;
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
 * Los términos que pueden distinguir dentro de este corpus. La frecuencia se mide sólo
 * sobre las memorias, así que un término ausente de ellas sale con 0, el valor más raro
 * posible: no puede casar con ninguna memoria y por eso no altera el rescate de esa capa,
 * pero sí puede casar con un episodio o un rasgo, que no están en `memories_fts`.
 * Descartarlo dejaba esos dos rescates vacíos en cuanto sus palabras no aparecían en
 * ninguna memoria, y con la tabla de memorias vacía pasaba siempre (instalación recién
 * nacida, sin capa semántica), que es justo el caso que el rescate tiene que cubrir.
 * El precio: un episodio que comparta con una pregunta ajena dos palabras ausentes de todas
 * las memorias se rescata ("cambiar la configuración del móvil" frente a la del servidor),
 * tenga la base las memorias que tenga. Lo que lo frena es que esas palabras sean comunes
 * en las memorias, por encima de `rare`. Es el camino degradado, donde traer algo flojo
 * cuesta menos que no traer nada.
 *
 * Un término que sale en todas las memorias también entra: con el corpus diminuto de un
 * test o de una instalación recién nacida, "todos los documentos" no es ruido sino el
 * tema del que hablan, y el IDF no tiene resolución para distinguirlo. En un corpus
 * grande, que una palabra ajena a la consulta aparezca en todas las memorias es
 * improbable; si aparece, es el tema y merece contar. El total sale del mismo conjunto
 * que la frecuencia, sin ruido, para que las dos comparaciones hablen del mismo corpus.
 */
function informativeTerms(db: DB, terms: RelaxedTerm[]): RelaxedTerm[] {
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
  return terms.filter((term) => {
    const frequency = documentFrequency(db, term);
    return frequency <= rare || frequency === total;
  });
}

/**
 * Cuántos términos informativos distintos de la consulta aparecen en el texto, contando
 * por el mismo prefijo con el que se buscó. Las palabras comunes no entran en la cuenta:
 * coincidir en "sistema" en una pregunta sobre planetas no prueba nada. Los tokens se
 * parten como FTS5 (`_` incluido), o `columna_beta` no casaría con `beta`.
 *
 * Un token más corto que PREFIX_FROM_LENGTH no casa por prefijo. Con el recorte actual,
 * "solar" baja a "sola" y una palabra de cuatro letras puede ser otra cualquiera; sin la
 * guarda, "una sola pasada" contaba como coincidencia de "solar" y rescataba una pregunta
 * ajena. Se pierde el plural que busca un singular de cuatro letras ("flores" → "flor"),
 * que el recorte tampoco encontraba en el sentido contrario.
 */
function countRelaxedMatches(text: string, terms: RelaxedTerm[]): number {
  const tokens = plain(text)
    .split(FTS_TOKEN_SPLIT)
    .filter(Boolean);
  return terms.reduce((count, { word, prefix }) => {
    const found = tokens.some((token) =>
      prefix
        ? token.length >= PREFIX_FROM_LENGTH && token.startsWith(prefix)
        : token === word,
    );
    return found ? count + 1 : count;
  }, 0);
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
 * Deja sólo los candidatos del rescate que alcanzan el mínimo de términos informativos y
 * los ordena por esas coincidencias, no por la saliencia ni por la antigüedad. El tope
 * evita que el rescate se convierta en una segunda lista.
 */
function relaxRows<T extends RankedCandidate>(
  rows: T[],
  informative: RelaxedTerm[],
  queryWords: number,
): T[] {
  if (rows.length === 0 || informative.length === 0) return [];
  // Una consulta de una sola palabra no puede juntar dos coincidencias. No hace falta
  // exigirle longitud: si el rescate llegó aquí es porque el prefijo cambió la consulta, y
  // el prefijo ya exige PREFIX_FROM_LENGTH letras; una palabra corta va exacta y no se
  // rescata. En el resto, la proporción sube el mínimo con el tamaño de la consulta.
  const required =
    queryWords === 1
      ? 1
      : Math.max(RELAXED_MIN_INFORMATIVE, Math.ceil(queryWords * RELAXED_MIN_RATIO));
  // Si no hay tantos términos informativos como exige la consulta, nadie puede llegar.
  if (informative.length < required) return [];
  return rows
    .map((row) => ({
      row,
      matches: countRelaxedMatches(row.search_text ?? row.text, informative),
    }))
    .filter(({ matches }) => matches >= required)
    .sort(
      (a, b) =>
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
  // Sólo se consulta la frecuencia cuando de verdad hace falta rescatar: son hasta doce
  // cuentas sobre memories_fts que una búsqueda normal no debe pagar.
  let rescuedTerms: RelaxedTerm[] | null = null;
  let rescuedWordCount = 0;
  let rows = strictRows;
  if (strictEmpty && rescue) {
    const { terms, wordCount } = relaxedTerms(input.query);
    const relaxed = relaxedFts(terms);
    if (relaxed !== strict) {
      rows = run(relaxed);
      rescuedTerms = informativeTerms(db, terms);
      // La proporción cuenta lo que de verdad se busca; RELAXED_MAX_TERMS ya recortó la
      // consulta, y exigir por palabras que no llegaron a buscar sería inalcanzable.
      rescuedWordCount = Math.min(wordCount, RELAXED_MAX_TERMS);
    }
  }
  const traits: RecallHit[] = (
    rescuedTerms
      ? relaxRows(rows.traits, rescuedTerms, rescuedWordCount)
      : rows.traits
  ).map(({ fts_rank: _ftsRank, ...row }) => ({
    layer: "trait" as const,
    ...row,
  }));
  const episodes: RecallHit[] = (
    rescuedTerms
      ? relaxRows(rows.episodes, rescuedTerms, rescuedWordCount)
      : rows.episodes
  ).map(({ fts_rank: _ftsRank, ...row }) => ({
    layer: "episode" as const,
    ...row,
  }));

  // El rescate ya viene ordenado por coincidencias y recortado a RELAXED_MAX_RESULTS. El
  // estricto conserva el orden de FTS5 y desempata por la saliencia ya decaída: la cruda
  // favorecía lo que se usó hace mucho y no es la que ve el cliente en el hit.
  const orderedMemories = rescuedTerms
    ? relaxRows(rows.memories, rescuedTerms, rescuedWordCount)
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
