#!/usr/bin/env node
import { resolve } from "node:path";
import { defaultDbPath, openDefaultDb } from "./store/db.js";
import { ingestStats } from "./queries/stats.js";
import { walkAndIngest } from "./ingest/walk.js";
import { ingestChatGPTExport } from "./ingest/chatgpt.js";
import { ingestVSCodeTranscripts, ingestVSCodePrompts } from "./ingest/vscode.js";
import { ArgsError, EXIT_USAGE } from "./cli-args.js";
import { parseIngestArgs } from "./ingest-args.js";

const DB_PATH = defaultDbPath();

function help(): void {
  console.log(`misMEM: CLI de ingesta
Uso:
  mismem-ingest walk <root> <scope-prefix>     Recorre un árbol de directorios.
  mismem-ingest file <path> <scope>            Ingiere un solo fichero.
  mismem-ingest chatgpt <export-root>          Lee conversations-*.json.
  mismem-ingest vscode <user-dir>              Transcripciones y prompts.
  mismem-ingest stats                          Muestra estadísticas de la DB.
  mismem-ingest help

DB: ${DB_PATH}  (se cambia con MISMEM_DB)`);
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseIngestArgs>;
  try {
    parsed = parseIngestArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof ArgsError)) throw err;
    console.error(`[ingest] ${err.message}\n`);
    help();
    process.exit(EXIT_USAGE);
  }
  const { command } = parsed;
  if (command === "help") { help(); return; }

  const db = openDefaultDb();

  switch (parsed.command) {
    case "walk": {
      const s = await walkAndIngest({ root: resolve(parsed.root), scopePrefix: parsed.scopePrefix, db });
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "file": {
      const { readFile } = await import("node:fs/promises");
      const { capture } = await import("./memory/capture.js");
      const content = await readFile(resolve(parsed.path), "utf8");
      const r = capture(db, { scope: parsed.scope, body: content });
      console.log(JSON.stringify(r));
      break;
    }
    case "chatgpt": {
      const s = await ingestChatGPTExport(db, resolve(parsed.root));
      console.log(JSON.stringify(s, null, 2));
      break;
    }
    case "vscode": {
      const t = await ingestVSCodeTranscripts(db, resolve(parsed.userDir));
      const p = await ingestVSCodePrompts(db, resolve(parsed.userDir));
      console.log(JSON.stringify({ transcripts: t, prompts: p }, null, 2));
      break;
    }
    case "stats": {
      console.log(JSON.stringify({ db: DB_PATH, ...ingestStats(db) }, null, 2));
      break;
    }
  }
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
