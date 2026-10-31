// Always mounted so a screen reader announces the message when it appears: a live region has
// to exist before its content changes. Classes only, no inline styles, so the viewer CSP stays.
export function EmbeddingNoticeView({ message }: { message: string | null }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={message ? "border-b border-edge bg-field px-3 py-1.5 text-xs text-ink-soft sm:px-4" : undefined}
    >
      {message}
    </p>
  );
}
