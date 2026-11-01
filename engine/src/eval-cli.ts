#!/usr/bin/env node
/**
 * Golden eval CLI: measures recall by kind, domain and globally. See docs/recall.md.
 */
import { fileURLToPath } from "node:url";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { loadEmbeddingConfig, type EmbedFn } from "./embeddings/provider.js";
import { embedPendingMemories, getEmbeddingIndexStatus } from "./embeddings/store.js";
import {
  EVAL_DEFAULT_LIMIT,
  jsonPayload,
  modeLine,
  parseEvalArgs,
  type ModeChoice,
} from "./eval-args.js";
import { chooseMode, readCorpus } from "./eval-mode.js";
import { parseGolden } from "./recall/golden-corpus.js";
import { loadGolden, runGolden, type GoldenReport, type GoldenScore } from "./recall/golden.js";
import { openDb } from "./store/db.js";

/** `dist/eval-cli.js` and `src/eval-cli.ts` hang from the same package: `../eval/golden`. */
const DEFAULT_DIR = fileURLToPath(new URL("../eval/golden/", import.meta.url));

const lexicalOnly: EmbedFn = async () => null;

function help(): void {
  console.log(`pnpm eval [--dir ${DEFAULT_DIR}] [--limit ${EVAL_DEFAULT_LIMIT}]
             [--mode lexico|semantico|auto] [--json]

Corre el eval dorado en castellano: carga los .jsonl de --dir en una base en memoria y
mide, por tipo de pregunta, por dominio y en global, los aciertos y el MRR. Las preguntas
ajenas se informan aparte. Un marcador de ruido devuelto es un fallo.

--mode auto (por defecto) usa el semántico sólo si deja todas las memorias embebidas sin
un lote fallido, y el léxico en cualquier otro caso.
Base: en memoria (:memory:), nunca ~/.mismem. No escribe nada fuera del proceso.`);
}

const percent = (score: GoldenScore): string =>
  score.questions === 0
    ? "sin preguntas"
    : `${score.hitAtLimit}/${score.questions} (${Math.round((100 * score.hitAtLimit) / score.questions)} %)`;

const dec = (value: number, places = 2): string => value.toFixed(places).replace(".", ",");

function line(score: GoldenScore): string {
  return `${percent(score)} · en la 1ª: ${score.hitAt1} · entre las 3: ${score.hitAt3} · MRR ${dec(score.mrr)}`;
}

function printReport(report: GoldenReport, chosen: ModeChoice, dir: string): void {
  console.log(`directorio: ${dir}`);
  console.log(modeLine(chosen));

  console.log(`global: ${line(report.global)}`);
  console.log("por tipo:");
  for (const [kind, score] of Object.entries(report.kinds)) {
    console.log(`  ${kind}: ${line(score)}`);
  }
  console.log("por dominio:");
  for (const [domain, score] of Object.entries(report.domains)) {
    console.log(`  ${domain}: ${line(score)}`);
  }

  const extra: string[] = [];
  if (report.offTopic.total > 0) {
    extra.push(
      `preguntas ajenas que trajeron algo: ${report.offTopic.withHits}/${report.offTopic.total}` +
        ` (${report.offTopic.hitsSum} recuerdos)`,
    );
  }
  if (report.noiseHits > 0) {
    extra.push(`AVISO: ${report.noiseHits} marcadores de ruido llegaron al tope (deberían ser 0)`);
  }
  if (report.returned.questions > 0) {
    const perQuestion = report.returned.hitsSum / report.returned.questions;
    extra.push(`recuerdos devueltos por pregunta: ${dec(perQuestion, 1)} de ${report.limit}`);
  }
  for (const text of extra) console.log(text);
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseEvalArgs>;
  try {
    args = parseEvalArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[eval] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  if (args.help) {
    help();
    return;
  }

  const dir = args.dir ?? DEFAULT_DIR;
  const corpus = parseGolden(readCorpus(dir));
  const db = openDb(":memory:");
  try {
    const at = Date.now();
    const ids = loadGolden(db, corpus, at);
    const chosen = await chooseMode(args.mode, {
      // Layer failures count too: since the layers have vectors, a failed trait batch skews semantic.
      embed: async () => {
        const stats = await embedPendingMemories(db);
        return { failed: stats.failed + stats.layers.failed };
      },
      embedded: () => getEmbeddingIndexStatus(db, loadEmbeddingConfig().model).embedded,
    });
    const embedFn = chosen.mode === "lexico" ? lexicalOnly : undefined;
    const report = await runGolden(db, corpus, ids, { limit: args.limit, embedFn, at });

    if (args.json) {
      console.log(JSON.stringify(jsonPayload(chosen, report), null, 2));
      return;
    }
    printReport(report, chosen, dir);
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(`[eval] ${(err as Error).message}`);
  process.exit(1);
});
