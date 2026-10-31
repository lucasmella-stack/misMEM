// Catalogue of the `mem_*` aliases (Engram MCP tools), kept apart from the dispatch so a client
// can list them without pulling in what each one does. What each maps to is in
// `engram-compat.ts`.
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
      "[engram-compat] Hybrid search: FTS5 across all layers plus semantic ranking for memories.",
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
