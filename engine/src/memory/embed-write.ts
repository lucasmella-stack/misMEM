// The best-effort vector of a freshly written item. A dead embedder must never fail the
// write: it returns false and the next backfill picks the item up.
import type { Database as DB } from "better-sqlite3";
import { embedLayerItem, type LayerName } from "../embeddings/layers.js";
import type { EmbedFn } from "../embeddings/provider.js";
import { capture } from "./capture.js";

export interface WriteEmbedOptions {
  embedFn?: EmbedFn;
  model?: string;
  timeoutMs?: number;
}

export async function embedWrittenLayer(
  db: DB,
  layer: LayerName,
  itemId: string,
  opts: WriteEmbedOptions = {},
): Promise<boolean> {
  try {
    return await embedLayerItem(db, layer, itemId, opts);
  } catch {
    return false;
  }
}

/**
 * The one write path for episodes: store the verbatim text and, if it is new, try its
 * vector. `capture` by MCP and every Engram alias that stores an episode go through here,
 * so an alias cannot create an episode that semantic recall will never see.
 */
export async function captureAndEmbed(
  db: DB,
  raw: unknown,
  opts: WriteEmbedOptions = {},
): Promise<{ id: string; deduped: boolean }> {
  const captured = capture(db, raw);
  if (!captured.deduped) {
    await embedWrittenLayer(db, "episode", captured.id, opts);
  }
  return captured;
}
