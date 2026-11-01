// Owns what the three layer views of the detail panel share: their props, ink tint, truncation, section title, the loading and failure states and the confirmation dialog.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { Selection } from "@/lib/selection";
import { errorMessage } from "../lib/errors";
import { inkPercent } from "../lib/ink";

export interface DetailViewProps {
  id: string;
  onSelect: (selection: Selection) => void;
  onChanged: (next?: Selection | null) => void;
  onAnnounce: (text: string) => void;
}

export const tint = (salience: number): string =>
  `color-mix(in oklab, var(--color-ink) ${inkPercent(salience)}%, var(--color-ink-muted))`;

export const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-muted">{children}</h3>;
}

export function DetailLoading({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <span role="status" className="sr-only">
        {label}
      </span>
      <Skeleton className="h-5 w-24 bg-field" />
      <Skeleton className="h-20 w-full bg-field" />
      <Skeleton className="h-28 w-full bg-field" />
    </div>
  );
}

export function DetailFailure({ what, error }: { what: string; error: unknown }) {
  return (
    <p role="alert" className="rounded-md bg-field px-2 py-2 text-sm text-danger">
      No se pudo cargar {what}: {errorMessage(error)}
    </p>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  variant = "destructive",
  busy,
  blocked,
  error,
  onDismiss,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  variant?: "default" | "destructive";
  busy: boolean;
  blocked: boolean;
  error: string | undefined;
  onDismiss: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-danger">
            No se pudo: {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            variant={variant}
            disabled={busy || blocked}
            onClick={(event) => {
              // The dialog must not close on its own: a failed write is read in place.
              event.preventDefault();
              onConfirm();
            }}
          >
            {busy ? "Un momento…" : confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
