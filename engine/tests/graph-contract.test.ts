import { describe, expect, it, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import { reinforce } from "../src/memory/reinforce.js";
import { graphData } from "../src/queries/graph.js";
import type { GraphData as GraphDataUi } from "../ui/src/api";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

/**
 * The viewer cannot import from `src/`, so the shape of the graph is declared twice. Nothing
 * tied the two: renaming `label` left typecheck and the suite green while the canvas broke.
 */
describe("contrato del grafo", () => {
  const armar = (gist: string): string => {
    const ep = capture(db, { scope: "t", body: `origen de ${gist}` });
    return consolidate(db, { scope: "t", gist, source_episode_ids: [ep.id] }).memory_id;
  };

  it("lo que devuelve el motor encaja en el tipo que declara la interfaz", () => {
    const a = armar("la primera memoria");
    const b = armar("la segunda memoria");
    crystallize(db, { scope: "t", name: "un rasgo", evidence_memory_ids: [a] });
    reinforce(db, { memory_ids: [a, b] });
    reinforce(db, { memory_ids: [a, b] });

    const body = graphData(db, {
      scope: null,
      withEpisodes: true,
      withRelated: true,
      withCoUse: true,
      at: Date.now(),
    });

    // Assignment is the assertion: if the engine renames a field or changes its type, this
    // stops compiling and `pnpm typecheck` fails before anyone opens the viewer.
    const comoLaVeLaInterfaz: GraphDataUi = body;
    expect(comoLaVeLaInterfaz.nodes.length).toBeGreaterThan(0);
  });

  it("los tres campos que la pantalla dibuja viajan poblados", () => {
    // label, scope and salience are what paint.ts and filterGraph read, and until now no test
    // looked at any of them: the ones everyone draws were the ones nobody checked.
    const a = armar("la primera memoria");
    reinforce(db, { memory_ids: [a] });

    const body = graphData(db, {
      scope: null,
      withEpisodes: false,
      withRelated: false,
      withCoUse: false,
      at: Date.now(),
    });
    const memoria = body.nodes.find((n) => n.layer === "memory");

    expect(memoria?.label).toBe("la primera memoria");
    expect(memoria?.scope).toBe("t");
    expect(typeof memoria?.salience).toBe("number");
  });

  it("un nodo del conectoma lleva grado, fuerza y soporte", () => {
    const a = armar("la primera memoria");
    const b = armar("la segunda memoria");
    for (let i = 0; i < 3; i++) reinforce(db, { memory_ids: [a, b] });

    const body = graphData(db, {
      scope: null,
      withEpisodes: false,
      withRelated: false,
      withCoUse: true,
      at: Date.now(),
    });

    expect(body.nodes.find((n) => n.id === a)?.co_use).toEqual({
      degree: expect.any(Number),
      strength: expect.any(Number),
      support: 3,
    });
  });
});
