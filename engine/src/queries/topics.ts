// Owns the semantic islands: which memories talk about the same thing, read from the stored
// vectors. Where the connectome measures what was used together, this measures what resembles
// what, and it is the layer that already has data to show.
import type { Database as DB } from "better-sqlite3";
import { cosine } from "../embeddings/vector.js";
import { excludeNoiseSql } from "../store/rows.js";

// A pair of unrelated memories scores about 0.67 with EmbeddingGemma 2, and `related` edges
// start at 0.75. Measured over 3652 real memories: at 0.80 one blob swallows 66% of them, at
// 0.88 the largest island is 17, and at 0.85 they break into 409 islands with the largest at 6%.
const TOPIC_MIN_SCORE = 0.85;
// The cost is a cosine per pair, so it grows with the square. 1500 memories is about two
// seconds; beyond that a request would hang waiting for a map nobody asked to be exhaustive.
const TOPIC_LIMIT = 1500;

interface Topic {
  size: number;
  /** Which scopes it draws from, biggest first: a topic that crosses three is the finding. */
  scopes: Array<{ scope: string; n: number }>;
  /** The way in: the most salient member, which is also what names the topic. */
  entry: { id: string; gist: string; salience: number };
  members: string[];
}

export interface Topics {
  topics: Topic[];
  /** Memories looked at that landed in no island. */
  alone: number;
  /** How many had a comparable vector at all. */
  considered: number;
  minScore: number;
}

interface Row {
  id: string;
  scope: string;
  gist: string;
  salience: number;
  model: string;
  vec: Buffer;
}

/** Union-find: islands are chains, so two memories join through a third they both resemble. */
function groups(count: number, joined: (a: number, b: number) => boolean): Map<number, number[]> {
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i++) parent[i] = i;
  const root = (x: number): number => {
    let node = x;
    let up = parent[node] as number;
    while (up !== node) {
      // Path halving: the next lookup of this chain is one hop instead of walking it again.
      parent[node] = parent[up] as number;
      node = parent[node] as number;
      up = parent[node] as number;
    }
    return node;
  };
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (!joined(i, j)) continue;
      const a = root(i);
      const b = root(j);
      if (a !== b) parent[a] = b;
    }
  }
  const out = new Map<number, number[]>();
  for (let i = 0; i < count; i++) {
    const r = root(i);
    const bucket = out.get(r);
    if (bucket) bucket.push(i);
    else out.set(r, [i]);
  }
  return out;
}

export function topics(
  db: DB,
  opts: { minScore?: number; limit?: number; scope?: string } = {},
): Topics {
  const minScore = opts.minScore ?? TOPIC_MIN_SCORE;
  const rows = db
    .prepare(
      `SELECT m.id, m.scope, m.gist, m.salience, e.model, e.vec
       FROM memories m JOIN memory_embeddings e ON e.memory_id = m.id
       WHERE ${excludeNoiseSql("m")} ${opts.scope ? "AND m.scope = @scope" : ""}
       ORDER BY m.salience DESC
       LIMIT @limit`,
    )
    .all({ scope: opts.scope, limit: opts.limit ?? TOPIC_LIMIT }) as Row[];

  // Vectors from different models are not comparable, so only the most common one is read.
  const byModel = new Map<string, number>();
  for (const r of rows) byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
  const model = [...byModel.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const kept = rows.filter((r) => r.model === model);
  const vectors = kept.map(
    (r) => new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4),
  );

  const islands = groups(kept.length, (a, b) => {
    const x = vectors[a];
    const y = vectors[b];
    return x !== undefined && y !== undefined && cosine(x, y) >= minScore;
  });

  const topics: Topic[] = [];
  let alone = 0;
  for (const members of islands.values()) {
    if (members.length < 2) {
      alone += 1;
      continue;
    }
    const rowsOf = members.map((i) => kept[i] as Row);
    const counts = new Map<string, number>();
    for (const r of rowsOf) counts.set(r.scope, (counts.get(r.scope) ?? 0) + 1);
    const entry = rowsOf.reduce((best, r) => (r.salience > best.salience ? r : best));
    topics.push({
      size: rowsOf.length,
      scopes: [...counts.entries()]
        .map(([scope, n]) => ({ scope, n }))
        .sort((a, b) => b.n - a.n || a.scope.localeCompare(b.scope)),
      entry: { id: entry.id, gist: entry.gist, salience: entry.salience },
      members: rowsOf.map((r) => r.id),
    });
  }
  topics.sort((a, b) => b.size - a.size || b.entry.salience - a.entry.salience);
  return { topics, alone, considered: kept.length, minScore };
}
