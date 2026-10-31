#!/usr/bin/env node
// mismem-migrate-engram: migrates observations, sessions and user_prompts from an Engram
// SQLite database into misMEM episodes. Reading and writing live in `ingest/engram.ts`;
// this file only parses arguments, prints and reports.
import { openDefaultDb, defaultDbPath } from "./store/db.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { migrateEngram, readEngramDb } from "./ingest/engram.js";
import { parseMigrateEngramArgs } from "./migrate-engram-args.js";

function help(): void {
  console.log(`mismem-migrate-engram

Migra una DB de engram (sessions/observations/user_prompts) a mismem episodes.

Uso:
  mismem-migrate-engram --source /path/engram.db [opciones]

Opciones:
  --source <path>          Path a engram.db (requerido)
  --scope-prefix <name>    Prefix para scopes (default 'engram')
  --dry-run                Mostrar conteo sin escribir
  --help

Variables:
  MISMEM_DB                target DB (default ${defaultDbPath()})
`);
}

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseMigrateEngramArgs>;
  try {
    opts = parseMigrateEngramArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[migrate] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  if (opts.help) {
    help();
    return;
  }
  // A missing required argument is a usage error, just like giving it without a value.
  if (!opts.source) {
    console.error("[migrate] falta --source (ruta a engram.db)\n");
    help();
    process.exit(EXIT_USAGE);
  }

  const source = readEngramDb(opts.source);
  const dst = openDefaultDb();
  try {
    console.log(`[migrate] origen: ${opts.source}`);
    console.log(`[migrate] observaciones=${source.observations.length} sesiones(con resumen)=${source.sessions.length} prompts=${source.prompts.length}`);

    if (opts.dryRun) {
      console.log("[migrate] dry-run, saliendo");
      return;
    }

    const { inserted, skipped } = migrateEngram(dst, source, opts.scopePrefix);
    console.log(`[migrate] HECHO insertados=${inserted} omitidos(duplicados)=${skipped}`);
  } finally {
    dst.close();
  }
}

main().catch((err) => {
  console.error("[migrate] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
