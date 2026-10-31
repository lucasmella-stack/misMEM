#!/usr/bin/env node
import { defaultDbPath, openDefaultDb } from "./store/db.js";
import { runConsolidation } from "./consolidation/run.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { parseConsolidateArgs } from "./consolidate-args.js";

function help(): void {
  console.log(`misMEM: CLI de consolidación

Destila episodios pendientes en memorias usando un LLM (DeepSeek, OpenRouter, OpenAI o compatible).

Uso:
  mismem-consolidate [opciones]

Opciones:
  --dry-run                Mostrar qu\u00e9 scopes/episodios se procesar\u00edan sin llamar LLM
  --scope <name>           Procesar s\u00f3lo un scope espec\u00edfico
  --min-age-hours <n>      Edad m\u00ednima de episodios a consolidar (default 24)
  --min-episodes <n>       Episodios m\u00ednimos por scope (default 3)
  --quiet-days <n>         Un scope con menos del m\u00ednimo se consolida igual tras n d\u00edas sin episodios nuevos (default 14)
  --max-batch <n>          M\u00e1x episodios por llamada LLM (default 60)
  --uncited-strikes <n>    Tandas en que el LLM puede ignorar un episodio antes de darlo por ruido (default 3)
  --help                   Esta ayuda

Variables:
  MISMEM_LLM_PROVIDER                   deepseek | openrouter | openai | compatible
                                        (sin ella, el primero con su variable, en ese orden)
  DEEPSEEK_API_KEY                      DeepSeek directo
  OPENROUTER_API_KEY                    OpenRouter
  OPENAI_API_KEY                        OpenAI (con MISMEM_CONSOLIDATION_MODEL obligatorio)
  MISMEM_LLM_BASE_URL, MISMEM_LLM_API_KEY  servidor compatible con OpenAI (modelo obligatorio)
  MISMEM_CONSOLIDATION_MODEL            default deepseek-chat (OpenRouter: deepseek/deepseek-chat)
  MISMEM_CONSOLIDATION_MAX_TOKENS       default 8192
  MISMEM_CONSOLIDATION_TIMEOUT_MS       default 120000 (tope por llamada al LLM)
  MISMEM_CONSOLIDATION_MAX_PROMPT_CHARS default 60000
  MISMEM_CONSOLIDATION_MAX_EPISODE_CHARS default 12000
  MISMEM_CONSOLIDATION_MAX_CALLS        default 60
  MISMEM_CONSOLIDATION_MIN_AGE_HOURS    default 24
  MISMEM_CONSOLIDATION_MIN_EPISODES     default 3
  MISMEM_CONSOLIDATION_QUIET_DAYS       default 14
  MISMEM_CONSOLIDATION_MAX_BATCH        default 60
  MISMEM_CONSOLIDATION_UNCITED_STRIKES  default 3
  MISMEM_DB                             default ${defaultDbPath()}
`);
}

async function main(): Promise<void> {
  let opts: ReturnType<typeof parseConsolidateArgs>;
  try {
    opts = parseConsolidateArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[consolidate] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  if (opts.help) { help(); return; }

  const db = openDefaultDb();
  try {
    const summary = await runConsolidation(db, {
      scopeFilter: opts.scope,
      dryRun: opts.dryRun,
      minAgeHours: opts.minAgeHours,
      minEpisodesPerScope: opts.minEpisodes,
      quietDays: opts.quietDays,
      maxEpisodesPerBatch: opts.maxBatch,
      uncitedStrikes: opts.uncitedStrikes,
    });
    console.log(JSON.stringify(summary, null, 2));
    if (summary.scopes_failed > 0) process.exit(2);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error("[consolidate] ERROR:", err instanceof Error ? err.message : err);
  process.exit(1);
});
