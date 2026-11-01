interface Tokens {
  brand: string;
  ink: string;
  inkMuted: string;
  inkSoft: string;
  edge: string;
}

const FALLBACK_TOKENS: Tokens = {
  brand: "#f087ad",
  ink: "#e8e4dc",
  inkMuted: "#a09c93",
  inkSoft: "#d2cec6",
  edge: "rgb(255 255 255 / 0.14)",
};

let cachedTheme: string | undefined;
let cachedTokens: Tokens = FALLBACK_TOKENS;

/**
 * Tokens are read from the CSS, not copied: the canvas repaints with the new theme without
 * remounting the graph. The cache is dropped when `data-theme` changes, not on every frame.
 */
export function tokensNow(): Tokens {
  const theme = document.documentElement.dataset.theme ?? "dark";
  if (theme !== cachedTheme) {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    cachedTokens = {
      brand: read("--color-brand", FALLBACK_TOKENS.brand),
      ink: read("--color-ink", FALLBACK_TOKENS.ink),
      inkMuted: read("--color-ink-muted", FALLBACK_TOKENS.inkMuted),
      inkSoft: read("--color-ink-soft", FALLBACK_TOKENS.inkSoft),
      edge: read("--color-edge", FALLBACK_TOKENS.edge),
    };
    cachedTheme = theme;
  }
  return cachedTokens;
}
