#!/usr/bin/env node
import { defaultDbPath, openDefaultDb } from "./db.js";
import { runConsolidation } from "./consolidation/run.js";

function parseArgs(argv: string[]): {
  scope?: string;
  dryRun: boolean;
  minAgeHours?: number;
  minEpisodes?: number;
  maxBatch?: number;
  help: boolean;
} {
  const out: {
    scope?: string;
    dryRun: boolean;
    minAgeHours?: number;
    minEpisodes?: number;
    maxBatch?: number;
    help: boolean;
  } = { dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--scope") out.scope = argv[++i];
    else if (a === "--min-age-hours") out.minAgeHours = Number(argv[++i]);
    else if (a === "--min-episodes") out.minEpisodes = Number(argv[++i]);
    else if (a === "--max-batch") out.maxBatch = Number(argv[++i]);
  }
  return out;
}

function help(): void {
  console.log(`misMEM consolidate CLI

Destila episodios pendientes en memorias usando un LLM (OpenRouter).

Usage:
  mismem-consolidate [opciones]

Opciones:
  --dry-run                Mostrar qu\u00e9 scopes/episodios se procesar\u00edan sin llamar LLM
  --scope <name>           Procesar s\u00f3lo un scope espec\u00edfico
  --min-age-hours <n>      Edad m\u00ednima de episodios a consolidar (default 24)
  --min-episodes <n>       Episodios m\u00ednimos por scope (default 3)
  --max-batch <n>          M\u00e1x episodios por llamada LLM (default 60)
  --help                   Esta ayuda

Env:
  OPENROUTER_API_KEY                    requerida (salvo --dry-run)
  MISMEM_CONSOLIDATION_MODEL            default deepseek/deepseek-chat
  MISMEM_CONSOLIDATION_MIN_AGE_HOURS    default 24
  MISMEM_CONSOLIDATION_MIN_EPISODES     default 3
  MISMEM_CONSOLIDATION_MAX_BATCH        default 60
  MISMEM_DB                             default ${defaultDbPath()}
`);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return; }

  const db = openDefaultDb();
  try {
    const summary = await runConsolidation(db, {
      scopeFilter: opts.scope,
      dryRun: opts.dryRun,
      minAgeHours: opts.minAgeHours,
      minEpisodesPerScope: opts.minEpisodes,
      maxEpisodesPerBatch: opts.maxBatch,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.scopes_failed > 0) process.exit(2);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[consolidate] FATAL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
