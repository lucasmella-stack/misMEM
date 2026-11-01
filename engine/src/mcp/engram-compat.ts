// Engram compatibility: dispatches the `mem_*` aliases to the canonical tools or to the read and
// write that own the SQL, so clients coming from Engram (agents, CLAUDE.md, mcp.json) keep
// working unchanged. The catalogue is in `engram-tools.ts`.
import type { Database as DB } from "better-sqlite3";
import { captureAndEmbed, embedWrittenLayer } from "../memory/embed-write.js";
import { updateEngramTarget } from "../memory/engram-update.js";
import { pendingEpisodes } from "../memory/pending.js";
import { observationById } from "../queries/observation.js";
import { recallHybrid } from "../recall/recall.js";
import { requestedScope, searchResponse } from "../queries/recall-view.js";
import type { EmbedFn } from "../embeddings/provider.js";

export { ENGRAM_TOOLS } from "./engram-tools.js";

const DEFAULT_SCOPE = "engram-compat";

function asString(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function formatSaveBody(args: Record<string, unknown>): string {
  const title = asString(args.title);
  const type = asString(args.type);
  const topic = asString(args.topic_key);
  const content = asString(args.content);
  const lines: string[] = [`Title: ${title}`];
  if (type) lines.push(`Type: ${type}`);
  if (topic) lines.push(`TopicKey: ${topic}`);
  lines.push("", content);
  return lines.join("\n");
}

function suggestTopicKey(title: string, content: string): string {
  const text = `${title} ${content}`.toLowerCase();
  const categories: Record<string, RegExp> = {
    architecture: /\barchitect|design|pattern\b/,
    bugfix: /\bbug|fix|error|crash\b/,
    config: /\bconfig|env|setup|install\b/,
    decision: /\bdecid|chose|choice|prefer\b/,
    discovery: /\bfound|discover|learn|gotcha\b/,
  };
  let category = "note";
  for (const [cat, rx] of Object.entries(categories)) {
    if (rx.test(text)) {
      category = cat;
      break;
    }
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "untitled";
  return `${category}/${slug}`;
}

export async function dispatchEngramTool(
  db: DB,
  name: string,
  rawArgs: unknown,
  searchOptions: { embedFn?: EmbedFn; embeddingModel?: string } = {},
): Promise<unknown> {
  const args = asObject(rawArgs);
  const embedOpts = { embedFn: searchOptions.embedFn, model: searchOptions.embeddingModel };

  switch (name) {
    case "mem_save": {
      const scope = asString(args.scope) || DEFAULT_SCOPE;
      return captureAndEmbed(db, { scope, body: formatSaveBody(args) }, embedOpts);
    }

    case "mem_search": {
      return recallHybrid(db, args, searchOptions.embedFn, {
        embeddingModel: searchOptions.embeddingModel,
      }).then((result) => searchResponse(db, result.hits, requestedScope(args)));
    }

    case "mem_context": {
      const scope = args.scope ? asString(args.scope) : null;
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      // Same rows as the viewer's pending list, minus consolidated_into (always null here).
      const hits = pendingEpisodes(db, scope, limit).map(({ id, scope: s, text, created_at }) => ({
        id,
        scope: s,
        text,
        created_at,
        layer: "episode",
      }));
      return { hits };
    }

    case "mem_get_observation": {
      const id = asString(args.id);
      if (!id) throw new Error("mem_get_observation: falta 'id'");
      const observation = observationById(db, id);
      if (observation) return observation;
      throw new Error(`mem_get_observation: no existe el id: ${id}`);
    }

    case "mem_session_summary": {
      const scope = asString(args.scope) || "session";
      return captureAndEmbed(db, { scope, body: asString(args.content) }, embedOpts);
    }

    case "mem_save_prompt": {
      const scope = asString(args.scope) || "prompts";
      return captureAndEmbed(db, { scope, body: asString(args.content) }, embedOpts);
    }

    case "mem_update": {
      const id = asString(args.id);
      const content = asString(args.content);
      if (!id || !content) throw new Error("mem_update: faltan 'id' y 'content'");
      const update = updateEngramTarget(db, id, content, Date.now());
      if (update) {
        if (update.renamed) await embedWrittenLayer(db, "trait", id, embedOpts);
        return { updated: update.target, id };
      }
      // Fallback: append new episode that references the original id
      const result = await captureAndEmbed(
        db,
        {
          scope: DEFAULT_SCOPE,
          body: `[update of ${id}]\n${content}`,
        },
        embedOpts,
      );
      return { updated: "appended", original_id: id, new_id: result.id };
    }

    case "mem_suggest_topic_key": {
      return {
        topic_key: suggestTopicKey(asString(args.title), asString(args.content)),
      };
    }

    case "mem_session_start":
      return { ok: true, note: "misMEM no guarda estado; no hay sesión que iniciar." };

    case "mem_session_end":
      return {
        ok: true,
        note: "Usa mem_session_summary para guardar las notas de fin de sesión.",
      };

    default:
      throw new Error(`herramienta engram-compat desconocida: ${name}`);
  }
}

export function isEngramTool(name: string): boolean {
  return name.startsWith("mem_");
}
