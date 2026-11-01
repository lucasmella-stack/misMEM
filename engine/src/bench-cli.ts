#!/usr/bin/env node
// mismem-bench: measures how often recall returns the expected memory.
// Same recall and embedding server as production, reinforcing nothing; the question bank is
// private (built from one's own memory) and never reaches the repo.
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./store/db.js";
import { meanRank, mrr, parseBank, recallAt, runBench, type Score } from "./recall/bench.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { BENCH_DEFAULT_LIMIT, parseBenchArgs } from "./bench-args.js";

function help(): void {
  console.log(`mismem-bench --bank <banco.jsonl> [--db <base.db>] [--limit ${BENCH_DEFAULT_LIMIT}]
             [--group lang,tema] [--off-topic <ajenas.txt>] [--json]

Banco: una línea JSON por pregunta. "id" es la memoria esperada; las claves de
--group agrupan el resultado; cualquier otra clave es una variante de la pregunta:
  {"id":"01ABC...","lang":"en","parafrasis":"...","literal":"..."}
Ajenas: una pregunta por línea que NO debería traer nada.

Informa, por variante: aciertos en el tope, MRR, posición media del acierto,
aciertos en la 1ª y entre las 3 primeras, y el reparto por posición. Al final,
cuántos recuerdos devuelve por pregunta (el modelo los lee todos) y un aviso si
algún marcador de ruido llegó al tope.

DB: ${defaultDbPath()} (override con --db o MISMEM_DB). No refuerza ni escribe memorias.
Variables: las mismas MISMEM_EMBEDDING_* que el servidor.`);
}

const percent = (score: Score): string =>
  score.total === 0 ? "sin preguntas" : `${score.found}/${score.total} (${Math.round((100 * score.found) / score.total)} %)`;

const dec = (value: number, places = 2): string =>
  Number.isNaN(value) ? "—" : value.toFixed(places).replace(".", ",");

/** Only positions that had a hit: with a large cap the rest is visual noise. */
const positions = (score: Score): string =>
  score.ranks
    .map((n, i) => (n > 0 ? `${i + 1}:${n}` : null))
    .filter((part): part is string => part !== null)
    .join(" ") || "ninguna";

async function main(): Promise<void> {
  let args: ReturnType<typeof parseBenchArgs>;
  try {
    args = parseBenchArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[bench] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  if (args.help || !args.bank) {
    help();
    process.exit(args.help ? 0 : 1);
  }
  const bank = parseBank(readFileSync(args.bank, "utf8"), args.groups);
  const offTopic = args.offTopic
    ? readFileSync(args.offTopic, "utf8").split("\n").map((line) => line.trim()).filter(Boolean)
    : [];
  const db = openDb(args.db ?? defaultDbPath());
  try {
    const report = await runBench(db, bank, { limit: args.limit, offTopic });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memoria esperada entre las ${report.limit} devueltas:`);
    for (const [variant, result] of Object.entries(report.variants)) {
      const { all } = result;
      console.log(`  ${variant}: ${percent(all)} · MRR ${dec(mrr(all))} · posición media ${dec(meanRank(all), 1)}`);
      console.log(`    en la 1ª: ${recallAt(all, 1)} · entre las 3 primeras: ${recallAt(all, 3)} · posiciones ${positions(all)}`);
      for (const [label, score] of Object.entries(result.groups)) {
        console.log(`    ${label}: ${percent(score)} · MRR ${dec(mrr(score))}`);
      }
    }
    if (report.offTopic.total > 0) {
      console.log(
        `preguntas ajenas que trajeron algo: ${report.offTopic.withHits}/${report.offTopic.total}` +
          ` (${report.offTopic.hitsSum} recuerdos en total)`,
      );
    }
    if (report.noiseHits > 0) {
      console.log(`AVISO: ${report.noiseHits} marcadores de ruido llegaron al tope (deberían ser 0)`);
    }
    if (report.returned.questions > 0) {
      const perQuestion = report.returned.hitsSum / report.returned.questions;
      console.log(`recuerdos devueltos por pregunta: ${dec(perQuestion, 1)} de ${report.limit}`);
    }
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  console.error(`[bench] ${(err as Error).message}`);
  process.exit(1);
});
