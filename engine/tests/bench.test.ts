import { beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { embedPendingMemories } from "../src/embeddings/store.js";
import type { EmbedFn } from "../src/embeddings/provider.js";
import { meanRank, mrr, parseBank, recallAt, runBench } from "../src/recall/bench.js";

let db: DB;

function fakeVec(text: string): Float32Array {
  const vec = new Float32Array(2);
  if (/deuda|plata|finanzas/.test(text.toLowerCase())) vec[0] = 1;
  if (/docker|deploy|servidor/.test(text.toLowerCase())) vec[1] = 1;
  return vec;
}

const fakeEmbed: EmbedFn = async (texts) => texts.map(fakeVec);

function makeMemory(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  return consolidate(db, { scope: "test", gist, source_episode_ids: [episode.id] }).memory_id;
}

beforeEach(async () => {
  db = openDb(":memory:");
});

describe("parseBank", () => {
  it("toma como variante toda clave de texto que no sea el id ni un grupo", () => {
    const bank = parseBank(
      '{"id":"m1","lang":"en","parafrasis":"a","literal":"b"}\n\n{"id":"m2","lang":"es","parafrasis":"c","literal":"d"}\n',
      ["lang"],
    );
    expect(bank.variants).toEqual(["parafrasis", "literal"]);
    expect(bank.entries).toHaveLength(2);
    expect(bank.entries[0]).toEqual({ id: "m1", groups: { lang: "en" }, queries: { parafrasis: "a", literal: "b" } });
  });

  it("rechaza una línea sin id en vez de saltearla", () => {
    expect(() => parseBank('{"parafrasis":"a"}', [])).toThrow(/línea 1/);
  });
});

describe("runBench", () => {
  it("cuenta acierto sólo cuando la memoria esperada está entre las devueltas", async () => {
    const debts = makeMemory("Tiene deudas con el banco");
    const deploy = makeMemory("El deploy usa docker compose");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    const bank = parseBank(
      [
        JSON.stringify({ id: debts, lang: "es", parafrasis: "problemas de plata" }),
        JSON.stringify({ id: deploy, lang: "en", parafrasis: "problemas de plata" }),
      ].join("\n"),
      ["lang"],
    );
    const report = await runBench(db, bank, { limit: 1, embedFn: fakeEmbed });

    expect(report.variants.parafrasis?.all).toEqual({
      found: 1, total: 2, reciprocalSum: 1, rankSum: 1, ranks: [1],
    });
    expect(report.variants.parafrasis?.groups["lang=es"]).toEqual({
      found: 1, total: 1, reciprocalSum: 1, rankSum: 1, ranks: [1],
    });
    expect(report.variants.parafrasis?.groups["lang=en"]).toEqual({
      found: 0, total: 1, reciprocalSum: 0, rankSum: 0, ranks: [0],
    });
  });

  it("informa cuántas preguntas ajenas trajeron algo", async () => {
    makeMemory("Tiene deudas con el banco");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    const bank = parseBank("", []);

    const report = await runBench(db, bank, {
      limit: 5,
      embedFn: fakeEmbed,
      offTopic: ["receta de chimichurri", "problemas de plata"],
    });

    expect(report.offTopic).toEqual({ withHits: 1, total: 2, hitsSum: 1 });
  });

  it("registra en qué posición vino el acierto, no sólo que vino", async () => {
    const primero = makeMemory("Tiene deudas con el banco");
    const segundo = makeMemory("La deuda del alquiler sigue sin pagarse");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    // Equal similarity leaves it to salience, so the order is fixed.
    db.prepare("UPDATE memories SET salience = 0.9 WHERE id = ?").run(primero);
    db.prepare("UPDATE memories SET salience = 0.2 WHERE id = ?").run(segundo);

    const bank = parseBank(JSON.stringify({ id: segundo, q: "problemas de plata" }), []);
    const report = await runBench(db, bank, { limit: 5, embedFn: fakeEmbed });
    const score = report.variants.q!.all;

    expect(score.found).toBe(1);
    expect(score.ranks).toEqual([0, 1, 0, 0, 0]);
    // A client that shows one hit misses it even if recall at the cap says otherwise.
    expect(recallAt(score, 1)).toBe(0);
    expect(recallAt(score, 3)).toBe(1);
    expect(mrr(score)).toBeCloseTo(0.5);
    expect(meanRank(score)).toBe(2);
  });

  it("cuenta cuántos recuerdos paga el modelo por pregunta", async () => {
    makeMemory("Tiene deudas con el banco");
    makeMemory("La deuda del alquiler sigue sin pagarse");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    const bank = parseBank(JSON.stringify({ id: "no-existe", q: "problemas de plata" }), []);
    const report = await runBench(db, bank, { limit: 5, embedFn: fakeEmbed });

    expect(report.returned).toEqual({ hitsSum: 2, questions: 1 });
  });

  it("sin aciertos, la posición media no finge un número", async () => {
    makeMemory("Tiene deudas con el banco");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });

    const bank = parseBank(JSON.stringify({ id: "no-existe", q: "problemas de plata" }), []);
    const report = await runBench(db, bank, { limit: 5, embedFn: fakeEmbed });
    const score = report.variants.q!.all;

    expect(score.found).toBe(0);
    expect(mrr(score)).toBe(0);
    expect(meanRank(score)).toBeNaN();
  });

  it("ningún marcador de ruido llega al tope, y lo real sigue llegando", async () => {
    const real = makeMemory("los episodios sin señal de este deploy fueron tres");
    const source = capture(db, { scope: "test", body: "source marcador" });
    const marker = consolidate(db, {
      scope: "test",
      gist: "[noise] 3 episodios sin señal consolidable",
      source_episode_ids: [source.id],
    }).memory_id;
    db.prepare("UPDATE memories SET salience = 0.05 WHERE id = ?").run(marker);

    const bank = parseBank(JSON.stringify({ id: real, q: "episodios sin señal" }), []);
    const report = await runBench(db, bank, { limit: 5, embedFn: fakeEmbed });

    expect(report.noiseHits).toBe(0);
    expect(report.variants.q!.all.found).toBe(1);
  });

  it("no refuerza: medir no cambia la saliencia de lo que encuentra", async () => {
    const debts = makeMemory("Tiene deudas con el banco");
    await embedPendingMemories(db, { embedFn: fakeEmbed, model: "fake" });
    const before = db.prepare("SELECT salience, last_accessed_at FROM memories WHERE id = ?").get(debts);

    await runBench(db, parseBank(JSON.stringify({ id: debts, q: "problemas de plata" }), []), {
      limit: 5,
      embedFn: fakeEmbed,
    });

    expect(db.prepare("SELECT salience, last_accessed_at FROM memories WHERE id = ?").get(debts)).toEqual(before);
  });
});
