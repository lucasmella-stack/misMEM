import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  capture,
  recall,
  consolidate,
  crystallize,
  forget,
  reinforce,
} from "../src/tools.js";

let db: DB;
const DAY = 86_400_000;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("capture", () => {
  it("stores an episode and returns its id", () => {
    const { id } = capture(db, { scope: "test", body: "hola mundo" });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as {
      body: string;
    };
    expect(row.body).toBe("hola mundo");
  });

  it("rejects empty body", () => {
    expect(() => capture(db, { scope: "test", body: "" })).toThrow();
  });
});

describe("recall", () => {
  it("finds episodes via FTS and respects scope", () => {
    capture(db, { scope: "a", body: "alpha beta gamma" });
    capture(db, { scope: "b", body: "alpha delta" });
    const { hits } = recall(db, { query: "alpha", scope: "a" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scope).toBe("a");
  });

  it("returns empty when no match", () => {
    capture(db, { scope: "a", body: "alpha" });
    const { hits } = recall(db, { query: "zeta" });
    expect(hits).toEqual([]);
  });

  it("does not give a trait a fixed step over an equally matching memory", () => {
    const { id: ep } = capture(db, { scope: "s", body: "patron recurrente" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "patron recurrente observado",
      source_episode_ids: [ep],
    });
    crystallize(db, {
      scope: "s",
      name: "patron recurrente",
      evidence_memory_ids: [memory_id],
    });
    const { hits } = recall(db, { query: "patron" });
    // Equal FTS rank, so the fusion decides: a memory keeps its salience tie-break and a
    // trait no longer starts with a layer multiplier.
    expect(hits.map((hit) => hit.layer)).toEqual(["memory", "trait"]);
  });
});

describe("consolidate", () => {
  it("creates memory and links episodes", () => {
    const { id: e1 } = capture(db, { scope: "s", body: "uno" });
    const { id: e2 } = capture(db, { scope: "s", body: "dos" });
    const { memory_id, consolidated } = consolidate(db, {
      scope: "s",
      gist: "resumen",
      source_episode_ids: [e1, e2],
    });
    expect(consolidated).toBe(2);
    const ep = db
      .prepare("SELECT consolidated_into FROM episodes WHERE id = ?")
      .get(e1) as { consolidated_into: string };
    expect(ep.consolidated_into).toBe(memory_id);
  });

  it("does not consolidate episodes from a different scope", () => {
    const { id } = capture(db, { scope: "other", body: "x" });
    const { consolidated } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [id],
    });
    expect(consolidated).toBe(0);
  });
});

describe("crystallize", () => {
  it("creates a new trait", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [ep],
    });
    const { created, strength } = crystallize(db, {
      scope: "s",
      name: "rasgo",
      evidence_memory_ids: [memory_id],
      polarity: "shadow",
    });
    expect(created).toBe(true);
    expect(strength).toBe(1);
  });

  it("strengthens existing trait on repeat", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [ep],
    });
    crystallize(db, {
      scope: "s",
      name: "rasgo",
      evidence_memory_ids: [memory_id],
    });
    const second = crystallize(db, {
      scope: "s",
      name: "rasgo",
      evidence_memory_ids: [memory_id],
    });
    expect(second.created).toBe(false);
    expect(second.strength).toBe(2);
  });
});

