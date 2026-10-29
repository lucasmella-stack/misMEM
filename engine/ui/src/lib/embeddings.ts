/** Lo que la interfaz dice del índice semántico y del vector de una memoria. */
import type { EmbeddingStatus } from "../api";
import { when } from "../format";

/**
 * El aviso sólo existe cuando hay algo que arreglar: un índice sano o apagado no merece
 * ruido. Las cifras van en el texto, no sólo en el color, y la orden que lo resuelve también.
 */
export function embeddingWarning(status: EmbeddingStatus | undefined): string | null {
  if (!status?.enabled) return null;
  if (status.missing <= 0 && status.stale_model <= 0) return null;

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
  return `El índice semántico no está al día: ${parts.join(" y ")}. Ejecuta mismem-embed para actualizarlo.`;
}

/** "embeddinggemma-2, 768 dimensiones, hace 3 días (28 oct 2026, 12:00)" */
export function embeddingSummary(
  embedding: { model: string; dims: number; created_at: number } | null | undefined,
  now = Date.now(),
): string {
  if (!embedding) return "Sin vector: no aparece en la búsqueda por significado";
  const dims = embedding.dims === 1 ? "1 dimensión" : `${embedding.dims} dimensiones`;
  return `${embedding.model}, ${dims}, ${when(embedding.created_at, now)}`;
}
