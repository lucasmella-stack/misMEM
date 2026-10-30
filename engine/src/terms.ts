/**
 * Tokenización compartida entre la búsqueda por palabras y la medición de uso.
 * Si las dos no parten el texto igual, un recuerdo se encuentra con unas palabras
 * y se da por usado con otras.
 */

// Palabras que una pregunta trae y un recuerdo no: como FTS5 exige todas las de la consulta,
// con ellas adentro una pregunta entera ("¿qué decidimos sobre el deploy?") no encontraba nada.
const STOPWORDS = new Set(
  (
    "a al como con cual cuales cuando cuanta cuantas cuanto cuantos de del donde el en es estar fue la las le lo los me mi " +
    "mas o para por porque que quien se ser sin sobre son su te tu u un una unas unos y ya " +
    // Function words of a question: determiners, auxiliaries, prepositions and adverbs that
    // carry no topic. Leaving them in made the strict AND fail on a word no memory has, and
    // in the rescue they matched half the corpus ("entre" even matched "Entrena" through the
    // four-letter prefix). Measured on the golden corpus: they are the difference between
    // nine off-topic questions with a hit and six.
    "cada hay puede pueden tiene tienen hace hacen hacer entre desde hasta segun durante " +
    "mientras aunque sino tan tanto tanta todo toda todos todas otro otra otros otras mismo misma " +
    "ahora antes despues tambien ademas entonces casi solo " +
    "acordate acorda conta contame cuenta deci decime dime recorda recordas sabe sabes " +
    "the of and to is in for with that was on are by an be this from it as not what which who how why when where do does did"
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

/** Las palabras de la consulta que sirven para buscar por coincidencia. */
export function searchTerms(query: string): string[] {
  const words = split(query);
  const terms = words.filter(carries);
  // Si no quedó ninguna, la consulta va como vino: mejor una búsqueda estricta que una vacía.
  return terms.length > 0 ? terms : words;
}

/** Las palabras que distinguen a un texto, normalizadas y sin repetir. */
export function contentTerms(text: string): Set<string> {
  return new Set(split(text).filter(carries).map(plain));
}
