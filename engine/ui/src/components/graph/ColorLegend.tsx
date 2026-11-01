/** What each colour means in the drawing. Its own file so the panel stays under its ratchet. */
export function ColorLegend({
  label,
  entries,
  rest,
}: {
  label: string;
  entries: Array<{ key: string; name: string; color: string }>;
  /** Shown when something on screen is left unpainted, so grey is not read as a category. */
  rest?: string;
}) {
  if (entries.length === 0) return null;
  return (
    <ul className="flex max-h-36 flex-col gap-1 overflow-y-auto" aria-label={label}>
      {entries.map((entry) => (
        <li key={entry.key} className="flex items-center gap-2 text-ink-muted">
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="truncate">{entry.name}</span>
        </li>
      ))}
      {rest && (
        <li className="flex items-center gap-2 text-ink-muted">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full bg-ink-muted" />
          <span>{rest}</span>
        </li>
      )}
    </ul>
  );
}
