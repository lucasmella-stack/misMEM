// Server core: registers the six canonical tools plus the engram-compat aliases, shared by
// `server.ts` (stdio) and `server-http.ts` (Streamable HTTP).
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database as DB } from "better-sqlite3";
import { captureAndEmbed, embedWrittenLayer } from "./memory/embed-write.js";
import { recallHybrid } from "./recall/recall.js";
import { consolidate } from "./memory/consolidate.js";
import { crystallize } from "./memory/crystallize.js";
import { forget } from "./memory/forget.js";
import { reinforce } from "./memory/reinforce.js";
import { AUTO_BACKFILL_MAX_ROWS, embedPendingMemories } from "./embeddings/store.js";
import { dispatchEngramTool, isEngramTool } from "./mcp/engram-compat.js";
import { ENGRAM_TOOLS } from "./mcp/engram-tools.js";

// The advertised inputSchemas are hand-written mirrors of the Zod schemas in schema.ts, which
// are what actually validates calls. tests/tool-schemas.test.ts fails if the two drift.
export const CANONICAL_TOOLS = [
  {
    name: "capture",
    description:
      "Save a verbatim episode (raw, time-stamped). Lossy by design — episodes are pruned after consolidation.",
    inputSchema: {
      type: "object",
      required: ["scope", "body"],
      properties: {
        scope: { type: "string", minLength: 1, maxLength: 128, description: "Project/context namespace" },
        body: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "recall",
    description:
      "Hybrid search: FTS5 across all layers plus semantic ranking for memories, traits and pending episodes. Reinforces returned memories (Hebbian) unless MISMEM_REINFORCE_ON_RECALL=off.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", minLength: 1 },
        scope: { type: "string", minLength: 1, maxLength: 128 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        reinforce: {
          type: "boolean",
          description: "false for a search the user did not ask for (a hook injecting context): it is not use, so it must not raise salience",
        },
      },
    },
  },
  {
    name: "reinforce",
    description:
      "Mark memories as actually used in an answer (Hebbian). Use with MISMEM_REINFORCE_ON_RECALL=off so salience tracks use, not appearance.",
    inputSchema: {
      type: "object",
      required: ["memory_ids"],
      properties: {
        memory_ids: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          maxItems: 50,
          description: "Ids of the memories the answer actually relied on",
        },
        boost: { type: "number", minimum: 0, maximum: 1 },
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
        scope: { type: "string", minLength: 1, maxLength: 128 },
        gist: { type: "string", minLength: 1 },
        details: { type: "string" },
        source_episode_ids: { type: "array", items: { type: "string" }, minItems: 1 },
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
        scope: { type: "string", minLength: 1, maxLength: 128 },
        name: { type: "string", minLength: 1 },
        evidence_memory_ids: { type: "array", items: { type: "string" }, minItems: 1 },
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
        scope: { type: "string", minLength: 1, maxLength: 128 },
        before_days: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 30 },
        salience_below: {
          type: "number",
          minimum: 0,
          maximum: 1,
          default: 0.1,
        },
        memory_grace_days: {
          type: "integer",
          minimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          default: 30,
        },
        dry_run: { type: "boolean", default: true },
      },
    },
  },
];

const ALL_TOOLS = [...CANONICAL_TOOLS, ...ENGRAM_TOOLS];

// package.json is the only source of the version. It is read at runtime because the
// build compiles src/ to dist/ with rootDir ./src, so a JSON import from ../ would fall
// outside it; ../package.json resolves from both src/ (tsx) and dist/ (Docker, npm).
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

export function createServer(db: DB): Server {
  const server = new Server(
    { name: "mismem", version },
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
        case "capture": {
          result = await captureAndEmbed(db, args);
          break;
        }
        case "recall":
          result = await recallHybrid(db, args);
          break;
        case "consolidate": {
          result = consolidate(db, args);
          // Best effort: with a local embedder the new memory is embedded right away; the
          // nightly backfill picks it up otherwise. Bounded so the client never waits for
          // a full reindex.
          try {
            await embedPendingMemories(db, { maxRows: AUTO_BACKFILL_MAX_ROWS });
          } catch {
            /* semantics are optional and never break the write path */
          }
          break;
        }
        case "reinforce":
          result = reinforce(db, args);
          break;
        case "crystallize": {
          const trait = crystallize(db, args);
          result = trait;
          await embedWrittenLayer(db, "trait", trait.trait_id);
          break;
        }
        case "forget":
          result = forget(db, args);
          break;
        default:
          if (isEngramTool(name)) {
            result = await dispatchEngramTool(db, name, args);
            break;
          }
          throw new Error(`Herramienta desconocida: ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `Error en ${name}: ${message}` }],
      };
    }
  });

  return server;
}
