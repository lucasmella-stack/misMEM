import { describe, expect, it, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { topics } from "../src/queries/topics.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

/** A unit vector on the plane: the cosine between two is the cosine of their angle. */
function onAngle(degrees: number): Float32Array {
  const r = (degrees * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
}

function memory(
  id: string,
  gist: string,
  opts: { scope?: string; salience?: number; vec?: Float32Array; model?: string } = {},
): void {
  db.prepare(
    "INSERT INTO memories (id, scope, gist, source_episode_ids, salience, created_at) VALUES (?,?,?,'[]',?,0)",
  ).run(id, opts.scope ?? "s", gist, opts.salience ?? 0.5);
  if (opts.vec) {
    db.prepare(
      "INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at) VALUES (?,?,?,?,0)",
    ).run(
      id,
      opts.model ?? "m",
      opts.vec.length,
      Buffer.from(opts.vec.buffer, opts.vec.byteOffset, opts.vec.byteLength),
    );
  }
}

describe("temas", () => {
  it("junta las memorias que se parecen y deja sola a la que no", () => {
    // 0°, 10° and 20° chain above 0.9; 90° resembles none of them.
    memory("a", "hosting en Hetzner", { vec: onAngle(0) });
    memory("b", "el servidor de Hetzner", { vec: onAngle(10) });
    memory("c", "costos del hosting", { vec: onAngle(20) });
    memory("d", "llevar el gato al veterinario", { vec: onAngle(90) });

    const out = topics(db, { minScore: 0.9 });

    expect(out.topics).toHaveLength(1);
    expect(out.topics[0]?.members.sort()).toEqual(["a", "b", "c"]);
    expect(out.alone).toBe(1);
  });

  it("con un ámbito sólo mira las memorias de ese ámbito", () => {
    // The WHERE branch that `scope` turns on was never exercised: deleting it left the suite
    // green and the Temas tab ignoring the scope the rest of the viewer navigates by.
    memory("a", "hosting en Hetzner", { scope: "infra", vec: onAngle(0) });
    memory("b", "el servidor de Hetzner", { scope: "infra", vec: onAngle(10) });
    memory("c", "costos del hosting", { scope: "otro", vec: onAngle(20) });

    const out = topics(db, { minScore: 0.9, scope: "infra" });

    expect(out.considered).toBe(2);
    expect(out.topics).toHaveLength(1);
    expect(out.topics[0]?.members.sort()).toEqual(["a", "b"]);
  });

  it("un tema dice de qué ámbitos sale, que es lo que no se ve navegando por ámbito", () => {
    memory("a", "arquitectura de Daimon", { scope: "project", vec: onAngle(0) });
    memory("b", "Daimon en traefik", { scope: "session", vec: onAngle(8) });
    memory("c", "spores de Daimon", { scope: "project", vec: onAngle(16) });

    const [tema] = topics(db, { minScore: 0.9 }).topics;

    expect(tema?.scopes).toEqual([
      { scope: "project", n: 2 },
      { scope: "session", n: 1 },
    ]);
  });

  it("la puerta de entrada es la memoria más saliente del grupo", () => {
    memory("floja", "una nota floja", { salience: 0.2, vec: onAngle(0) });
    memory("fuerte", "la que importa", { salience: 0.9, vec: onAngle(10) });

    const [tema] = topics(db, { minScore: 0.9 }).topics;

    expect(tema?.entry.id).toBe("fuerte");
    expect(tema?.entry.gist).toBe("la que importa");
  });

  it("ordena los temas por tamaño, el más grande primero", () => {
    for (const [id, deg] of [["a", 0], ["b", 6], ["c", 12]] as const) memory(id, id, { vec: onAngle(deg) });
    for (const [id, deg] of [["x", 90], ["y", 96]] as const) memory(id, id, { vec: onAngle(deg) });

    const out = topics(db, { minScore: 0.9 });

    expect(out.topics.map((t) => t.size)).toEqual([3, 2]);
  });

  it("los marcadores de ruido no forman un tema", () => {
    memory("n1", "[noise] 4 episodios sin señal consolidable", { vec: onAngle(0) });
    memory("n2", "[noise] 7 episodios sin señal consolidable", { vec: onAngle(2) });
    memory("p1", "[pareto:l0] 23 episodios filtrados por baja importancia", { vec: onAngle(4) });

    const out = topics(db, { minScore: 0.9 });

    expect(out.topics).toEqual([]);
    expect(out.considered).toBe(0);
  });

  it("no compara vectores de modelos distintos: no son comparables", () => {
    memory("a", "una", { vec: onAngle(0), model: "viejo" });
    memory("b", "otra", { vec: onAngle(5), model: "nuevo" });
    memory("c", "tercera", { vec: onAngle(10), model: "nuevo" });

    const out = topics(db, { minScore: 0.9 });

    expect(out.topics[0]?.members.sort()).toEqual(["b", "c"]);
  });

  it("mira sólo las más salientes hasta el tope, para que el coste no se dispare", () => {
    memory("alta1", "alta", { salience: 0.9, vec: onAngle(0) });
    memory("alta2", "alta", { salience: 0.8, vec: onAngle(5) });
    memory("baja", "baja", { salience: 0.1, vec: onAngle(10) });

    const out = topics(db, { minScore: 0.9, limit: 2 });

    expect(out.considered).toBe(2);
    expect(out.topics[0]?.members.sort()).toEqual(["alta1", "alta2"]);
  });

  it("una memoria sin vector no entra en ningún tema ni cuenta como sola", () => {
    memory("con", "con vector", { vec: onAngle(0) });
    memory("sin", "sin vector");

    const out = topics(db, { minScore: 0.9 });

    expect(out.considered).toBe(1);
    expect(out.alone).toBe(1);
  });
});
