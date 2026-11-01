/**
 * Mode and corpus choice for the golden eval, apart from the CLI because it runs on import.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalMode, ModeChoice } from "./eval-args.js";

/** The embedder and its counter come in as closures so a test never needs a server. */
interface ModeProbe {
  embed: () => Promise<{ failed: number }>;
  embedded: () => number;
}

/**
 * `auto` does not guess: it embeds the corpus and stays semantic only when nothing failed.
 * An explicit semantic mode is honoured even with the embedder down; recall degrades to
 * FTS5 on its own and the numbers say so.
 */
export async function chooseMode(
  requested: EvalMode,
  probe: ModeProbe,
): Promise<ModeChoice> {
  if (requested === "lexico") return { mode: "lexico", embedded: 0, failed: 0 };

  const stats = await probe.embed();
  const embedded = probe.embedded();
  const usable = stats.failed === 0 && embedded > 0;
  if (requested === "semantico" || usable) {
    return { mode: "semantico", embedded, failed: stats.failed };
  }
  return { mode: "lexico", embedded, failed: stats.failed };
}

export function readCorpus(dir: string): Array<{ name: string; text: string }> {
  if (!existsSync(dir)) throw new Error(`no existe el directorio ${dir}`);
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
  if (names.length === 0) throw new Error(`no hay ficheros .jsonl en ${dir}`);
  return names.map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));
}
