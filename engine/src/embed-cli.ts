#!/usr/bin/env node
/**
 * mismem-embed — backfill y reindexado de embeddings para memories.
 *
 * Requiere Ollama corriendo con el modelo de embeddings
 * (default: `ollama pull nomic-embed-text`). Idempotente: procesa vectores
 * ausentes u obsoletos; `--force` reconstruye también los compatibles.
 *
 * Uso:
 *   mismem-embed [--scope <name>] [--batch 32] [--status] [--force]
 */
import { defaultDbPath, openDefaultDb } from "./db.js";
import {
  embedPendingMemories,
  getEmbeddingIndexStatus,
  loadEmbeddingConfig,
} from "./embeddings/index.js";

interface Args {
  scope?: string;
  batch: number;
  status: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { batch: 32, status: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--scope":
        args.scope = argv[++i];
        break;
      case "--batch":
        args.batch = Number(argv[++i]) || 32;
        break;
      case "--stats":
      case "--status":
        args.status = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "mismem-embed [--scope <name>] [--batch 32] [--status] [--force]\n" +
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
  try {
    const cfg = loadEmbeddingConfig();
    const status = getEmbeddingIndexStatus(db, cfg.model);

    if (args.status) {
      console.log(
        JSON.stringify(
          { db: defaultDbPath(), active_model: cfg.model, ...status },
          null,
          2,
        ),
      );
      return;
    }

    console.log(
      `[embed] modelo=${cfg.model} ollama=${cfg.url} memorias=${status.memories} embebidas=${status.embedded}`,
    );
    const result = await embedPendingMemories(db, {
      scope: args.scope,
      batchSize: args.batch,
      timeoutMs: 120_000,
      force: args.force,
    });
    console.log(
      `[embed] pendientes=${result.pending} embebidas=${result.embedded} reembebidas=${result.reembedded} fallidas=${result.failed}`,
    );
    if (result.failed > 0 && result.embedded === 0) {
      console.error(
        `[embed] ¿Ollama está corriendo? Probá: curl ${cfg.url}/api/tags — y \`ollama pull ${cfg.model}\``,
      );
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
