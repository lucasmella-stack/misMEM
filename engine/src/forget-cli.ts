#!/usr/bin/env node
/**
 * mismem-forget CLI: purga episodios consolidados antiguos + memorias de baja salience.
 * Ideal para correr después de mismem-consolidate.
 */
import { defaultDbPath, openDefaultDb } from "./db.js";
import { forget } from "./tools.js";

interface Args {
  scope?: string;
  beforeDays: number;
  memoryGraceDays: number;
  salienceBelow: number;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    beforeDays: 90,
    memoryGraceDays: 30,
    salienceBelow: 0.1,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--scope") out.scope = argv[++i];
    else if (a === "--before-days") out.beforeDays = Number(argv[++i]);
    else if (a === "--memory-grace-days") out.memoryGraceDays = Number(argv[++i]);
    else if (a === "--salience-below") out.salienceBelow = Number(argv[++i]);
  }
  return out;
}

function help(): void {
  console.log(`misMEM forget CLI

Purga episodios consolidados antiguos + memorias con salience baja.

Usage:
  mismem-forget [opciones]

Opciones:
  --dry-run                Mostrar qué se borraría sin borrar nada
  --scope <name>           Limitar a un scope
  --before-days <n>        Edad mínima de episodios consolidados (default 90)
  --memory-grace-days <n>  Edad mínima de memorias antes de purgarlas (default 30)
  --salience-below <n>     Umbral de salience para memorias (default 0.1)
  --help                   Esta ayuda

Env:
  MISMEM_DB                default ${defaultDbPath()}
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return; }

  const db = openDefaultDb();
  try {
    const result = forget(db, {
      scope: opts.scope,
      before_days: opts.beforeDays,
      memory_grace_days: opts.memoryGraceDays,
      salience_below: opts.salienceBelow,
      dry_run: opts.dryRun,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[forget] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
