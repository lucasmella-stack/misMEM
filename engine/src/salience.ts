import type { Database as DB } from "better-sqlite3";

export const DEFAULT_SALIENCE_HALF_LIFE_DAYS = 90;

export function loadSalienceHalfLifeDays(): number {
  const value = Number(process.env.MISMEM_SALIENCE_HALF_LIFE_DAYS);
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_SALIENCE_HALF_LIFE_DAYS;
}

export function decayedSalience(
  salience: number,
  updatedAt: number,
  at: number,
  halfLifeDays = loadSalienceHalfLifeDays(),
): number {
  if (at <= updatedAt) return salience;
  const elapsedDays = (at - updatedAt) / 86_400_000;
  return salience * 0.5 ** (elapsedDays / halfLifeDays);
}

export interface SalienceRow {
  salience: number;
  created_at: number;
  last_accessed_at: number | null;
  salience_updated_at: number | null;
}

export function effectiveSalience(
  row: SalienceRow,
  at: number,
  halfLifeDays = loadSalienceHalfLifeDays(),
): number {
  const checkpoint =
    row.salience_updated_at ?? row.last_accessed_at ?? row.created_at;
  return decayedSalience(row.salience, checkpoint, at, halfLifeDays);
}

export function reinforceMemories(
  db: DB,
  memoryIds: readonly string[],
  opts: { at?: number; boost?: number; halfLifeDays?: number } = {},
): void {
  const ids = [...new Set(memoryIds)];
  if (ids.length === 0) return;

  const at = opts.at ?? Date.now();
  const boost = opts.boost ?? 0.05;
  const halfLifeDays = opts.halfLifeDays ?? loadSalienceHalfLifeDays();
  const get = db.prepare(
    `SELECT salience, created_at, last_accessed_at, salience_updated_at
     FROM memories WHERE id = ?`,
  );
  const update = db.prepare(
    `UPDATE memories
     SET salience = ?, last_accessed_at = ?, salience_updated_at = ?
     WHERE id = ?`,
  );

  db.transaction(() => {
    for (const id of ids) {
      const row = get.get(id) as SalienceRow | undefined;
      if (!row) continue;
      const next = Math.min(
        1,
        effectiveSalience(row, at, halfLifeDays) + boost,
      );
      update.run(next, at, at, id);
    }
  })();
}

export interface DecayStats {
  considered: number;
  updated: number;
  dry_run: boolean;
}

export function decayMemories(
  db: DB,
  opts: {
    scope?: string;
    at?: number;
    halfLifeDays?: number;
    dryRun?: boolean;
  } = {},
): DecayStats {
  const at = opts.at ?? Date.now();
  const halfLifeDays = opts.halfLifeDays ?? loadSalienceHalfLifeDays();
  const rows = db
    .prepare(
      `SELECT id, salience, created_at, last_accessed_at, salience_updated_at
       FROM memories
       WHERE (@scope IS NULL OR scope = @scope)`,
    )
    .all({ scope: opts.scope ?? null }) as Array<SalienceRow & { id: string }>;

  if (opts.dryRun ?? false) {
    return { considered: rows.length, updated: 0, dry_run: true };
  }

  const update = db.prepare(
    `UPDATE memories
     SET salience = ?, salience_updated_at = ?
     WHERE id = ?`,
  );
  db.transaction(() => {
    for (const row of rows) {
      update.run(effectiveSalience(row, at, halfLifeDays), at, row.id);
    }
  })();

  return {
    considered: rows.length,
    updated: rows.length,
    dry_run: false,
  };
}
