// Owns FTS5 query syntax: quoting, escaping and token splitting. Kept apart from the
// rescue and the ranking so a change to how a term is quoted has one home.
import { searchTerms } from "../domain/terms.js";

export const quoteFts = (term: string): string => `"${term.replace(/"/g, '""')}"`;

export function escapeFts(query: string): string {
  // Every word quoted: FTS5 joins them with AND and special characters do not break the
  // MATCH. With no words, an empty term matches nothing and avoids an invalid expression.
  const escaped = searchTerms(query).map(quoteFts).join(" ");
  return escaped || '""';
}

// Rescue scores with the same tokenizer that indexes FTS5 (unicode61): `_` and any
// punctuation split words. If one side splits and the other does not, a candidate is
// retrieved by one rule and counted by another, then dropped with zero matches.
export const FTS_TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
