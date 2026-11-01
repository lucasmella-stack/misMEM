#!/usr/bin/env node
// mismem-stats: reports basic database metrics as text or JSON, for external consumers that
// show the state of the memory.
import { openDefaultDb, defaultDbPath } from "./store/db.js";
import { statsSummary } from "./queries/stats.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { parseStatsArgs } from "./stats-args.js";

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

function help(): void {
  console.log(`mismem-stats

Muestra estadísticas de la DB misMEM.

Uso:
  mismem-stats [--json] [--scope <prefix>]

Opciones:
  --json            Salida JSON (default: texto plano)
  --scope <prefix>  Filtrar por prefix de scope (ej. 'engram/')
  --help

Variables:
  MISMEM_DB         Path a la DB (default ${defaultDbPath()})
`);
}

function fmtTs(ms: number | null): string {
  if (ms === null) return "n/a";
  return new Date(ms).toISOString();
}

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseStatsArgs>;
  try {
    opts = parseStatsArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[stats] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  if (opts.help) {
    help();
    return;
  }

  const db = openDefaultDb();
  try {
    const stats: Stats = { db_path: defaultDbPath(), ...statsSummary(db, opts.scope) };

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
      console.log(`Scopes principales (máx 20):`);
      for (const s of stats.scopes) console.log(`  ${s.scope.padEnd(50)} ${s.count}`);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[stats] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
