/**
 * Server core — registra las 6 tools canónicas + alias engram-compat.
 * Reusado por `server.ts` (stdio) y `server-http.ts` (StreamableHTTP).
 */
import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database as DB } from "better-sqlite3";
import { ZodError } from "zod";
import { capture, recallHybrid, consolidate, crystallize, forget, reinforce } from "./tools.js";
import { recallForModel, requestedScope, searchResponse } from "./recall-view.js";
import { MCP_INSTRUCTIONS } from "./mcp-guide.js";
import { embedPendingMemories } from "./embeddings/store.js";
import {
  ENGRAM_TOOLS,
  dispatchEngramTool,
  isEngramTool,
} from "./engram-compat.js";

// The advertised inputSchemas are hand-written mirrors of the Zod schemas in schema.ts, which
// are what actually validates calls. tests/tool-schemas.test.ts fails if the two drift.
export const CANONICAL_TOOLS = [
  {
    name: "capture",
    description:
      "Save a verbatim episode (raw, time-stamped). Lossy by design — episodes are pruned after consolidation. Use when the user states a decision and its reason, when you find the root cause of a failure, or when the user corrects you; one idea per call, never secrets or third-party data.",
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
      "Hybrid search: FTS5 across all layers plus semantic ranking for memories. Reinforces returned memories (Hebbian) unless MISMEM_REINFORCE_ON_RECALL=off. Each hit carries its layer, the UTC date (YYYY-MM-DD), the details of a memory, the polarity of a trait when it is not neutral, and truncated when a string was clipped to fit the reply. When truncated is true, mem_get_observation with the id returns the full text. Use when the user asks something that may already be stored, and to check what is known about a scope.",
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
      "Mark memories as actually used in an answer (Hebbian). Use with MISMEM_REINFORCE_ON_RECALL=off so salience tracks use, not appearance. Use when an answer relied on a memory, with the ids it actually used, not every hit of a recall.",
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
      "Distill N episodes into a single memory (gist + details). Marks episodes as consolidated. Use when a scope has pending episodes that belong together, or let the nightly consolidation do it.",
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
      "Promote a recurring pattern across memories into a trait (Soul Mirror). Increments strength on repeat. Use when the same pattern shows up across several memories and deserves to be a rule.",
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
      "Prune consolidated old episodes and low-salience memories. Defaults to dry_run=true. Use when the memory has grown stale: the dry run first says what would go.",
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

/** What a Zod issue expected, in the words a model reads. */
function expectedType(expected: string): string {
  switch (expected) {
    case "string":
      return "un texto";
    case "number":
      return "un número";
    case "int":
      return "un número entero";
    case "boolean":
      return "true o false";
    case "array":
      return "una lista";
    case "object":
    case "record":
      return "un objeto";
    default:
      return `un valor de tipo ${expected}`;
  }
}

/** One issue as `<field>: <what it expects>`; the English Zod message never reaches the model. */
function describeIssue(issue: ZodError["issues"][number]): string {
  switch (issue.code) {
    case "invalid_type":
      return `se esperaba ${expectedType(issue.expected)}`;
    case "too_small":
      if (issue.origin === "string")
        return issue.minimum <= 1
          ? "no puede estar vacío"
          : `no puede tener menos de ${issue.minimum} caracteres`;
      if (issue.origin === "array" || issue.origin === "set") return "no puede estar vacía";
      // Zod reports a `.positive()` bound as exclusive: saying "menor que 0" about 0 is false
      // and sends the model back with the same value, so the wording has to match the bound.
      return issue.inclusive
        ? `no puede ser menor que ${issue.minimum}`
        : `tiene que ser mayor que ${issue.minimum}`;
    case "too_big":
      if (issue.origin === "string") return `no puede pasar de ${issue.maximum} caracteres`;
      if (issue.origin === "array" || issue.origin === "set")
        return `no puede tener más de ${issue.maximum} elementos`;
      return issue.inclusive
        ? `no puede ser mayor que ${issue.maximum}`
        : `tiene que ser menor que ${issue.maximum}`;
    case "invalid_value":
      return `debe ser uno de: ${issue.values.join(", ")}`;
    default:
      return "no es válido";
  }
}

/**
 * A ZodError's message is a pretty-printed JSON array in English: a model cannot act on it and
 * pays for every line. One readable line per problem is what it can fix. The `Error en <tool>`
 * prefix stays, both per line and on every other failure, because clients and tests key on it.
 */
function describeZodError(tool: string, error: ZodError): string {
  return error.issues
    .map((issue) => {
      const field = issue.path.length === 0 ? "argumentos" : issue.path.join(".");
      return `Error en ${tool}: ${field}: ${describeIssue(issue)}`;
    })
    .join("\n");
}

export function createServer(db: DB): Server {
  const server = new Server(
    { name: "mismem", version },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
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
        case "recall": {
          const { hits } = await recallHybrid(db, args);
          // A miss is where a model gives up: say which scopes do hold something, and
          // whether the scope it asked for is the problem. A search that found something
          // keeps its old shape; the model can retry from the hits.
          result = searchResponse(db, recallForModel(db, hits), requestedScope(args));
          break;
        }
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
        case "reinforce":
          result = reinforce(db, args);
          break;
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
          throw new Error(`Herramienta desconocida: ${name}`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      const text =
        err instanceof ZodError
          ? describeZodError(name, err)
          : `Error en ${name}: ${err instanceof Error ? err.message : String(err)}`;
      return {
        isError: true,
        content: [{ type: "text", text }],
      };
    }
  });

  return server;
}
