import { useEffect, useRef, useState, type RefObject } from "react";
import { m } from "motion/react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { Selection } from "@/lib/selection";
import { EpisodeView } from "./EpisodeView";
import { MemoryView } from "./MemoryView";
import { TraitView } from "./TraitView";

interface DetailProps {
  selected: Selection | undefined;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  /** Refreshes whatever depends on the write and, when given, changes or closes the selection. */
  onChanged: (next?: Selection | null) => void;
}


/**
 * On desktop the detail lives in the third column; on mobile, in a Radix Sheet, which brings
 * focus trapping and returns it on close. Only one of the two mounts.
 */
export function DetailPanel(props: DetailProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const [announcement, setAnnouncement] = useState("");
  const titleRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const lastSelection = useRef<string | undefined>(undefined);

  // On desktop the detail is not modal: opening it moves focus to the title and closing it
  // returns focus to the row that opened it if still mounted. On mobile the Radix Sheet does it.
  useEffect(() => {
    if (!isDesktop) return;
    const key = props.selected ? `${props.selected.layer}:${props.selected.id}` : undefined;
    if (key === lastSelection.current) return;
    // Only the first opening records the origin: chaining selections inside the detail itself
    // cannot replace it with a button that is about to unmount.
    const opening = lastSelection.current === undefined;
    lastSelection.current = key;
    if (key) {
      if (opening) {
        const active = document.activeElement;
        openerRef.current = active instanceof HTMLElement ? active : null;
      }
      titleRef.current?.focus();
      return;
    }
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }, [props.selected, isDesktop]);

  // D14: the live region mounts once and only its text changes; a region born populated is not
  // announced. It lives here so it survives every selection.
  useEffect(() => {
    if (!props.selected) setAnnouncement("");
  }, [props.selected]);

  const live = (
    <p className="sr-only" aria-live="polite">
      {announcement}
    </p>
  );

  if (isDesktop) {
    return (
      <aside aria-label="Detalle" className="min-h-0 overflow-y-auto border-l border-edge bg-surface-raised">
        {live}
        {props.selected ? (
          <Detail
            key={`${props.selected.layer}:${props.selected.id}`}
            {...props}
            selected={props.selected}
            titleRef={titleRef}
            onAnnounce={setAnnouncement}
          />
        ) : (
          <p className="p-4 text-sm text-ink-muted">Elige un recuerdo para ver de dónde sale y qué lo cita.</p>
        )}
      </aside>
    );
  }

  return (
    <Sheet open={props.selected !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="sr-only">
          <SheetTitle>Detalle del recuerdo</SheetTitle>
          <SheetDescription>Contenido del elemento seleccionado.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {live}
          {props.selected && (
            <Detail
              key={`${props.selected.layer}:${props.selected.id}`}
              {...props}
              selected={props.selected}
              titleRef={titleRef}
              onAnnounce={setAnnouncement}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Detail({
  selected,
  onSelect,
  onClose,
  onChanged,
  titleRef,
  onAnnounce,
}: DetailProps & {
  selected: Selection;
  titleRef: RefObject<HTMLElement | null>;
  onAnnounce: (text: string) => void;
}) {
  return (
    <m.article
      ref={titleRef}
      tabIndex={-1}
      aria-labelledby="detail-title"
      className="p-4 outline-none"
      data-layer={selected.layer}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 id="detail-title" className="text-[11px] uppercase tracking-wider text-ink-muted">
          Detalle
        </h2>
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          Cerrar
        </Button>
      </div>
      {selected.layer === "memory" && (
        <MemoryView
          key={selected.id}
          id={selected.id}
          onSelect={onSelect}
          onChanged={onChanged}
          onAnnounce={onAnnounce}
        />
      )}
      {selected.layer === "trait" && (
        <TraitView
          key={selected.id}
          id={selected.id}
          onSelect={onSelect}
          onChanged={onChanged}
          onAnnounce={onAnnounce}
        />
      )}
      {selected.layer === "episode" && <EpisodeView selection={selected} onAnnounce={onAnnounce} />}
    </m.article>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
