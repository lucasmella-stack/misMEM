import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import { reinforce } from "../src/memory/reinforce.js";
import { reinforceMemories } from "../src/memory/salience.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

function memory(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  return consolidate(db, {
    scope: "test",
    gist,
    source_episode_ids: [episode.id],
  }).memory_id;
}

const useCountOf = (id: string): number =>
  (db.prepare("SELECT use_count AS n FROM memories WHERE id = ?").get(id) as { n: number }).n;

interface CoUseRow {
  memory_a: string;
  memory_b: string;
  n: number;
  last_at: number;
}

const coUseRows = (): CoUseRow[] =>
  db.prepare("SELECT memory_a, memory_b, n, last_at FROM co_use ORDER BY memory_a, memory_b").all() as CoUseRow[];

const pairOf = (x: string, y: string): CoUseRow | undefined => {
  const [a, b] = x < y ? [x, y] : [y, x];
  return db
    .prepare("SELECT memory_a, memory_b, n, last_at FROM co_use WHERE memory_a = ? AND memory_b = ?")
    .get(a, b) as CoUseRow | undefined;
};

describe("use_count", () => {
  it("arranca en cero y sólo lo sube el recuerdo que se usó", () => {
    const usado = memory("el deploy usa docker compose");
    const ignorado = memory("el backup corre a las tres");
    expect(useCountOf(usado)).toBe(0);

    reinforce(db, { memory_ids: [usado] });

    expect(useCountOf(usado)).toBe(1);
    expect(useCountOf(ignorado)).toBe(0);
  });

  it("cuenta turnos: dos usos en turnos distintos suman dos", () => {
    const id = memory("el deploy usa docker compose");

    reinforce(db, { memory_ids: [id] });
    reinforce(db, { memory_ids: [id] });

    expect(useCountOf(id)).toBe(2);
  });

  it("no lo mueve la aparición en un recall, sólo el uso medido", () => {
    // The Hebbian signal is polluted if surfacing counts as use: the recall path
    // calls reinforceMemories() too.
    const id = memory("el deploy usa docker compose");

    reinforceMemories(db, [id]);

    expect(useCountOf(id)).toBe(0);
  });
});

describe("co_use", () => {
  it("registra el par cuando dos recuerdos se usan en el mismo turno", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    reinforce(db, { memory_ids: [a, b] });

    expect(pairOf(a, b)).toMatchObject({ n: 1 });
  });

  it("no registra par si se usaron en turnos distintos", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    reinforce(db, { memory_ids: [a] });
    reinforce(db, { memory_ids: [b] });

    expect(coUseRows()).toEqual([]);
  });

  it("acumula el mismo par sin importar el orden en que llega", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    reinforce(db, { memory_ids: [a, b] });
    reinforce(db, { memory_ids: [b, a] });

    const rows = coUseRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.n).toBe(2);
  });

  it("un recuerdo usado solo no genera par", () => {
    const solo = memory("el deploy usa docker compose");

    reinforce(db, { memory_ids: [solo] });

    expect(coUseRows()).toEqual([]);
  });

  it("tres recuerdos juntos generan los tres pares", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");
    const c = memory("el bench corre con el embedder arriba");

    reinforce(db, { memory_ids: [a, b, c] });

    expect(coUseRows()).toHaveLength(3);
  });

  it("no lo escribe la aparición en un recall", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    reinforceMemories(db, [a, b]);

    expect(coUseRows()).toEqual([]);
  });

  it("un rasgo en la lista no genera par con un recuerdo", () => {
    const a = memory("el deploy usa docker compose");
    const rasgo = crystallize(db, {
      scope: "test",
      name: "prefiere docker compose",
      evidence_memory_ids: [a],
    });
    const rasgoId = rasgo.trait_id;

    reinforce(db, { memory_ids: [a, rasgoId] });

    expect(coUseRows()).toEqual([]);
  });

  it("ignora ids que no existen en vez de inventar pares", () => {
    const a = memory("el deploy usa docker compose");

    reinforce(db, { memory_ids: [a, "01INVENTADO000000000000000"] });

    expect(coUseRows()).toEqual([]);
  });

  it("anota cuándo fue el último uso del par", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    reinforce(db, { memory_ids: [a, b] }, { at: 1_700_000_000_000 });

    expect(pairOf(a, b)?.last_at).toBe(1_700_000_000_000);
  });

  it("al borrarse un recuerdo se van sus pares, sin dejar huérfanos", () => {
    // forget() sweeps by age and salience but ends in a DELETE: the cascade is what
    // keeps the table from piling up garbage.
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");
    reinforce(db, { memory_ids: [a, b] });
    expect(coUseRows()).toHaveLength(1);

    db.prepare("DELETE FROM memories WHERE id = ?").run(a);

    expect(coUseRows()).toEqual([]);
  });
});
