/**
 * Engram-compatibility layer.
 *
 * Expone alias `mem_*` (Engram MCP tools) que mapean a las 6 canónicas
 * de misMEM (capture/recall/reinforce/consolidate/crystallize/forget). Permite
 * que clientes existentes (agentes, CLAUDE.md, mcp.json) sigan
 * funcionando sin cambios al migrar de Engram a misMEM.
 *
 * Mapeo:
 *   mem_save             → capture
 *   mem_search           → recall
 *   mem_context          → SELECT directo de los episodios sin consolidar más
 *                          recientes; no llama a recall ni ordena por relevancia
 *   mem_get_observation  → SELECT por id en episodes/memories/traits
 *   mem_session_summary  → capture (scope=session)
 *   mem_save_prompt      → capture (scope=prompts)
 *   mem_update           → UPDATE memorias/traits, o append episodio
 *   mem_suggest_topic_key→ heurística sobre title/content
 *   mem_session_start    → no-op informativo
 *   mem_session_end      → no-op informativo
 */
import type { Database as DB } from "better-sqlite3";
import { captureAndEmbed, embedWrittenLayer, pendingEpisodes, recallHybrid } from "./tools.js";
import type { EmbedFn } from "./embeddings/provider.js";

export interface EngramToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    required?: string[];
    properties: Record<string, unknown>;
  };
}

export const ENGRAM_TOOLS: EngramToolDef[] = [
  {
    name: "mem_save",
    description:
      "[engram-compat] Save a memory. Maps to capture() with scope 'engram-compat' unless 'scope' is given.",
    inputSchema: {
      type: "object",
      required: ["title", "content"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
        type: {
          type: "string",
          description:
            "bugfix | decision | architecture | discovery | pattern | config | preference",
        },
        scope: { type: "string", description: "engram-compat (default) | any other scope name" },
        topic_key: { type: "string" },
      },
    },
  },
  {
    name: "mem_search",
    description:
      "[engram-compat] Hybrid search: FTS5 across all layers plus semantic ranking for memories, traits and pending episodes.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        scope: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
  {
    name: "mem_context",
    description:
      "[engram-compat] Recent session context. Direct SELECT of the latest unconsolidated episodes (any scope or filtered); no recall, no ranking.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
  {
    name: "mem_get_observation",
    description:
      "[engram-compat] Fetch full untruncated content of an observation by ID (episode|memory|trait).",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "mem_session_summary",
    description:
      "[engram-compat] Save end-of-session summary. Maps to capture(scope='session').",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
        scope: { type: "string" },
      },
    },
  },
  {
    name: "mem_save_prompt",
    description:
      "[engram-compat] Save user prompt for context. Maps to capture(scope='prompts').",
    inputSchema: {
      type: "object",
      required: ["content"],
      properties: {
        content: { type: "string" },
        scope: { type: "string" },
      },
    },
  },
  {
    name: "mem_update",
    description:
      "[engram-compat] Update by id: tries memories.gist, then traits.name, else appends a new episode referencing the original.",
    inputSchema: {
      type: "object",
      required: ["id", "content"],
      properties: {
        id: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  {
    name: "mem_suggest_topic_key",
    description:
      "[engram-compat] Heuristic suggestion: 'category/slug' from title + content.",
    inputSchema: {
      type: "object",
      required: ["title"],
      properties: {
        title: { type: "string" },
        content: { type: "string" },
      },
    },
  },
  {
    name: "mem_session_start",
    description: "[engram-compat] No-op acknowledgement (misMEM is stateless per call).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mem_session_end",
    description: "[engram-compat] No-op acknowledgement (use mem_session_summary instead).",
    inputSchema: { type: "object", properties: {} },
  },
];

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

  switch (name) {
    case "mem_save": {
      const scope = asString(args.scope) || DEFAULT_SCOPE;
      return captureAndEmbed(
        db,
        { scope, body: formatSaveBody(args) },
        { embedFn: searchOptions.embedFn, model: searchOptions.embeddingModel },
      );
    }

    case "mem_search": {
      return await recallHybrid(db, args, searchOptions.embedFn, {
        embeddingModel: searchOptions.embeddingModel,
      });
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
      const ep = db
        .prepare(
          "SELECT id, scope, body AS text, created_at FROM episodes WHERE id = ?",
        )
        .get(id);
      if (ep) return { layer: "episode", ...ep };
      const mem = db
        .prepare(
          "SELECT id, scope, gist, details, salience, created_at FROM memories WHERE id = ?",
        )
        .get(id);
      if (mem) return { layer: "memory", ...mem };
      const tr = db
        .prepare(
          "SELECT id, scope, name, strength, polarity, created_at, updated_at FROM traits WHERE id = ?",
        )
        .get(id);
      if (tr) return { layer: "trait", ...tr };
      throw new Error(`mem_get_observation: no existe el id: ${id}`);
    }

    case "mem_session_summary": {
      const scope = asString(args.scope) || "session";
      return captureAndEmbed(
        db,
        { scope, body: asString(args.content) },
        { embedFn: searchOptions.embedFn, model: searchOptions.embeddingModel },
      );
    }

    case "mem_save_prompt": {
      const scope = asString(args.scope) || "prompts";
      return captureAndEmbed(
        db,
        { scope, body: asString(args.content) },
        { embedFn: searchOptions.embedFn, model: searchOptions.embeddingModel },
      );
    }

    case "mem_update": {
      const id = asString(args.id);
      const content = asString(args.content);
      if (!id || !content) throw new Error("mem_update: faltan 'id' y 'content'");
      const updMem = db
        .prepare("UPDATE memories SET gist = ? WHERE id = ?")
        .run(content, id);
      if (updMem.changes > 0) {
        db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
        return { updated: "memory", id };
      }
      const trait = db.prepare("SELECT name FROM traits WHERE id = ?").get(id) as
        | { name: string }
        | undefined;
      if (trait) {
        if (trait.name !== content) {
          // The vector described the old name; delete it and embed the new one through the
          // same best-effort write path as the other writes, so a renamed trait does not
          // lose its semantic layer until the next backfill.
          db.prepare("UPDATE traits SET name = ?, updated_at = ? WHERE id = ?").run(
            content,
            Date.now(),
            id,
          );
          db.prepare("DELETE FROM layer_embeddings WHERE layer = 'trait' AND item_id = ?").run(id);
          await embedWrittenLayer(db, "trait", id, {
            embedFn: searchOptions.embedFn,
            model: searchOptions.embeddingModel,
          });
        }
        return { updated: "trait", id };
      }
      // Fallback: append new episode that references the original id
      const result = await captureAndEmbed(
        db,
        {
          scope: DEFAULT_SCOPE,
          body: `[update of ${id}]\n${content}`,
        },
        { embedFn: searchOptions.embedFn, model: searchOptions.embeddingModel },
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
