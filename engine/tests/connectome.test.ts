import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { reinforce } from "../src/memory/reinforce.js";
import { reinforceMemories } from "../src/memory/salience.js";
import {
  associationStrength,
  coUseEdges,
  hubs,
  seedTurnsFromUse,
  turnsRegistered,
} from "../src/store/connectome.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

function memory(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  return consolidate(db, { scope: "test", gist, source_episode_ids: [episode.id] }).memory_id;
}

/** One turn of measured use: what the `Stop` hook sends when a reply used memories. */
const turn = (...ids: string[]): void => {
  reinforce(db, { memory_ids: ids });
};

const strengthOf = (a: string, b: string): number => {
  const [x, y] = a < b ? [a, b] : [b, a];
  const edge = coUseEdges(db).find((e) => e.memory_a === x && e.memory_b === y);
  if (!edge) throw new Error("ese par no está en co_use");
  return edge.strength;
};

describe("contador de turnos", () => {
  it("arranca en cero", () => {
    expect(turnsRegistered(db)).toBe(0);
  });

  it("cuenta un turno por cada uso medido, aunque sea de un solo recuerdo", () => {
    // The denominator has to include single-memory turns: without them, a memory
    // always used on its own would look rarer than it is.
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    turn(a);
    turn(a, b);

    expect(turnsRegistered(db)).toBe(2);
  });

  it("no lo mueve la aparición en un recall", () => {
    const a = memory("el deploy usa docker compose");

    reinforceMemories(db, [a]);

    expect(turnsRegistered(db)).toBe(0);
  });

  it("no cuenta un turno si ningún id existía", () => {
    reinforce(db, { memory_ids: ["01INVENTADO000000000000000"] });

    expect(turnsRegistered(db)).toBe(0);
  });
});

describe("fuerza de asociación", () => {
  it("es 1 cuando dos recuerdos sólo aparecen juntos", () => {
    expect(associationStrength({ n: 3, useA: 3, useB: 3, turns: 6 })).toBeCloseTo(1, 5);
  });

  it("es 0 cuando uno está en todos los turnos: saberlo no informa nada", () => {
    // The rich-club case: identity and the pact are used in every turn, so their
    // co-use with anything is exactly what chance predicts.
    expect(associationStrength({ n: 5, useA: 10, useB: 5, turns: 10 })).toBeCloseTo(0, 5);
  });

  it("es negativa cuando dos recuerdos se evitan más de lo esperable", () => {
    expect(associationStrength({ n: 1, useA: 8, useB: 8, turns: 10 })).toBeLessThan(0);
  });

  it("no explota sin turnos ni sin usos", () => {
    expect(associationStrength({ n: 0, useA: 0, useB: 0, turns: 0 })).toBe(0);
    expect(associationStrength({ n: 1, useA: 0, useB: 1, turns: 1 })).toBe(0);
  });
});

describe("el conteo crudo y la fuerza no dicen lo mismo", () => {
  it("el par con más co-usos no es el más fuerte", () => {
    // H is used in every turn; X joins it in half of them. A and B are used little,
    // but never apart.
    const h = memory("hablamos en español y sin rodeos");
    const x = memory("el deploy usa docker compose");
    const a = memory("el bench corre con el embedder arriba");
    const b = memory("el banco de preguntas es privado");

    for (let i = 0; i < 5; i++) turn(h, x);
    for (let i = 0; i < 5; i++) turn(h);
    turn(a, b);
    turn(a, b);

    const hx = coUseEdges(db).find((e) => e.memory_a === (h < x ? h : x))!;
    expect(hx.n).toBe(5);
    expect(strengthOf(a, b)).toBeGreaterThan(strengthOf(h, x));
    expect(strengthOf(a, b)).toBeCloseTo(1, 5);
  });
});

describe("aristas del conectoma", () => {
  it("devuelve el par con su conteo, su fuerza y cuándo fue la última vez", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    reinforce(db, { memory_ids: [a, b] }, { at: 1_700_000_000_000 });

    const edges = coUseEdges(db);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ n: 1, last_at: 1_700_000_000_000 });
    expect(typeof edges[0]?.strength).toBe("number");
  });

  it("filtra por soporte mínimo, que es lo que separa la señal del par de una sola vez", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");
    const c = memory("el bench corre con el embedder arriba");

    turn(a, b);
    turn(a, b);
    turn(a, c);

    expect(coUseEdges(db, { minN: 2 })).toHaveLength(1);
    expect(coUseEdges(db, { minN: 1 })).toHaveLength(2);
  });

  it("acotado a un conjunto de ids, no trae aristas que apunten afuera", () => {
    // The viewer graph is capped: an edge to a node nobody draws is a dangling
    // reference that breaks the render.
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");
    const outside = memory("esto no entra en el grafo");

    turn(a, b);
    turn(a, outside);

    const edges = coUseEdges(db, { ids: [a, b] });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.memory_a).toBe(a < b ? a : b);
  });

  it("sin uso medido no hay aristas", () => {
    memory("el deploy usa docker compose");

    expect(coUseEdges(db)).toEqual([]);
  });
});

