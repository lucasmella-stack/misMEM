/**
 * Server core — registra las 5 tools canónicas + alias engram-compat.
 * Reusado por `server.ts` (stdio) y `server-http.ts` (StreamableHTTP).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database as DB } from "better-sqlite3";
import { capture, recallHybrid, consolidate, crystallize, forget } from "./tools.js";
import { embedPendingMemories } from "./embeddings/index.js";
import {
  ENGRAM_TOOLS,
  dispatchEngramTool,
  isEngramTool,
} from "./engram-compat.js";

const CANONICAL_TOOLS = [
  {
    name: "capture",
    description:
      "Save a verbatim episode (raw, time-stamped). Lossy by design — episodes are pruned after consolidation.",
    inputSchema: {
      type: "object",
      required: ["scope", "body"],
      properties: {
        scope: { type: "string", description: "Project/context namespace" },
        body: { type: "string" },
      },
    },
  },
  {
    name: "recall",
    description:
      "Hybrid search: FTS5 across all layers plus semantic ranking for memories. Reinforces returned memories (Hebbian).",
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
    name: "consolidate",
    description:
      "Distill N episodes into a single memory (gist + details). Marks episodes as consolidated.",
    inputSchema: {
      type: "object",
      required: ["scope", "gist", "source_episode_ids"],
      properties: {
        scope: { type: "string" },
        gist: { type: "string" },
        details: { type: "string" },
        source_episode_ids: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "crystallize",
    description:
      "Promote a recurring pattern across memories into a trait (Soul Mirror). Increments strength on repeat.",
    inputSchema: {
      type: "object",
      required: ["scope", "name", "evidence_memory_ids"],
      properties: {
        scope: { type: "string" },
        name: { type: "string" },
        evidence_memory_ids: { type: "array", items: { type: "string" } },
        polarity: {
          type: "string",
          enum: ["shadow", "light", "neutral"],
          default: "neutral",
        },
      },
    },
  },
  {
    name: "forget",
    description:
      "Prune consolidated old episodes and low-salience memories. Defaults to dry_run=true.",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string" },
        before_days: { type: "integer", minimum: 1, default: 30 },
        salience_below: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.1,
        },
        memory_grace_days: {
          type: "integer",
          minimum: 0,
          default: 30,
        },
        dry_run: { type: "boolean", default: true },
      },
    },
  },
];

const ALL_TOOLS = [...CANONICAL_TOOLS, ...ENGRAM_TOOLS];

export function createServer(db: DB): Server {
  const server = new Server(
    { name: "mismem", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      let result: unknown;
      switch (name) {
        case "capture":
          result = capture(db, args);
          break;
        case "recall":
          result = await recallHybrid(db, args);
          break;
        case "consolidate": {
          result = consolidate(db, args);
          // Best-effort: si hay embedder local, la memoria nueva queda
          // embebida ya; si no, el backfill nocturno la levanta después.
          try {
            await embedPendingMemories(db);
          } catch {
            /* semántica es opcional; nunca rompe el write path */
          }
          break;
        }
        case "crystallize":
          result = crystallize(db, args);
          break;
        case "forget":
          result = forget(db, args);
          break;
        default:
          if (isEngramTool(name)) {
            result = await dispatchEngramTool(db, name, args);
            break;
          }
          throw new Error(`Unknown tool: ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error in ${name}: ${message}` }],
      };
    }
  });

  return server;
}
