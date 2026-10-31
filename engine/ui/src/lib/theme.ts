/** The theme resolves on the client and is painted with an attribute: the CSP forbids inline scripts. */

export type ThemeChoice = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "mismem-theme";

/** Reading localStorage can throw with third-party cookies blocked. */
export function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === "system") return prefersDark ? "dark" : "light";
  return choice;
}

/**
 * With no storage, blocked reads or garbage stored, it starts dark: that is the design's
 * starting theme and the one that does not depend on the system preference.
 */
export function loadTheme(storage: Pick<Storage, "getItem"> | null): ThemeChoice {
  if (!storage) return "dark";
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored === "dark" || stored === "light" || stored === "system") return stored;
  } catch {
    // Private browsing or restricted permissions: ignored, and the default stands.
  }
  return "dark";
}

/** Saving is best-effort: if the browser refuses the write, the theme keeps working for this visit. */
export function saveTheme(storage: Pick<Storage, "setItem"> | null, choice: ThemeChoice): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, choice);
  } catch {
    // No quota or no permission leaves nothing to do; it must not break the theme change.
  }
}

export function applyTheme(root: HTMLElement, resolved: ResolvedTheme): void {
  root.setAttribute("data-theme", resolved);
}