describe("hubs", () => {
  it("ordena por fuerza sumada y no por cantidad de vecinos", () => {
    // The node with the most neighbours is the one used in every turn, which is
    // precisely the one that orients nobody.
    const h = memory("hablamos en español y sin rodeos");
    const v1 = memory("el deploy usa docker compose");
    const v2 = memory("el backup corre a las tres");
    const v3 = memory("el bench corre con el embedder arriba");
    const par1 = memory("el ordenador de memoria tiene tres fases");
    const par2 = memory("la fase dos espera datos de co-uso");

    for (let i = 0; i < 4; i++) turn(h, v1, v2, v3);
    for (let i = 0; i < 8; i++) turn(h);
    for (let i = 0; i < 4; i++) turn(par1, par2);

    const ranking = hubs(db);
    expect(ranking[0]?.id).not.toBe(h);
    expect(ranking.find((x) => x.id === h)!.degree).toBeGreaterThan(
      ranking.find((x) => x.id === par1)!.degree,
    );
    expect(ranking.find((x) => x.id === par1)!.strength).toBeGreaterThan(
      ranking.find((x) => x.id === h)!.strength,
    );
  });

  it("sin turnos no hay hubs", () => {
    memory("el deploy usa docker compose");

    expect(hubs(db)).toEqual([]);
  });

  it("una coincidencia no encabeza el ranking por encima de un par repetido", () => {
    // NPMI gives a pair seen once the maximum, so without weighting the support the list of
    // "where to enter" is led by exactly the pairs nobody ever used together twice.
    const repetido1 = memory("el visor recorta el grafo a cuatrocientos nodos");
    const repetido2 = memory("el conectoma ilumina el mismo grafo");
    // Three pairs seen once each score the maximum too, so unweighted they add up to three
    // times the repeated pair. This is the shape production actually had.
    const centro = memory("el respaldo corre a las tres de la mañana");
    const suelto1 = memory("la imagen se publica en cada etiqueta");
    const suelto2 = memory("el visor pide la interfaz compilada");
    const suelto3 = memory("la consolidación mira lo que no se consolidó");

    for (let i = 0; i < 6; i++) turn(repetido1, repetido2);
    turn(centro, suelto1);
    turn(centro, suelto2);
    turn(centro, suelto3);

    const ranking = hubs(db);
    expect(ranking.find((x) => x.id === centro)!.degree).toBeGreaterThan(
      ranking.find((x) => x.id === repetido1)!.degree,
    );
    expect([repetido1, repetido2]).toContain(ranking[0]?.id);
  });

  it("cada hub lleva el mejor soporte que respalda su fuerza", () => {
    // NPMI reads 1 both for "always together" and for "once, and that was the only turn".
    // Without the support beside it, the figure cannot be told apart from a coincidence.
    const a = memory("el visor recorta el grafo a cuatrocientos nodos");
    const b = memory("el conectoma ilumina el mismo grafo");
    const suelto = memory("el respaldo corre a las tres de la mañana");

    for (let i = 0; i < 5; i++) turn(a, b);
    turn(a, suelto);

    const ranking = hubs(db);
    expect(ranking.find((x) => x.id === b)?.support).toBe(5);
    expect(ranking.find((x) => x.id === suelto)?.support).toBe(1);
    // `a` belongs to both pairs: its best evidence is the one it repeated.
    expect(ranking.find((x) => x.id === a)?.support).toBe(5);
  });
});

describe("semilla del contador de turnos", () => {
  /** A DB as the previous version left it: co_use and use_count written, no counter. */
  const beforeTheCounter = (): void => {
    db.prepare("DELETE FROM meta WHERE key = 'connectome.turns'").run();
  };

  it("arranca en el uso más alto registrado, que es la cota que los datos permiten", () => {
    const h = memory("hablamos en español y sin rodeos");
    const x = memory("el deploy usa docker compose");

    for (let i = 0; i < 5; i++) turn(h, x);
    for (let i = 0; i < 7; i++) turn(h);
    beforeTheCounter();

    seedTurnsFromUse(db);

    // Twelve turns used h, so there were at least twelve.
    expect(turnsRegistered(db)).toBe(12);
  });

  it("no pisa un contador que ya venía contando", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    for (let i = 0; i < 4; i++) turn(a, b);

    seedTurnsFromUse(db);

    expect(turnsRegistered(db)).toBe(4);
  });

  it("no inventa un contador donde nunca se midió uso", () => {
    memory("el deploy usa docker compose");

    seedTurnsFromUse(db);

    expect(turnsRegistered(db)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM meta").get()).toMatchObject({ n: 0 });
  });

  it("deja de leer como asociación máxima un par heredado", () => {
    // The rich-club pair: h is in every turn, so its association with x is exactly
    // what chance predicts. Without the seed, `n` counts turns the denominator
    // never saw and the edge reads 1 — the opposite of the right answer.
    const h = memory("hablamos en español y sin rodeos");
    const x = memory("el deploy usa docker compose");

    for (let i = 0; i < 3; i++) turn(h, x);
    for (let i = 0; i < 9; i++) turn(h);
    beforeTheCounter();
    turn(h, x);

    const sinSemilla = strengthOf(h, x);

    beforeTheCounter();
    seedTurnsFromUse(db);

    expect(sinSemilla).toBe(1);
    expect(strengthOf(h, x)).toBeCloseTo(0, 5);
  });

  it("sigue contando desde la semilla y no desde cero", () => {
    const a = memory("el deploy usa docker compose");
    const b = memory("el backup corre a las tres");

    for (let i = 0; i < 4; i++) turn(a, b);
    beforeTheCounter();
    seedTurnsFromUse(db);
    turn(a, b);

    expect(turnsRegistered(db)).toBe(5);
  });

  it("se siembra al abrir una base escrita por la versión anterior", () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-con-"));
    try {
      const path = join(dir, "mem.db");
      db = openDb(path);
      const h = memory("hablamos en español y sin rodeos");
      const x = memory("el deploy usa docker compose");
      for (let i = 0; i < 5; i++) turn(h, x);
      for (let i = 0; i < 7; i++) turn(h);
      beforeTheCounter();
      db.close();

      db = openDb(path);

      expect(turnsRegistered(db)).toBe(12);
      db.close();
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });
});
