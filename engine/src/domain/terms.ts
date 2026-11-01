// Shared tokenization for word search and usage measurement: if the two split the text
// differently, a memory is found with some words and counted as used with others.

// Words a question brings and a memory does not: FTS5 requires every query term, so with
// them in it a whole question ("¿qué decidimos sobre el deploy?") matched nothing.
const STOPWORDS = new Set(
  (
    "a al como con cual cuales cuando cuanta cuanto de del donde el en es estar fue la las le lo los me mi " +
    "mas o para por porque que quien se ser sin sobre son su te tu u un una unas unos y ya " +
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

// A short number (a port, a version) distinguishes; a two-letter word almost never does.
const carries = (word: string): boolean =>
  (word.length >= MIN_TERM_LENGTH || /\p{N}/u.test(word)) && !STOPWORDS.has(plain(word));

/** The query words that are worth searching for. */
export function searchTerms(query: string): string[] {
  const words = split(query);
  const terms = words.filter(carries);
  // If none is left, the query goes as it came: a strict search beats an empty one.
  return terms.length > 0 ? terms : words;
}

/** The words that distinguish a text, normalized and deduplicated. */
export function contentTerms(text: string): Set<string> {
  return new Set(split(text).filter(carries).map(plain));
}
