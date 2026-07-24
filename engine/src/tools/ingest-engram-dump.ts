/**
 * Ingest the JSONL produced by dump-engram into misMEM as scope=engram.
 */
import { readFileSync } from "node:fs";
import { defaultDbPath, openDefaultDb } from "../db.js";
import { capture } from "../tools.js";

const IN = process.argv[2] ?? "engram-dump.jsonl";
const db = openDefaultDb();

const lines = readFileSync(IN, "utf8").split(/\r?\n/).filter(Boolean);
let n = 0;
for (const line of lines) {
  const { id, text } = JSON.parse(line) as { id: number; text: string };
  // Try to extract topic from the text (Engram format: "Topic: foo")
  const topicMatch = text.match(/\nTopic:\s*([^\n]+)/);
  const projectMatch = text.match(/\nProject:\s*([^\n]+)/);
  const scope = topicMatch
    ? `engram/${topicMatch[1]?.trim()}`
    : projectMatch
      ? `engram/${projectMatch[1]?.trim()}`
      : "engram";
  capture(db, { scope, body: `# engram #${id}\n\n${text}` });
  n++;
}
console.log(JSON.stringify({ ingested: n, db: defaultDbPath() }, null, 2));