describe("reinforce", () => {
  function memory(gist: string): string {
    const episode = capture(db, { scope: "test", body: `source ${gist}` });
    const id = consolidate(db, { scope: "test", gist, source_episode_ids: [episode.id] }).memory_id;
    db.prepare("UPDATE memories SET salience = 0.4 WHERE id = ?").run(id);
    return id;
  }
  const salienceOf = (id: string): number =>
    (db.prepare("SELECT salience AS s FROM memories WHERE id = ?").get(id) as { s: number }).s;

  it("sube la saliencia sólo de los recuerdos que se usaron", () => {
    const usado = memory("el deploy usa docker compose");
    const ignorado = memory("el backup corre a las tres");

    const result = reinforce(db, { memory_ids: [usado] });

    expect(result).toEqual({ reinforced: 1, traits: 0, unknown: 0 });
    expect(salienceOf(usado)).toBeGreaterThan(0.4);
    expect(salienceOf(ignorado)).toBe(0.4);
  });

  it("informa los ids que no existen en vez de fallar en silencio", () => {
    const real = memory("el deploy usa docker compose");

    const result = reinforce(db, { memory_ids: [real, "01INVENTADO000000000000000"] });

    expect(result).toEqual({ reinforced: 1, traits: 0, unknown: 1 });
  });

  it("un rasgo se cuenta aparte, no como id inventado", () => {
    // La inyección también adelanta rasgos; si cayeran en `unknown`, esa alarma
    // —la de "alguien manda ids que no existen"— sonaría desde el primer día.
    const real = memory("el deploy usa docker compose");
    const rasgo = crystallize(db, {
      scope: "test",
      name: "prefiere docker compose",
      evidence_memory_ids: [real],
    });
    const rasgoId = rasgo.trait_id;

    const result = reinforce(db, { memory_ids: [real, rasgoId, "01INVENTADO000000000000000"] });

    expect(result).toEqual({ reinforced: 1, traits: 1, unknown: 1 });
  });

  it("rechaza una lista vacía", () => {
    expect(() => reinforce(db, { memory_ids: [] })).toThrow();
  });
});

describe("MISMEM_REINFORCE_ON_RECALL", () => {
  const previous = process.env.MISMEM_REINFORCE_ON_RECALL;
  afterEach(() => {
    if (previous === undefined) delete process.env.MISMEM_REINFORCE_ON_RECALL;
    else process.env.MISMEM_REINFORCE_ON_RECALL = previous;
  });

  function memory(gist: string): string {
    const episode = capture(db, { scope: "test", body: `source ${gist}` });
    const id = consolidate(db, { scope: "test", gist, source_episode_ids: [episode.id] }).memory_id;
    db.prepare("UPDATE memories SET salience = 0.4 WHERE id = ?").run(id);
    return id;
  }
  const salienceOf = (id: string): number =>
    (db.prepare("SELECT salience AS s FROM memories WHERE id = ?").get(id) as { s: number }).s;

  it("en off, aparecer en el recall ya no sube la saliencia", () => {
    const id = memory("el deploy usa docker compose");
    process.env.MISMEM_REINFORCE_ON_RECALL = "off";

    const hits = recall(db, { query: "deploy docker" }).hits;

    expect(hits.some((h) => h.id === id)).toBe(true);
    expect(salienceOf(id)).toBe(0.4);
  });

  it("sin la variable sigue reforzando como hasta ahora", () => {
    const id = memory("el deploy usa docker compose");
    delete process.env.MISMEM_REINFORCE_ON_RECALL;

    recall(db, { query: "deploy docker" });

    expect(salienceOf(id)).toBeGreaterThan(0.4);
  });
});

