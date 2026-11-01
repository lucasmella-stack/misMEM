#!/usr/bin/env node
// mismem-forget: prunes old consolidated episodes and low-salience memories.
// Meant to run right after mismem-consolidate.
import { defaultDbPath, openDefaultDb } from "./store/db.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { parseForgetArgs } from "./forget-args.js";
import { forget } from "./memory/forget.js";

function help(): void {
  console.log(`misMEM: CLI de olvido

Purga episodios consolidados antiguos + memorias con salience baja.

Uso:
  mismem-forget [opciones]

Opciones:
  --dry-run                Mostrar qué se borraría sin borrar nada
  --scope <name>           Limitar a un scope
  --before-days <n>        Edad mínima de episodios consolidados; una memoria con alguno
                           más nuevo no se olvida (default 90)
  --memory-grace-days <n>  Edad mínima de memorias antes de purgarlas (default 30)
  --salience-below <n>     Umbral de salience para memorias (default 0.1)
  --help                   Esta ayuda

Variables:
  MISMEM_DB                default ${defaultDbPath()}
`);
}

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseForgetArgs>;
  try {
    opts = parseForgetArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[forget] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
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
  console.error("[forget] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
