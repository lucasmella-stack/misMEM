#!/usr/bin/env node
/**
 * mismem-stats CLI: reporta métricas básicas de la DB en formato texto o JSON.
 *
 * Usado por consumers externos para mostrar el estado de la memoria.
 */
import { openDefaultDb, defaultDbPath } from "./db.js";

interface Args {
  json: boolean;
  scope?: string;
  help: boolean;
}

interface Stats {
  db_path: string;
  episodes_total: number;
  episodes_unconsolidated: number;
  memories_total: number;
  traits_total: number;
  scopes: { scope: string; count: number }[];
  oldest_episode_ts: number | null;
  newest_episode_ts: number | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--scope") out.scope = argv[++i];
  }
  return out;
}

function help(): void {
  console.log(`mismem-stats

Muestra estadísticas de la DB misMEM.

Usage:
  mismem-stats [--json] [--scope <prefix>]

Opciones:
  --json            Salida JSON (default: texto plano)
  --scope <prefix>  Filtrar por prefix de scope (ej. 'engram/')
  --help

Env:
  MISMEM_DB         Path a la DB (default ${defaultDbPath()})
`);
}

function fmtTs(ms: number | null): string {
  if (ms === null) return "n/a";
  return new Date(ms).toISOString();
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    help();
    return;
  }

  const db = openDefaultDb();
  const scopeFilter = opts.scope ? `WHERE scope LIKE ?` : "";
  const scopeParam: unknown[] = opts.scope ? [`${opts.scope}%`] : [];

  const epTotal = db.prepare(`SELECT COUNT(*) AS n FROM episodes ${scopeFilter}`).get(...scopeParam) as { n: number };
  const epUnc = db
    .prepare(`SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL ${opts.scope ? "AND scope LIKE ?" : ""}`)
    .get(...scopeParam) as { n: number };
  const memTotal = db.prepare(`SELECT COUNT(*) AS n FROM memories ${scopeFilter}`).get(...scopeParam) as { n: number };
  const trTotal = db.prepare(`SELECT COUNT(*) AS n FROM traits ${scopeFilter}`).get(...scopeParam) as { n: number };
  const scopes = db
    .prepare(`SELECT scope, COUNT(*) AS count FROM episodes ${scopeFilter} GROUP BY scope ORDER BY count DESC LIMIT 20`)
    .all(...scopeParam) as { scope: string; count: number }[];
  const range = db
    .prepare(`SELECT MIN(created_at) AS min_ts, MAX(created_at) AS max_ts FROM episodes ${scopeFilter}`)
    .get(...scopeParam) as { min_ts: number | null; max_ts: number | null };

  const stats: Stats = {
    db_path: defaultDbPath(),
    episodes_total: epTotal.n,
    episodes_unconsolidated: epUnc.n,
    memories_total: memTotal.n,
    traits_total: trTotal.n,
    scopes,
    oldest_episode_ts: range.min_ts,
    newest_episode_ts: range.max_ts,
  };

  if (opts.json) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(`=== misMEM stats ===`);
    console.log(`DB: ${stats.db_path}`);
    console.log(`Episodios total:          ${stats.episodes_total}`);
    console.log(`Episodios sin consolidar: ${stats.episodes_unconsolidated}`);
    console.log(`Memorias total:           ${stats.memories_total}`);
    console.log(`Traits total:             ${stats.traits_total}`);
    console.log(`Rango temporal:           ${fmtTs(stats.oldest_episode_ts)}  →  ${fmtTs(stats.newest_episode_ts)}`);
    console.log(`Top scopes (max 20):`);
    for (const s of stats.scopes) console.log(`  ${s.scope.padEnd(50)} ${s.count}`);
  }

  db.close();
}

main();
