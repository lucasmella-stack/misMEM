/** What the interface says about the semantic index and a memory's vector. */
import type { EmbeddingStatus } from "../api";
import { when } from "../format";

/**
 * The warning only exists when something needs fixing: a healthy or disabled index does not
 * deserve noise. The numbers are in the text, not only in the color, and so is the command
 * that fixes them.
 */
export function embeddingWarning(status: EmbeddingStatus | undefined): string | null {
  if (!status?.enabled) return null;
  // Nothing was ever indexed: the embedding server is optional, so there is nothing to fix yet.
  if (status.embedded === 0) return null;
  if (status.missing <= 0 && status.stale_model <= 0 && status.stale_dims <= 0) return null;

  const parts: string[] = [];
  if (status.missing > 0) {
    parts.push(
      status.missing === 1
        ? "1 memoria sin vector"
        : `${status.missing} memorias sin vector`,
    );
  }
  if (status.stale_model > 0) {
    parts.push(
      status.stale_model === 1
        ? "1 memoria con un vector de otro modelo"
        : `${status.stale_model} memorias con vectores de otro modelo`,
    );
  }
  if (status.stale_dims > 0) {
    parts.push(
      status.stale_dims === 1
        ? "1 memoria con un vector de otras dimensiones"
        : `${status.stale_dims} memorias con vectores de otras dimensiones`,
    );
  }
  const reindex = status.stale_dims > 0;
  const pending = status.missing > 0 || status.stale_model > 0;
  const remedy = reindex
    ? pending
      ? "Ejecuta mismem-embed para lo pendiente y mismem-embed --force para reindexar todo al ancho actual."
      : "Ejecuta mismem-embed --force para reindexar todo al ancho actual."
    : "Ejecuta mismem-embed para actualizarlo.";
  return `El índice semántico no está al día: ${parts.join(" y ")}. ${remedy}`;
}

/**
 * The width the server reports as active, the one search compares against: the last one the
 * embedder produced, or the stored majority before that was recorded. Null only when the base has
 * no vector of the active model, and then nothing is claimed about a vector.
 */
export function activeModelDims(status: EmbeddingStatus | undefined): number | undefined {
  return status?.active_dims ?? undefined;
}

/**
 * Search reads a vector only when it has the active model and that model's width, so a vector
 * with another width is as useless as one from another model. While the status is unknown
 * nothing is claimed: a failed lookup must not mark every memory stale.
 */
export function vectorIsCurrent(
  embedding: { model: string; dims: number },
  activeModel: string | undefined,
  activeDims: number | undefined,
): boolean {
  if (activeModel === undefined) return true;
  if (embedding.model !== activeModel) return false;
  return activeDims === undefined || embedding.dims === activeDims;
}

/** "embeddinggemma-2, 768 dimensiones, hace 3 días (28 oct 2026, 12:00)" */
export function embeddingSummary(
  embedding: { model: string; dims: number; created_at: number } | null | undefined,
  now = Date.now(),
  activeModel?: string,
  activeDims?: number,
): string {
  if (!embedding) return "Sin vector: no aparece en la búsqueda por significado";
  const dims = embedding.dims === 1 ? "1 dimensión" : `${embedding.dims} dimensiones`;
  const stale = !vectorIsCurrent(embedding, activeModel, activeDims);
  return `${embedding.model}, ${dims}, ${when(embedding.created_at, now)}${stale ? " (obsoleto: no lo usa la búsqueda)" : ""}`;
}
