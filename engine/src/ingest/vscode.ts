import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream, existsSync, statSync } from "node:fs";
import type { Database as DB } from "better-sqlite3";
import { capture } from "../tools.js";

export interface JsonlStats {
  files: number;
  records: number;
  skipped: number;
}

const MAX_BODY = 80_000;

/**
 * Walks VS Code workspaceStorage looking for Copilot transcript .jsonl files.
 * Path pattern: {userDir}/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/*.jsonl
 */
export async function ingestVSCodeTranscripts(
  db: DB, userDir: string,
): Promise<JsonlStats> {
  const stats: JsonlStats = { files: 0, records: 0, skipped: 0 };
  const wsRoot = join(userDir, "workspaceStorage");
  if (!existsSync(wsRoot)) return stats;

  const workspaces = await readdir(wsRoot, { withFileTypes: true });
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const transcriptsDir = join(wsRoot, ws.name, "GitHub.copilot-chat", "transcripts");
    if (!existsSync(transcriptsDir)) continue;
    const files = await readdir(transcriptsDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const full = join(transcriptsDir, file);
      const size = statSync(full).size;
      if (size === 0) { stats.skipped++; continue; }

      const lines: string[] = [];
      const rl = createInterface({ input: createReadStream(full, "utf8") });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { role?: string; content?: unknown; text?: string };
          const text =
            typeof obj.content === "string" ? obj.content :
            typeof obj.text === "string" ? obj.text :
            JSON.stringify(obj).slice(0, 2000);
          const role = obj.role ?? "unknown";
          lines.push(`[${role}] ${text}`);
        } catch {
          // skip malformed
        }
      }
      if (!lines.length) { stats.skipped++; continue; }

      const body = `# transcript ${ws.name}/${file}\n\n${lines.join("\n\n")}`;
      for (let i = 0; i < body.length; i += MAX_BODY) {
        capture(db, {
          scope: `vscode/transcripts/${ws.name}`,
          body: body.slice(i, i + MAX_BODY),
        });
      }
      stats.files++;
      stats.records += lines.length;
    }
  }
  return stats;
}

/**
 * Ingest VS Code prompts and instructions folders.
 */
export async function ingestVSCodePrompts(
  db: DB, userDir: string,
): Promise<{ files: number }> {
  const promptsDir = join(userDir, "prompts");
  let files = 0;
  if (!existsSync(promptsDir)) return { files };
  const entries = await readdir(promptsDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isFile()) continue;
    const full = join(promptsDir, e.name);
    const content = await readFile(full, "utf8");
    if (!content.trim()) continue;
    capture(db, {
      scope: "vscode/prompts",
      body: `# ${e.name}\n\n${content}`,
    });
    files++;
  }
  return { files };
}
