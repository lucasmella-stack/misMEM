import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import type { EmbedFn } from "../src/embeddings/provider.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import {
  dispatchEngramTool,
  isEngramTool,
  ENGRAM_TOOLS,
} from "../src/mcp/engram-compat.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("engram-compat: tool registration", () => {
  it("exports the canonical engram tool set", async () => {
    const names = ENGRAM_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "mem_save",
        "mem_search",
        "mem_context",
        "mem_get_observation",
        "mem_session_summary",
        "mem_save_prompt",
        "mem_update",
        "mem_suggest_topic_key",
        "mem_session_start",
        "mem_session_end",
      ]),
    );
  });

  it("identifies engram-prefixed tools", async () => {
    expect(isEngramTool("mem_save")).toBe(true);
    expect(isEngramTool("capture")).toBe(false);
  });
});

describe("engram-compat: mem_save → capture", () => {
  it("creates an episode with formatted body", async () => {
    const result = (await dispatchEngramTool(db, "mem_save", {
      title: "Migrate engram",
      type: "decision",
      topic_key: "infra/mismem-migration",
      content: "Coexist via separate domain",
    })) as { id: string };
    expect(result.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = db
      .prepare("SELECT body, scope FROM episodes WHERE id = ?")
      .get(result.id) as { body: string; scope: string };
    expect(row.body).toContain("Title: Migrate engram");
    expect(row.body).toContain("Type: decision");
    expect(row.body).toContain("TopicKey: infra/mismem-migration");
    expect(row.body).toContain("Coexist via separate domain");
    expect(row.scope).toBe("engram-compat");
  });

  it("respects custom scope", async () => {
    const r = (await dispatchEngramTool(db, "mem_save", {
      title: "x",
      content: "y",
      scope: "personal",
    })) as { id: string };
    const row = db
      .prepare("SELECT scope FROM episodes WHERE id = ?")
      .get(r.id) as { scope: string };
    expect(row.scope).toBe("personal");
  });
});

describe("engram-compat: mem_search → recall", () => {
  it("returns FTS hits", async () => {
    capture(db, { scope: "x", body: "alpha beta gamma" });
    const out = (await dispatchEngramTool(db, "mem_search", { query: "alpha" })) as {
      hits: unknown[];
    };
    expect(out.hits.length).toBe(1);
  });
});

describe("engram-compat: mem_context", () => {
  it("returns latest N episodes ordered by recency", async () => {
    capture(db, { scope: "a", body: "first" });
    capture(db, { scope: "a", body: "second" });
    capture(db, { scope: "b", body: "third" });
    const out = (await dispatchEngramTool(db, "mem_context", { limit: 2 })) as {
      hits: Array<{ text: string }>;
    };
    expect(out.hits).toHaveLength(2);
    expect(out.hits[0]?.text).toBe("third");
  });

  it("filters by scope", async () => {
    capture(db, { scope: "a", body: "alpha" });
    capture(db, { scope: "b", body: "beta" });
    const out = (await dispatchEngramTool(db, "mem_context", {
      scope: "a",
      limit: 10,
    })) as { hits: Array<{ scope: string }> };
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0]?.scope).toBe("a");
  });
});

describe("engram-compat: mem_get_observation", () => {
  it("returns episode by id", async () => {
    const { id } = capture(db, { scope: "s", body: "raw text" });
    const out = (await dispatchEngramTool(db, "mem_get_observation", { id })) as {
      layer: string;
      text: string;
    };
    expect(out.layer).toBe("episode");
    expect(out.text).toBe("raw text");
  });

  it("returns memory by id", async () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "summary",
      source_episode_ids: [ep],
    });
    const out = (await dispatchEngramTool(db, "mem_get_observation", {
      id: memory_id,
    })) as { layer: string; gist: string };
    expect(out.layer).toBe("memory");
    expect(out.gist).toBe("summary");
  });

  it("returns trait by id", async () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [ep],
    });
    const { trait_id } = crystallize(db, {
      scope: "s",
      name: "trait-name",
      evidence_memory_ids: [memory_id],
    });
    const out = (await dispatchEngramTool(db, "mem_get_observation", {
      id: trait_id,
    })) as { layer: string; name: string };
    expect(out.layer).toBe("trait");
    expect(out.name).toBe("trait-name");
  });

  it("throws on missing id", async () => {
    await expect(
      dispatchEngramTool(db, "mem_get_observation", { id: "doesnotexist" }),
    ).rejects.toThrow(/no existe/);
  });
});

