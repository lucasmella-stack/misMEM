/**
 * Tokenización compartida entre la búsqueda por palabras y la medición de uso.
 * Si las dos no parten el texto igual, un recuerdo se encuentra con unas palabras
 * y se da por usado con otras.
 */

// Words a question carries and a memory does not: FTS5 requires every query term, so with
// them in the query a whole question ("¿qué decidimos sobre el deploy?") found nothing.
// This list is also what `contentTerms` counts as substance, so it stays conservative:
// adding function words here turned short facts ("solo usar pnpm") into noise in the Pareto
// prefilter and left the strict AND with a single word, which blocked the rescue it was
// meant to enable.
const STOPWORDS = new Set(
  (
    "a al como con cual cuales cuando cuanta cuanto de del donde el en es estar fue la las le lo los me mi " +
    "mas o para por porque que quien se ser sin sobre son su te tu u un una unas unos y ya " +
    "acordate acorda conta contame cuenta deci decime dime recorda recordas sabe sabes " +
    "the of and to is in for with that was on are by an be this from it as not what which who how why when where do does did"
  ).split(" "),
);

// Filler only the rescue can afford to drop. The strict query keeps these, so a question
// still matches on them when they are all it has; the rescue searches with OR and they
// matched half the corpus ("entre" even matched "Entrena" through a four-letter prefix).
// Kept apart from STOPWORDS because `contentTerms` decides with that list whether a short
// episode has enough substance to reach the LLM at all.
const RESCUE_STOPWORDS = new Set(
  (
    "cada hay puede pueden podemos podria tiene tienen tenemos tengo hace hacen hacer " +
    "entre desde hasta segun durante mientras aunque sino tan tanto tanta tantos tantas " +
    "todo toda todos todas otro otra otros otras mismo misma mismos mismas " +
    "ahora antes despues tambien ademas entonces casi solo cuantas cuantos"
  ).split(" "),
);

const MIN_TERM_LENGTH = 3;

export const plain = (word: string): string =>
  word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

const split = (text: string): string[] => text.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);

// Un número corto (un puerto, una versión) distingue; una palabra de dos letras casi nunca.
const carries = (word: string): boolean =>
  (word.length >= MIN_TERM_LENGTH || /\p{N}/u.test(word)) && !STOPWORDS.has(plain(word));

/** Whether the rescue treats the word as filler even though the strict query does not. */
export function isRescueStopword(word: string): boolean {
  return RESCUE_STOPWORDS.has(plain(word));
}

/** Las palabras de la consulta que sirven para buscar por coincidencia. */
export function searchTerms(query: string): string[] {
  const words = split(query);
  const terms = words.filter(carries);
  if (terms.length > 0) return terms;
  // Every word was empty, and a strict search still needs something to match. The filter
  // above dropped these for being stopwords or too short, so length is the only signal
  // left: keep the long ones and fall back to the whole query only when even that leaves
  // nothing ("la de"). Returning every word re-injected the filler ("la de antes" demanded
  // "la"), which no memory has.
  const long = words.filter((word) => word.length >= MIN_TERM_LENGTH);
  return long.length > 0 ? long : words;
}

/** Las palabras que distinguen a un texto, normalizadas y sin repetir. */
export function contentTerms(text: string): Set<string> {
  return new Set(split(text).filter(carries).map(plain));
}
