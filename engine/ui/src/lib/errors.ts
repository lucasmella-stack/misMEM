/** Fetch errors already carry the server message; anything else is shown as it is. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
