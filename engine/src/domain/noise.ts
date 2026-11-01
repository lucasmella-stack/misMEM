// Noise markers: memories that exist only so `forget` knows which episodes to delete.
// They carry no knowledge, so they must not compete in recall or spend an embedding;
// `forget` and the viewer still see them.

export const NOISE_GIST_PREFIXES = ["[noise] ", "[pareto:l0] "] as const;

/** Lets the bench assert that no marker leaked into recall. */
export function isNoiseGist(gist: string): boolean {
  return NOISE_GIST_PREFIXES.some((prefix) => gist.startsWith(prefix));
}
