#!/usr/bin/env node
/**
 * mismem-embed — backfill de embeddings para memorias sin vector.
 *
 * Requiere Ollama corriendo con el modelo de embeddings
 * (default: `ollama pull nomic-embed-text`). Idempotente: correrlo de nuevo
 * solo procesa lo que falta.
 *
 * Uso:
 *   mismem-embed [--scope <name>] [--batch 32] [--stats]
 */
import { defaultDbPath, openDefaultDb } from "./db.js";
import {
  embedPendingMemories,
  loadEmbeddingConfig,
} from "./embeddings/index.js";

interface Args {
  scope?: string;
  batch: number;
  stats: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { batch: 32, stats: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--scope":
        args.scope = argv[++i];
        break;
      case "--batch":
        args.batch = Number(argv[++i]) || 32;
        break;
      case "--stats":
        args.stats = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "mismem-embed [--scope <name>] [--batch 32] [--stats]\n" +
            `DB: ${defaultDbPath()} (override con MISMEM_DB)\n` +
            "Env: MISMEM_OLLAMA_URL, MISMEM_EMBEDDING_MODEL, MISMEM_EMBEDDINGS=off",
        );
        process.exit(0);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const db = openDefaultDb();
  const cfg = loadEmbeddingConfig();

  const total = db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number };
  const embedded = db
    .prepare("SELECT COUNT(*) AS n FROM memory_embeddings")
    .get() as { n: number };

  if (args.stats) {
    console.log(
      JSON.stringify(
        { db: defaultDbPath(), model: cfg.model, memories: total.n, embedded: embedded.n },
        null,
        2,
      ),
    );
    return;
  }

  console.log(
    `[embed] modelo=${cfg.model} ollama=${cfg.url} memorias=${total.n} embebidas=${embedded.n}`,
  );
  const result = await embedPendingMemories(db, {
    scope: args.scope,
    batchSize: args.batch,
    timeoutMs: 120_000,
  });
  console.log(
    `[embed] pendientes=${result.pending} embebidas=${result.embedded} fallidas=${result.failed}`,
  );
  if (result.failed > 0 && result.embedded === 0) {
    console.error(
      `[embed] ¿Ollama está corriendo? Probá: curl ${cfg.url}/api/tags — y \`ollama pull ${cfg.model}\``,
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
