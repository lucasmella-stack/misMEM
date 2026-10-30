#!/usr/bin/env node
/**
 * mismem-embed — backfill y reindexado de embeddings de memorias, rasgos y episodios pendientes.
 *
 * Requiere el servidor de embeddings configurado: Ollama (default:
 * `ollama pull nomic-embed-text`) o uno compatible con OpenAI. Idempotente: procesa vectores
 * ausentes u obsoletos; `--force` reconstruye también los compatibles.
 *
 * Uso:
 *   mismem-embed [--scope <name>] [--batch 32] [--status] [--force]
 */
import { defaultDbPath, openDefaultDb } from "./db.js";
import { embedPendingMemories, getEmbeddingIndexStatus } from "./embeddings/store.js";
import { loadEmbeddingConfig } from "./embeddings/provider.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { parseEmbedArgs } from "./embed-args.js";

function help(): void {
  console.log(
    "mismem-embed [--scope <name>] [--batch 32] [--status] [--force]\n" +
      `DB: ${defaultDbPath()} (override con MISMEM_DB)\n` +
      "Variables: MISMEM_EMBEDDING_PROVIDER (ollama|openai), MISMEM_EMBEDDING_URL o MISMEM_OLLAMA_URL,\n" +
      "     MISMEM_EMBEDDING_MODEL, MISMEM_EMBEDDING_QUERY_PREFIX, MISMEM_EMBEDDING_DOC_PREFIX,\n" +
      "     MISMEM_EMBEDDING_MIN_SCORE, MISMEM_EMBEDDING_MAX_CHARS, MISMEM_EMBEDDING_TIMEOUT_MS,\n" +
      "     MISMEM_EMBEDDINGS=off\n" +
      "Cambiar de modelo se detecta solo; cambiar un prefijo o MAX_CHARS no: reindexar con --force.",
  );
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseEmbedArgs>;
  try {
    args = parseEmbedArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[embed] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  if (args.help) { help(); return; }
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
      `[embed] modelo=${cfg.model} ${cfg.provider}=${cfg.url} memorias=${status.memories} embebidas=${status.embedded}`,
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
    console.log(
      `[embed] rasgos y episodios pendientes=${result.layers.pending} embebidos=${result.layers.embedded} fallidos=${result.layers.failed}`,
    );
    if (result.failed > 0 && result.embedded === 0) {
      console.error(
        cfg.provider === "openai"
          ? `[embed] ¿El servidor de embeddings está corriendo? Probá: curl ${cfg.url}/health`
          : `[embed] ¿Ollama está corriendo? Probá: curl ${cfg.url}/api/tags — y \`ollama pull ${cfg.model}\``,
      );
      process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