describe("forget", () => {
  it("dry_run reports counts without deleting", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    consolidate(db, { scope: "s", gist: "g", source_episode_ids: [ep] });
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 60 * 86_400_000,
      ep,
    );
    const r = forget(db, { before_days: 30, dry_run: true });
    expect(r.episodes_to_delete).toBe(1);
    const still = db
      .prepare("SELECT COUNT(*) AS n FROM episodes")
      .get() as { n: number };
    expect(still.n).toBe(1);
  });

  it("actually deletes when dry_run=false", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    consolidate(db, { scope: "s", gist: "g", source_episode_ids: [ep] });
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 60 * 86_400_000,
      ep,
    );
    forget(db, { before_days: 30, dry_run: false });
    const still = db
      .prepare("SELECT COUNT(*) AS n FROM episodes")
      .get() as { n: number };
    expect(still.n).toBe(0);
  });

  it("keeps a forgettable memory while one of its episodes is newer than before_days", () => {
    const { id: ep } = capture(db, { scope: "s", body: "evidencia reciente" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "memoria de baja salience",
      source_episode_ids: [ep],
    });
    const old = Date.now() - 60 * DAY;
    db.prepare(
      `UPDATE memories
       SET salience = 0.01, created_at = ?, salience_updated_at = ?
       WHERE id = ?`,
    ).run(old, old, memory_id);
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 40 * DAY,
      ep,
    );

    const result = forget(db, {
      before_days: 90,
      memory_grace_days: 30,
      salience_below: 0.1,
      dry_run: false,
    });

    expect(result).toMatchObject({
      memories_to_delete: 0,
      episodes_to_delete: 0,
    });
    expect(
      db.prepare("SELECT 1 FROM memories WHERE id = ?").get(memory_id),
    ).toBeDefined();
    expect(db.prepare("SELECT 1 FROM episodes WHERE id = ?").get(ep)).toBeDefined();
  });

  it("deletes that memory with its episodes once every one of them is older than before_days", () => {
    const { id: ep } = capture(db, { scope: "s", body: "evidencia vieja" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "memoria de baja salience",
      source_episode_ids: [ep],
    });
    const oldMemory = Date.now() - 60 * DAY;
    db.prepare(
      `UPDATE memories
       SET salience = 0.01, created_at = ?, salience_updated_at = ?
       WHERE id = ?`,
    ).run(oldMemory, oldMemory, memory_id);
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 100 * DAY,
      ep,
    );

    const result = forget(db, {
      before_days: 90,
      memory_grace_days: 30,
      salience_below: 0.1,
      dry_run: false,
    });

    expect(result).toMatchObject({
      memories_to_delete: 1,
      episodes_to_delete: 1,
    });
    expect(
      db.prepare("SELECT 1 FROM memories WHERE id = ?").get(memory_id),
    ).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM episodes WHERE id = ?").get(ep)).toBeUndefined();
  });

  it("dry_run counts exactly what the real run deletes", () => {
    const { id: oldEp } = capture(db, { scope: "s", body: "viejo uno" });
    const { id: olderEp } = capture(db, { scope: "s", body: "viejo dos" });
    const { memory_id: forgettable } = consolidate(db, {
      scope: "s",
      gist: "olvidable",
      source_episode_ids: [oldEp, olderEp],
    });
    const { id: recentEp } = capture(db, { scope: "s", body: "reciente" });
    const { memory_id: protectedMemory } = consolidate(db, {
      scope: "s",
      gist: "protegida",
      source_episode_ids: [recentEp],
    });
    const oldMemory = Date.now() - 60 * DAY;
    const ageMemory = db.prepare(
      `UPDATE memories
       SET salience = 0.01, created_at = ?, salience_updated_at = ?
       WHERE id = ?`,
    );
    ageMemory.run(oldMemory, oldMemory, forgettable);
    ageMemory.run(oldMemory, oldMemory, protectedMemory);
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 100 * DAY,
      oldEp,
    );
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 120 * DAY,
      olderEp,
    );
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 40 * DAY,
      recentEp,
    );

    const options = {
      before_days: 90,
      memory_grace_days: 30,
      salience_below: 0.1,
    };
    const episodesBefore = db
      .prepare("SELECT COUNT(*) AS n FROM episodes")
      .get() as { n: number };
    const memoriesBefore = db
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .get() as { n: number };

    const dry = forget(db, { ...options, dry_run: true });
    const real = forget(db, { ...options, dry_run: false });

    expect(real).toMatchObject({
      episodes_to_delete: dry.episodes_to_delete,
      memories_to_delete: dry.memories_to_delete,
      dry_run: false,
    });
    expect(dry).toMatchObject({
      episodes_to_delete: 2,
      memories_to_delete: 1,
      dry_run: true,
    });
    const episodesAfter = db
      .prepare("SELECT COUNT(*) AS n FROM episodes")
      .get() as { n: number };
    const memoriesAfter = db
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .get() as { n: number };
    expect(episodesBefore.n - episodesAfter.n).toBe(real.episodes_to_delete);
    expect(memoriesBefore.n - memoriesAfter.n).toBe(real.memories_to_delete);
  });
});
