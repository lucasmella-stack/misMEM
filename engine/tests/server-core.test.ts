import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import type { EmbedFn } from "../src/embeddings/provider.js";
import { ENGRAM_TOOLS } from "../src/mcp/engram-compat.js";
import { createServer } from "../src/server-core.js";

// The real MCP entry point: a Client talks to createServer() over a linked in-memory transport,
// so the tool dispatch (the switch in server-core.ts) is what is under test, not the helpers.

const savedEmbeddings = process.env.MISMEM_EMBEDDINGS;
beforeAll(() => {
  // consolidate and recall try the embedder; keep them offline and deterministic.
  process.env.MISMEM_EMBEDDINGS = "off";
});
afterAll(() => {
  if (savedEmbeddings === undefined) delete process.env.MISMEM_EMBEDDINGS;
  else process.env.MISMEM_EMBEDDINGS = savedEmbeddings;
});

let db: DB;
let client: Client;

async function connect(embedFn?: EmbedFn, embeddingModel?: string): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(db, { embedFn, embeddingModel });
  const connected = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(serverTransport), connected.connect(clientTransport)]);
  return connected;
}

beforeEach(async () => {
  db = openDb(":memory:");
  client = await connect();
});

afterEach(async () => {
  await client.close();
  db.close();
});

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

async function call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = (await client.callTool(args === undefined ? { name } : { name, arguments: args })) as ToolResult;
  return { isError: res.isError === true, text: res.content[0]?.text ?? "" };
}

async function ok<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await call(name, args);
  expect(r.isError, r.text).toBe(false);
  return JSON.parse(r.text) as T;
}

const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

