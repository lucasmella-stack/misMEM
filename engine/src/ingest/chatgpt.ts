import { readFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { capture } from "../tools.js";

interface ChatGPTMessage {
  id: string;
  author?: { role: string; name?: string | null };
  content?: { content_type?: string; parts?: unknown[] };
  create_time?: number | null;
}
interface ChatGPTMapping {
  [id: string]: { message: ChatGPTMessage | null; parent: string | null; children: string[] };
}
interface ChatGPTConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping: ChatGPTMapping;
}

export interface ChatGPTStats {
  conversations: number;
  messages: number;
  skipped: number;
}

function flattenConversation(conv: ChatGPTConversation): string {
  const lines: string[] = [];
  const title = conv.title ?? "(sin título)";
  const created = conv.create_time ? new Date(conv.create_time * 1000).toISOString() : "?";
  lines.push(`# ${title}`, `Created: ${created}`, "");

  // Linearize via mapping ordered by create_time
  const messages = Object.values(conv.mapping)
    .map((n) => n.message)
    .filter((m): m is ChatGPTMessage => m !== null && m !== undefined)
    .filter((m) => m.author?.role !== "system" && m.author?.role !== "tool")
    .sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));

  for (const m of messages) {
    const role = m.author?.role ?? "unknown";
    const parts = m.content?.parts ?? [];
    const text = parts
      .map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? ""))
      .filter(Boolean)
      .join("\n");
    if (!text.trim()) continue;
    lines.push(`## ${role}`, text, "");
  }
  return lines.join("\n");
}

const MAX_BYTES_PER_CONV = 80_000;

export async function ingestChatGPTExport(
  db: DB, exportRoot: string,
): Promise<ChatGPTStats> {
  const stats: ChatGPTStats = { conversations: 0, messages: 0, skipped: 0 };
  const entries = await readdir(exportRoot);
  const convFiles = entries.filter((f) => /^conversations.*\.json$/i.test(f));

  for (const file of convFiles) {
    const raw = await readFile(join(exportRoot, file), "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { stats.skipped++; continue; }
    const list = Array.isArray(parsed) ? parsed : [parsed];

    for (const convRaw of list) {
      const conv = convRaw as ChatGPTConversation;
      if (!conv?.mapping) { stats.skipped++; continue; }
      const id = conv.conversation_id ?? conv.id ?? "unknown";
      const text = flattenConversation(conv);
      if (!text.trim()) { stats.skipped++; continue; }

      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_BYTES_PER_CONV) {
        chunks.push(text.slice(i, i + MAX_BYTES_PER_CONV));
      }
      for (let i = 0; i < chunks.length; i++) {
        const tag = chunks.length > 1 ? ` [${i + 1}/${chunks.length}]` : "";
        capture(db, {
          scope: `chatgpt/${id}`,
          body: `${chunks[i]}\n\n---\nsource: ${file}${tag}`,
        });
      }
      stats.conversations++;
      stats.messages += Object.keys(conv.mapping).length;
    }
  }
  return stats;
}