describe("engram-compat: mem_update", () => {
  it("updates a memory's gist", async () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "old",
      source_episode_ids: [ep],
    });
    const out = (await dispatchEngramTool(db, "mem_update", {
      id: memory_id,
      content: "new gist",
    })) as { updated: string };
    expect(out.updated).toBe("memory");
    const row = db
      .prepare("SELECT gist FROM memories WHERE id = ?")
      .get(memory_id) as { gist: string };
    expect(row.gist).toBe("new gist");
  });

  it("invalida el embedding al actualizar una memory", async () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "old",
      source_episode_ids: [ep],
    });
    db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at)
       VALUES (?, 'fake', 1, ?, ?)`,
    ).run(memory_id, Buffer.from(new Float32Array([1]).buffer), Date.now());

    (await dispatchEngramTool(db, "mem_update", {
      id: memory_id,
      content: "new gist",
    }));

    expect(
      db
        .prepare(
          "SELECT 1 FROM memory_embeddings WHERE memory_id = ?",
        )
        .get(memory_id),
    ).toBeUndefined();
  });

  it("al renombrar un rasgo embebe el nombre nuevo en el mismo paso", async () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [ep],
    });
    const { trait_id } = crystallize(db, {
      scope: "s",
      name: "nombre viejo",
      evidence_memory_ids: [memory_id],
    });
    db.prepare(
      `INSERT INTO layer_embeddings (layer, item_id, model, dims, vec, created_at)
       VALUES ('trait', ?, 'fake', 1, ?, ?)`,
    ).run(trait_id, Buffer.from(new Float32Array([1]).buffer), Date.now());

    const seen: string[] = [];
    const embedFn: EmbedFn = async (texts) => {
      seen.push(...texts);
      return texts.map(() => Float32Array.from([0, 1]));
    };
    await dispatchEngramTool(
      db,
      "mem_update",
      { id: trait_id, content: "nombre nuevo" },
      { embedFn, embeddingModel: "fake" },
    );

    expect(seen).toEqual(["nombre nuevo"]);
    expect(db.prepare("SELECT name FROM traits WHERE id = ?").get(trait_id)).toEqual({
      name: "nombre nuevo",
    });
    const row = db
      .prepare(
        "SELECT model, dims, vec FROM layer_embeddings WHERE layer = 'trait' AND item_id = ?",
      )
      .get(trait_id) as { model: string; dims: number; vec: Buffer };
    expect(row.model).toBe("fake");
    expect(row.dims).toBe(2);
    expect(
      Array.from(new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4)),
    ).toEqual([0, 1]);
  });

  it("renombrar un rasgo con el mismo nombre no toca su vector", async () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [ep],
    });
    const { trait_id } = crystallize(db, {
      scope: "s",
      name: "nombre igual",
      evidence_memory_ids: [memory_id],
    });
    db.prepare(
      `INSERT INTO layer_embeddings (layer, item_id, model, dims, vec, created_at)
       VALUES ('trait', ?, 'fake', 1, ?, ?)`,
    ).run(trait_id, Buffer.from(new Float32Array([1]).buffer), Date.now());

    let calls = 0;
    const embedFn: EmbedFn = async (texts) => {
      calls += texts.length;
      return texts.map(() => Float32Array.from([0, 1]));
    };
    await dispatchEngramTool(
      db,
      "mem_update",
      { id: trait_id, content: "nombre igual" },
      { embedFn, embeddingModel: "fake" },
    );

    expect(calls).toBe(0);
    const row = db
      .prepare(
        "SELECT dims, vec FROM layer_embeddings WHERE layer = 'trait' AND item_id = ?",
      )
      .get(trait_id) as { dims: number; vec: Buffer };
    expect(row.dims).toBe(1);
    expect(
      Array.from(new Float32Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength / 4)),
    ).toEqual([1]);
  });

  it("rolls the gist back when invalidating the embedding fails", async () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "old",
      source_episode_ids: [ep],
    });
    db.prepare(
      `INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at)
       VALUES (?, 'fake', 1, ?, ?)`,
    ).run(memory_id, Buffer.from(new Float32Array([1]).buffer), Date.now());
    // Both writes are one transaction: a delete that fails must not leave the new gist stored
    // next to a vector that still describes the old text.
    db.exec(
      `CREATE TRIGGER refuse_embedding_delete BEFORE DELETE ON memory_embeddings
       BEGIN SELECT RAISE(ABORT, 'embedding delete refused'); END;`,
    );

    await expect(
      dispatchEngramTool(db, "mem_update", { id: memory_id, content: "new gist" }),
    ).rejects.toThrow(/embedding delete refused/);

    const row = db
      .prepare("SELECT gist FROM memories WHERE id = ?")
      .get(memory_id) as { gist: string };
    expect(row.gist).toBe("old");
  });

  it("appends new episode if id not found", async () => {
    const out = (await dispatchEngramTool(db, "mem_update", {
      id: "01ABCDEFGHIJKLMNPQRSTVWXYZ",
      content: "fallback",
    })) as { updated: string; new_id: string };
    expect(out.updated).toBe("appended");
    expect(out.new_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe("engram-compat: mem_suggest_topic_key", () => {
  it("classifies by keywords + slug", async () => {
    const out = (await dispatchEngramTool(db, "mem_suggest_topic_key", {
      title: "Fix N+1 query bug",
      content: "found in UserList component",
    })) as { topic_key: string };
    expect(out.topic_key).toBe("bugfix/fix-n-1-query-bug");
  });
});

describe("engram-compat: session no-ops", () => {
  it("mem_session_start returns ack", async () => {
    const out = (await dispatchEngramTool(db, "mem_session_start", {})) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);
  });

  it("mem_session_end returns ack", async () => {
    const out = (await dispatchEngramTool(db, "mem_session_end", {})) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);
  });
});

describe("engram-compat: mem_session_summary + mem_save_prompt", () => {
  it("session_summary captures with default scope=session", async () => {
    const out = (await dispatchEngramTool(db, "mem_session_summary", {
      content: "did stuff",
    })) as { id: string };
    const row = db
      .prepare("SELECT scope, body FROM episodes WHERE id = ?")
      .get(out.id) as { scope: string; body: string };
    expect(row.scope).toBe("session");
    expect(row.body).toBe("did stuff");
  });

  it("save_prompt captures with default scope=prompts", async () => {
    const out = (await dispatchEngramTool(db, "mem_save_prompt", {
      content: "user said X",
    })) as { id: string };
    const row = db
      .prepare("SELECT scope FROM episodes WHERE id = ?")
      .get(out.id) as { scope: string };
    expect(row.scope).toBe("prompts");
  });
});

describe("engram-compat: aliases that write episodes embed like capture", () => {
  function fakeEmbedder(seen: string[]): EmbedFn {
    return async (texts) => {
      seen.push(...texts);
      return texts.map(() => Float32Array.from([1, 0]));
    };
  }

  it("mem_save stores the vector of the new episode", async () => {
    const seen: string[] = [];
    await dispatchEngramTool(
      db,
      "mem_save",
      { content: "nota desde engram" },
      { embedFn: fakeEmbedder(seen), embeddingModel: "fake" },
    );

    expect(seen.some((text) => text.includes("nota desde engram"))).toBe(true);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM layer_embeddings WHERE layer = 'episode'").get(),
    ).toEqual({ n: 1 });
  });

  it("mem_session_summary stores the vector of the new episode", async () => {
    const seen: string[] = [];
    await dispatchEngramTool(
      db,
      "mem_session_summary",
      { content: "resumen de sesión" },
      { embedFn: fakeEmbedder(seen), embeddingModel: "fake" },
    );

    expect(seen).toContain("resumen de sesión");
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM layer_embeddings WHERE layer = 'episode'").get(),
    ).toEqual({ n: 1 });
  });
});