describe("MCP tool dispatch", () => {
  it("lists every canonical and engram-compat tool", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const canonical of ["capture", "recall", "reinforce", "consolidate", "crystallize", "forget"]) {
      expect(names).toContain(canonical);
    }
    for (const t of ENGRAM_TOOLS) expect(names).toContain(t.name);
  });

  it("capture writes the episode it was asked to write", async () => {
    const r = await ok<{ id: string; deduped: boolean }>("capture", { scope: "p/a", body: "the nightly job runs at 3am" });
    expect(r.deduped).toBe(false);
    const row = db.prepare("SELECT scope, body FROM episodes WHERE id = ?").get(r.id);
    expect(row).toEqual({ scope: "p/a", body: "the nightly job runs at 3am" });
  });

  it("recall finds what capture stored", async () => {
    await call("capture", { scope: "p/a", body: "zanahoria growth schedule" });
    const r = await ok<{ hits: Array<{ text?: string; body?: string }> }>("recall", { query: "zanahoria" });
    expect(r.hits).toHaveLength(1);
    expect(JSON.stringify(r.hits[0])).toContain("zanahoria");
  });

  it("recall answers with the model view, unindented", async () => {
    const ep = await ok<{ id: string }>("capture", { scope: "p/a", body: "zanahoria growth schedule" });
    await ok("consolidate", {
      scope: "p/a",
      gist: "zanahoria schedule",
      details: "water weekly",
      source_episode_ids: [ep.id],
    });

    const r = await call("recall", { query: "zanahoria" });
    expect(r.isError, r.text).toBe(false);
    expect(r.text).not.toContain("\n");

    const parsed = JSON.parse(r.text) as {
      hits: Array<{ layer: string; date?: string; created_at?: number; details?: string }>;
    };
    const memory = parsed.hits.find((h) => h.layer === "memory");
    expect(memory?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(memory?.created_at).toBeTypeOf("number");
    expect(memory?.details).toBe("water weekly");

    const captured = await call("capture", { scope: "p/a", body: "another note" });
    expect(captured.isError).toBe(false);
    expect(captured.text).not.toContain("\n");
  });

  it("consolidate creates the memory and marks its source episodes", async () => {
    const ep = await ok<{ id: string }>("capture", { scope: "p/a", body: "raw note" });
    const r = await ok<{ memory_id: string; consolidated: number }>("consolidate", {
      scope: "p/a",
      gist: "distilled gist",
      source_episode_ids: [ep.id],
    });
    expect(r.consolidated).toBe(1);
    const mem = db.prepare("SELECT gist FROM memories WHERE id = ?").get(r.memory_id);
    expect(mem).toEqual({ gist: "distilled gist" });
    const src = db.prepare("SELECT consolidated_into FROM episodes WHERE id = ?").get(ep.id);
    expect(src).toEqual({ consolidated_into: r.memory_id });
  });

  it("reinforce raises the salience of the memory it names", async () => {
    const ep = await ok<{ id: string }>("capture", { scope: "p/a", body: "raw note" });
    const mem = await ok<{ memory_id: string }>("consolidate", {
      scope: "p/a",
      gist: "gist",
      source_episode_ids: [ep.id],
    });
    db.prepare("UPDATE memories SET salience = 0.2 WHERE id = ?").run(mem.memory_id);
    const r = await ok<{ reinforced: number }>("reinforce", { memory_ids: [mem.memory_id], boost: 0.5 });
    expect(r.reinforced).toBe(1);
    const after = (db.prepare("SELECT salience FROM memories WHERE id = ?").get(mem.memory_id) as { salience: number }).salience;
    expect(after).toBeGreaterThan(0.2);
  });

  it("crystallize creates a trait and strengthens it on repeat", async () => {
    const first = await ok<{ trait_id: string; created: boolean }>("crystallize", {
      scope: "p/a",
      name: "prefers small PRs",
      evidence_memory_ids: ["m1"],
    });
    expect(first.created).toBe(true);
    const second = await ok<{ trait_id: string; created: boolean; strength: number }>("crystallize", {
      scope: "p/a",
      name: "prefers small PRs",
      evidence_memory_ids: ["m2"],
    });
    expect(second.created).toBe(false);
    expect(second.trait_id).toBe(first.trait_id);
    expect(count("SELECT COUNT(*) AS n FROM traits")).toBe(1);
  });

  it("forget defaults to a dry run and deletes nothing", async () => {
    const ep = await ok<{ id: string }>("capture", { scope: "p/a", body: "old note" });
    const mem = await ok<{ memory_id: string }>("consolidate", {
      scope: "p/a",
      gist: "gist",
      source_episode_ids: [ep.id],
    });
    db.prepare("UPDATE episodes SET created_at = 1 WHERE id = ?").run(ep.id);
    expect(mem.memory_id).toBeTruthy();
    const dry = await ok<{ episodes_to_delete: number; dry_run: boolean }>("forget", { before_days: 1 });
    expect(dry.dry_run).toBe(true);
    expect(dry.episodes_to_delete).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM episodes")).toBe(1);
    const real = await ok<{ dry_run: boolean }>("forget", { before_days: 1, dry_run: false });
    expect(real.dry_run).toBe(false);
    expect(count("SELECT COUNT(*) AS n FROM episodes")).toBe(0);
  });

  it("routes the engram-compat aliases to the right behaviour", async () => {
    const saved = await ok<{ id: string }>("mem_save", { title: "T", content: "engram body", scope: "p/b" });
    const row = db.prepare("SELECT scope, body FROM episodes WHERE id = ?").get(saved.id) as { scope: string; body: string };
    expect(row.scope).toBe("p/b");
    expect(row.body).toContain("engram body");

    const ctx = await ok<{ hits: Array<{ id: string }> }>("mem_context", { scope: "p/b" });
    expect(ctx.hits.map((h) => h.id)).toEqual([saved.id]);

    const obs = await ok<{ layer: string; id: string }>("mem_get_observation", { id: saved.id });
    expect(obs).toMatchObject({ layer: "episode", id: saved.id });

    const found = await ok<{ hits: unknown[] }>("mem_search", { query: "engram" });
    expect(found.hits).toHaveLength(1);
  });

  it("mem_search keeps the raw hits, without date, details or truncated", async () => {
    const ep = await ok<{ id: string }>("capture", { scope: "p/a", body: "zanahoria growth schedule" });
    await ok("consolidate", {
      scope: "p/a",
      gist: "zanahoria schedule",
      details: "water weekly",
      source_episode_ids: [ep.id],
    });

    const found = await ok<{ hits: Array<Record<string, unknown>> }>("mem_search", { query: "zanahoria" });
    const memory = found.hits.find((h) => h.layer === "memory");
    expect(memory?.created_at).toBeTypeOf("number");
    expect(memory).not.toHaveProperty("date");
    expect(memory).not.toHaveProperty("details");
    expect(memory).not.toHaveProperty("truncated");
  });

  it("reports an unknown tool as an error result instead of throwing", async () => {
    const r = await call("no_such_tool", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no_such_tool");
  });

  it("reports invalid arguments as an error result and writes nothing", async () => {
    const r = await call("capture", { scope: "p/a" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Error en capture");
    expect(count("SELECT COUNT(*) AS n FROM episodes")).toBe(0);
  });
});

describe("MCP guidance", () => {
  it("announces usage instructions on initialize, within the cap", async () => {
    const instructions = client.getInstructions();

    expect(instructions).toBeTruthy();
    expect((instructions ?? "").length).toBeLessThanOrEqual(1500);
    for (const term of ["episodes", "memories", "traits", "scope", "reinforce", "truncated"]) {
      expect(instructions).toContain(term);
    }
    expect(instructions).toContain("mem_get_observation");
  });

  it("tells the model that truncated means a clipped field and that mem_search shares the miss view", async () => {
    const instructions = client.getInstructions() ?? "";

    expect(instructions).toContain("has a field clipped");
    expect(instructions).toContain("A recall or mem_search with no hits adds scopes");
    expect(instructions).toContain("hint says it matched nothing");
  });

  it("says consolidate saves what the caller wrote, not that it distills by itself", async () => {
    const { tools } = await client.listTools();
    const instructions = client.getInstructions() ?? "";

    // The tool requires gist and source_episode_ids: a model told it distills would call it empty.
    expect(instructions).toContain("consolidate saves a memory you wrote");
    expect(tools.find((tool) => tool.name === "consolidate")?.description).toMatch(/^Save a memory you wrote/);
  });

  it("tells the model when to use each canonical tool", async () => {
    const { tools } = await client.listTools();

    for (const name of ["capture", "recall", "reinforce", "consolidate", "crystallize", "forget"]) {
      expect(tools.find((tool) => tool.name === name)?.description).toMatch(/Use when /);
    }
  });

  it("recall without hits names the scopes that do hold something, without noise", async () => {
    await ok("capture", { scope: "p/a", body: "zanahoria growth schedule" });
    await ok("capture", { scope: "p/b", body: "other note" });
    db.prepare(
      `INSERT INTO memories (id, scope, gist, source_episode_ids, salience, created_at)
       VALUES ('n1', 'p/noise', '[noise] dropped', '[]', 1, 1)`,
    ).run();

    const r = await ok<{ hits: unknown[]; scopes: string[] }>("recall", { query: "alcachofa" });

    expect(r.hits).toEqual([]);
    expect(r.scopes).toEqual(["p/a", "p/b"]);
  });

  it("recall says the scope it was asked for has nothing that matches", async () => {
    await ok("capture", { scope: "p/a", body: "zanahoria growth schedule" });

    const r = await ok<{ scopes: string[]; hint?: string }>("recall", {
      query: "alcachofa",
      scope: "p/typo",
    });

    expect(r.scopes).toEqual(["p/a"]);
    expect(r.hint).toContain("p/typo");
    expect(r.hint).toMatch(/no tiene/);
  });

  it("recall con la memoria vacía nombra la única salida, no una lista de ámbitos sin nada", async () => {
    const r = await ok<{ scopes: string[]; hint?: string }>("recall", {
      query: "alcachofa",
      scope: "p/typo",
    });

    expect(r.scopes).toEqual([]);
    expect(r.hint).toContain("p/typo");
    expect(r.hint).toMatch(/no guarda contenido/);
    expect(r.hint).not.toContain("scopes");
  });

  it("recall with hits answers exactly as before, without scopes or hint", async () => {
    await ok("capture", { scope: "p/a", body: "zanahoria growth schedule" });

    const r = await ok<Record<string, unknown>>("recall", { query: "zanahoria" });

    expect(Object.keys(r)).toEqual(["hits"]);
  });

  it("reports a missing field as one readable line per problem, not the Zod JSON", async () => {
    const r = await call("capture", {});

    expect(r.isError).toBe(true);
    const lines = r.text.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("Error en capture: scope: se esperaba un texto");
    expect(lines[1]).toBe("Error en capture: body: se esperaba un texto");
    expect(r.text).not.toContain("{");
  });

  it("reports a wrong argument type with the field and what was expected", async () => {
    const r = await call("recall", { query: "x", limit: "ten" });

    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error en recall: limit: se esperaba un número");
  });

  it("reports a non-integer number as such, not as a number", async () => {
    const r = await call("recall", { query: "x", limit: 2.5 });

    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error en recall: limit: se esperaba un número entero");
  });

  it("reports a value below an exclusive minimum as greater than it", async () => {
    const r = await call("recall", { query: "x", limit: 0 });

    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error en recall: limit: tiene que ser mayor que 0");
  });

  it("reports a value above an inclusive maximum as a cap, not as a range", async () => {
    const r = await call("capture", { scope: "x".repeat(200), body: "a" });

    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error en capture: scope: no puede pasar de 128 caracteres");
  });

  it("reports a value outside an enum as one of its choices", async () => {
    const r = await call("crystallize", {
      scope: "p/a",
      name: "prefers small PRs",
      evidence_memory_ids: ["m1"],
      polarity: "grey",
    });

    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error en crystallize: polarity: debe ser uno de: shadow, light, neutral");
  });

  it("reports missing arguments as a problem with the arguments themselves", async () => {
    const res = (await client.callTool({ name: "capture" })) as ToolResult;

    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toBe("Error en capture: argumentos: se esperaba un objeto");
  });
});

interface IssueCase {
  branch: string;
  tool: string;
  args?: Record<string, unknown>;
  line: string;
}

// One row per branch describeIssue() can reach through a real tool schema. A string minimum
// above 1 and an exclusive numeric maximum have no field to trigger them, so they stay out:
// inventing a schema would test the test, not the mapping.
const ISSUE_CASES: IssueCase[] = [
  {
    branch: "invalid_type de objeto cuando faltan los argumentos",
    tool: "capture",
    line: "Error en capture: argumentos: se esperaba un objeto",
  },
  {
    branch: "invalid_type de texto",
    tool: "capture",
    args: { scope: "p/a", body: 7 },
    line: "Error en capture: body: se esperaba un texto",
  },
  {
    branch: "invalid_type de número",
    tool: "recall",
    args: { query: "x", limit: "ten" },
    line: "Error en recall: limit: se esperaba un número",
  },
  {
    branch: "invalid_type de entero",
    tool: "recall",
    args: { query: "x", limit: 2.5 },
    line: "Error en recall: limit: se esperaba un número entero",
  },
  {
    branch: "invalid_type de booleano",
    tool: "recall",
    args: { query: "x", reinforce: "yes" },
    line: "Error en recall: reinforce: se esperaba true o false",
  },
  {
    branch: "invalid_type de lista",
    tool: "reinforce",
    args: { memory_ids: "m1" },
    line: "Error en reinforce: memory_ids: se esperaba una lista",
  },
  {
    branch: "too_small de texto con mínimo 1",
    tool: "capture",
    args: { scope: "p/a", body: "" },
    line: "Error en capture: body: no puede estar vacío",
  },
  {
    branch: "too_small de lista con mínimo 1",
    tool: "consolidate",
    args: { scope: "p/a", gist: "g", source_episode_ids: [] },
    line: "Error en consolidate: source_episode_ids: no puede estar vacía",
  },
  {
    branch: "too_small numérico inclusivo",
    tool: "forget",
    args: { memory_grace_days: -1 },
    line: "Error en forget: memory_grace_days: no puede ser menor que 0",
  },
  {
    branch: "too_small numérico exclusivo",
    tool: "recall",
    args: { query: "x", limit: 0 },
    line: "Error en recall: limit: tiene que ser mayor que 0",
  },
  {
    branch: "too_big de texto",
    tool: "capture",
    args: { scope: "x".repeat(129), body: "a" },
    line: "Error en capture: scope: no puede pasar de 128 caracteres",
  },
  {
    branch: "too_big de lista",
    tool: "reinforce",
    args: { memory_ids: Array.from({ length: 51 }, (_, i) => `m${i}`) },
    line: "Error en reinforce: memory_ids: no puede tener más de 50 elementos",
  },
  {
    branch: "too_big numérico inclusivo",
    tool: "recall",
    args: { query: "x", limit: 51 },
    line: "Error en recall: limit: no puede ser mayor que 50",
  },
  {
    branch: "invalid_value de enum",
    tool: "crystallize",
    args: { scope: "p/a", name: "n", evidence_memory_ids: ["m1"], polarity: "grey" },
    line: "Error en crystallize: polarity: debe ser uno de: shadow, light, neutral",
  },
];

describe("MCP validation messages", () => {
  it.each(ISSUE_CASES)("$branch", async ({ tool, args, line }) => {
    const r = await call(tool, args);

    expect(r.isError).toBe(true);
    expect(r.text).toBe(line);
  });
});


describe("MCP tool dispatch: write-time layer embedding", () => {
  function fakeEmbedder(seen: string[]): EmbedFn {
    return async (texts) => {
      seen.push(...texts);
      return texts.map(() => Float32Array.from([1, 0]));
    };
  }

  // MISMEM_EMBEDDINGS is off here, so a write only stores a vector because the injected
  // embedder reached it: an alias or a tool that skipped the embedding call leaves no row.
  async function useEmbedder(model?: string): Promise<string[]> {
    const seen: string[] = [];
    await client.close();
    client = await connect(fakeEmbedder(seen), model);
    return seen;
  }

  it("capture stores the vector of the new episode", async () => {
    const seen = await useEmbedder();
    const r = await ok<{ id: string }>("capture", { scope: "p/a", body: "vector de capture" });
    expect(seen).toContain("vector de capture");
    expect(db.prepare("SELECT layer, item_id FROM layer_embeddings").all()).toEqual([
      { layer: "episode", item_id: r.id },
    ]);
  });

  it("crystallize stores the vector of the new trait", async () => {
    const seen = await useEmbedder();
    const r = await ok<{ trait_id: string }>("crystallize", {
      scope: "p/a",
      name: "prefiere PRs pequeños",
      evidence_memory_ids: ["m1"],
    });
    expect(seen).toContain("prefiere PRs pequeños");
    expect(db.prepare("SELECT layer, item_id FROM layer_embeddings").all()).toEqual([
      { layer: "trait", item_id: r.trait_id },
    ]);
  });

  it("recall puntúa con el embedder inyectado, no sólo con el de la configuración", async () => {
    // MISMEM_EMBEDDINGS is off, so a recall that ignored the injection would have no query
    // vector and could not return a hit that shares no word with the episode.
    const seen = await useEmbedder("fake");
    const ep = await ok<{ id: string }>("capture", {
      scope: "p/a",
      body: "el proxy rota las credenciales por la noche",
    });
    seen.length = 0;

    const r = await ok<{ hits: Array<{ id: string; layer: string; via?: string }> }>("recall", {
      query: "cómo cambio la contraseña del servidor",
    });

    expect(seen).toContain("cómo cambio la contraseña del servidor");
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).toMatchObject({ id: ep.id, layer: "episode", via: "semantic" });
  });
});
