import { useEffect, type RefObject } from "react";
import type { Selection } from "@/lib/selection";

/** Radix mounts its dialogs outside <dialog>: Escape must respect both worlds. */
function hasOpenDialog(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], dialog[open]',
    ),
  );
}

/**
 * `/` focuses the search and Escape closes the detail, unless a dialog is open: that one closes
 * itself and the detail must stay behind.
 */
export function useGlobalShortcuts(
  searchRef: RefObject<HTMLInputElement | null>,
  setSelected: (selection: Selection | undefined) => void,
): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const editing =
        target !== null &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (event.key === "/" && !editing && !hasOpenDialog() && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      // Escape closes the detail unless an open dialog is using it, since that one closes itself.
      if (event.key === "Escape" && !hasOpenDialog()) setSelected(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [searchRef, setSelected]);
}
