import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

async function call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
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

  it("el backfill que sigue a consolidate respeta el tope de 64 y no deja sin vector la memoria nueva", async () => {
    const insert = db.prepare(
      "INSERT INTO memories (id, scope, gist, source_episode_ids, created_at) VALUES (?, ?, ?, '[]', ?)",
    );
    for (let i = 0; i < 70; i++) insert.run(`pending-${i}`, "p/a", `pending ${i}`, Date.now());
    const ep = await ok<{ id: string }>("capture", { scope: "p/a", body: "raw note" });

    const keys = ["MISMEM_EMBEDDINGS", "MISMEM_EMBEDDING_URL", "MISMEM_EMBEDDING_MODEL"] as const;
    const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    const sent: string[] = [];
    // The tool's trailing backfill takes no embedder argument, so the only way to watch it
    // is the default path: environment config plus a stubbed HTTP server.
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const { input } = JSON.parse(init.body) as { input: string[] };
      sent.push(...input);
      const data = input.map((_, index) => ({ index, embedding: [1, 0] }));
      return new Response(JSON.stringify({ data }));
    });
    process.env.MISMEM_EMBEDDINGS = "1";
    process.env.MISMEM_EMBEDDING_URL = "http://embed.test";
    process.env.MISMEM_EMBEDDING_MODEL = "fake";
    try {
      const memory = await ok<{ memory_id: string }>("consolidate", {
        scope: "p/a",
        gist: "distilled under a backlog",
        source_episode_ids: [ep.id],
      });
      // The row created last would sit behind the whole backlog in scan order, so only a
      // priority id keeps it inside the cap; the rest of the backlog waits for the next pass.
      expect(sent).toContain("distilled under a backlog");
      expect(
        db.prepare("SELECT memory_id FROM memory_embeddings WHERE memory_id = ?").get(memory.memory_id),
      ).toEqual({ memory_id: memory.memory_id });
    } finally {
      vi.unstubAllGlobals();
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }

    expect(sent).toHaveLength(64);
    expect(count("SELECT COUNT(*) AS n FROM memory_embeddings")).toBe(64);
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
