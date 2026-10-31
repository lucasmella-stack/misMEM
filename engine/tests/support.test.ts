import { describe, expect, it } from "vitest";
import { supportConfidence } from "../src/domain/support.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { reinforce } from "../src/memory/reinforce.js";
import { coUseLinks } from "../src/queries/relations.js";
import { openDb } from "../src/store/db.js";
import { hubs } from "../src/store/connectome.js";
import {
  accumulateCoUse,
  supportConfidence as supportConfidenceUi,
} from "../ui/src/lib/graph";

describe("confianza por soporte", () => {
  it("un par visto una sola vez no repite nada y no vale nada", () => {
    expect(supportConfidence(1)).toBe(0);
    expect(supportConfidence(0)).toBe(0);
    expect(supportConfidence(undefined)).toBe(0);
  });

  it("crece con las repeticiones y nunca llega a la certeza", () => {
    expect(supportConfidence(2)).toBeCloseTo(0.5, 10);
    expect(supportConfidence(4)).toBeCloseTo(0.75, 10);
    expect(supportConfidence(1_000_000)).toBeLessThan(1);
  });

  it("el motor y la interfaz pesan el soporte igual", () => {
    // The viewer cannot import from src/, so the rule lives twice. If the two ever disagree,
    // the canvas dims an edge the ranking still trusts, and nothing else would notice.
    for (const n of [undefined, 0, 1, 2, 3, 7, 23, 1000]) {
      expect(supportConfidenceUi(n)).toBe(supportConfidence(n));
    }
  });
});

describe("acumulador del conectoma", () => {
  it("la interfaz acumula igual que el motor sobre las mismas aristas", () => {
    // The canvas redraws a filtered subset the server never saw, so it has to accumulate on
    // its own. If the two rules drift, the halo trusts an edge the ranking already dismissed.
    const db = openDb(":memory:");
    const memoria = (gist: string): string => {
      const ep = capture(db, { scope: "t", body: `origen de ${gist}` });
      return consolidate(db, { scope: "t", gist, source_episode_ids: [ep.id] }).memory_id;
    };
    // Disjoint pairs on purpose: a memory present in every turn scores negative NPMI, and the
    // weighting lives behind `strength > 0`, so a shared node would leave it unexercised.
    const a = memoria("el visor recorta el grafo");
    const b = memoria("el conectoma ilumina el grafo");
    const c = memoria("el respaldo corre de madrugada");
    const d = memoria("la imagen se publica en cada etiqueta");

    for (let i = 0; i < 5; i++) reinforce(db, { memory_ids: [a, b] });
    reinforce(db, { memory_ids: [c, d] });

    const delMotor = new Map(hubs(db).map((h) => [h.id, h]));
    expect([...delMotor.values()].some((h) => h.strength > 0)).toBe(true);
    const deLaUi = accumulateCoUse(coUseLinks(db, [a, b, c, d], 1));

    expect([...deLaUi.keys()].sort()).toEqual([...delMotor.keys()].sort());
    for (const [id, propio] of deLaUi) {
      expect(propio.degree).toBe(delMotor.get(id)!.degree);
      expect(propio.support).toBe(delMotor.get(id)!.support);
      expect(propio.strength).toBeCloseTo(delMotor.get(id)!.strength, 10);
    }
  });
});
