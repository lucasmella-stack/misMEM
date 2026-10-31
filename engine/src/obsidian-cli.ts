#!/usr/bin/env node
// mismem-obsidian: exports the memory as an Obsidian vault. HELP holds the usage and options;
// the note format and the manifest live in `export/`.
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { EXIT_USAGE } from "./cli-args.js";
import { defaultDbPath, openDb } from "./store/db.js";
import { isMismemDb } from "./store/probe.js";
import { EXPORT_ROOT, exportObsidian } from "./export/obsidian.js";

const HELP = `misMEM obsidian export

Escribe la memoria en <bóveda>/${EXPORT_ROOT}/: una nota por memoria, rasgo y ámbito,
enlazadas por origen y por parecido. Re-exportar sólo toca lo que exportó antes.

Uso:
  mismem-obsidian --out <bóveda> [opciones]

Opciones:
  --out <dir>      La bóveda de Obsidian (obligatorio)
  --scope <name>   Sólo un ámbito
  --episodes       Los episodios como notas propias, no citados dentro de su memoria
  --dry-run        Contar qué cambiaría sin escribir nada
  --help           Esta ayuda

Variables:
  MISMEM_DB        default ${defaultDbPath()} (debe existir: el export no crea la base)
`;

function main(): void {
  let values: { out?: string; scope?: string; episodes: boolean; "dry-run": boolean; help: boolean };
  try {
    // strict: a mistyped flag aborts instead of being ignored.
    ({ values } = parseArgs({
      options: {
        out: { type: "string" },
        scope: { type: "string" },
        episodes: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    console.error(`[obsidian] ${(err as Error).message}\n\n${HELP}`);
    process.exit(EXIT_USAGE);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.out) {
    console.error(`[obsidian] falta --out <bóveda>\n\n${HELP}`);
    process.exit(EXIT_USAGE);
  }

  const dbPath = defaultDbPath();
  // openDb creates the file when missing: a wrong path would export zero memories and empty
  // the vault. Refuse instead, also in --dry-run, which must write nothing.
  if (!existsSync(dbPath)) {
    console.error(`[obsidian] la base de datos no existe: ${dbPath}\n\n${HELP}`);
    process.exit(1);
  }
  // openDb migrates the schema and switches the journal to WAL: pointed at a foreign SQLite it
  // would modify it even if the export refused later. Check it read-only first.
  if (!isMismemDb(dbPath)) {
    console.error(`[obsidian] no es una base de misMEM (no tiene la tabla memories): ${dbPath}`);
    process.exit(1);
  }
  const db = openDb(dbPath);
  try {
    const stats = exportObsidian(db, {
      dir: values.out,
      scope: values.scope,
      episodes: values.episodes,
      dryRun: values["dry-run"],
    });
    console.log(JSON.stringify(stats, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error("[obsidian] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
}
