import { beforeEach, describe, expect, it } from "vitest";
import type { Database as DB } from "better-sqlite3";
import type { ServerResponse } from "node:http";
import { openDb } from "../src/db.js";
import { capture, consolidate, recallHybrid } from "../src/tools.js";
import {
  embedPendingMemories,
  type EmbedFn,
} from "../src/embeddings/index.js";
import { dispatchEngramTool } from "../src/engram-compat.js";
import { handleSearch } from "../src/viewer.js";

let db: DB;

function fakeVec(text: string): Float32Array {
  const vec = new Float32Array(2);
  if (/deuda|cashflow|finanzas/.test(text.toLowerCase())) vec[0] = 1;
  if (/docker|deploy/.test(text.toLowerCase())) vec[1] = 1;
  return vec;
}

const fakeEmbed: EmbedFn = async (texts) => texts.map(fakeVec);

function makeMemory(gist: string): string {
  const episode = capture(db, { scope: "test", body: `source ${gist}` });
  return consolidate(db, {
    scope: "test",
    gist,
    source_episode_ids: [episode.id],
  }).memory_id;
}

function mockResponse(): {
  response: ServerResponse;
  value: { statusCode: number; body: string };
} {
  const value = {
    statusCode: 200,
    body: "",
    setHeader() {},
    end(payload?: string) {
      this.body = payload ?? "";
    },
  };
  return { response: value as unknown as ServerResponse, value };
}

beforeEach(() => {
  db = openDb(":memory:");
});

describe("ranking híbrido", () => {
  it("ejecuta semántica aunque FTS llene el límite", async () => {
    makeMemory("deudas literal uno");
    makeMemory("deudas literal dos");
    makeMemory("cashflow apretado");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    let calls = 0;
    const counted: EmbedFn = async (texts) => {
      calls++;
      return fakeEmbed(texts);
    };

    const result = await recallHybrid(
      db,
      { query: "deudas", limit: 2 },
      counted,
      { reinforce: false, embeddingModel: "fake" },
    );

    expect(calls).toBe(1);
    expect(result.hits).toHaveLength(2);
  });

  it("un match semántico fuerte puede desplazar a uno léxico débil", async () => {
    const weak = makeMemory("deudas mencionadas de pasada");
    const strong = makeMemory("cashflow apretado");
    db.prepare("UPDATE memories SET salience = 0.01 WHERE id = ?").run(weak);
    db.prepare("UPDATE memories SET salience = 1 WHERE id = ?").run(strong);
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });

    const result = await recallHybrid(
      db,
      { query: "deudas", limit: 1 },
      fakeEmbed,
      { reinforce: false, embeddingModel: "fake" },
    );
    expect(result.hits[0]?.id).toBe(strong);
  });

  it("mantiene la propiedad de prefijo entre límites", async () => {
    for (const gist of [
      "deudas uno",
      "deudas dos",
      "cashflow tres",
      "finanzas cuatro",
    ]) {
      makeMemory(gist);
    }
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    const small = await recallHybrid(
      db,
      { query: "deudas", limit: 2 },
      fakeEmbed,
      { reinforce: false, embeddingModel: "fake" },
    );
    const large = await recallHybrid(
      db,
      { query: "deudas", limit: 4 },
      fakeEmbed,
      { reinforce: false, embeddingModel: "fake" },
    );
    expect(small.hits.map((hit) => hit.id)).toEqual(
      large.hits.slice(0, 2).map((hit) => hit.id),
    );
  });
});

describe("superficies consistentes", () => {
  it("viewer y Engram usan el mismo ranking que recall", async () => {
    makeMemory("cashflow apretado");
    await embedPendingMemories(db, {
      embedFn: fakeEmbed,
      model: "fake",
    });
    const canonical = await recallHybrid(
      db,
      { query: "finanzas", limit: 10 },
      fakeEmbed,
      { reinforce: false, embeddingModel: "fake" },
    );

    const { response, value } = mockResponse();
    await handleSearch(
      db,
      response,
      new URL("http://x/api/search?q=finanzas&limit=10"),
      fakeEmbed,
      "fake",
    );
    const viewer = JSON.parse(value.body) as { hits: Array<{ id: string }> };

    const engram = (await dispatchEngramTool(
      db,
      "mem_search",
      { query: "finanzas", limit: 10 },
      { embedFn: fakeEmbed, embeddingModel: "fake" },
    )) as { hits: Array<{ id: string }> };

    expect(viewer.hits.map((hit) => hit.id)).toEqual(
      canonical.hits.map((hit) => hit.id),
    );
    expect(engram.hits.map((hit) => hit.id)).toEqual(
      canonical.hits.map((hit) => hit.id),
    );
  });

  it("el viewer no refuerza salience", async () => {
    const memoryId = makeMemory("deudas del mes");
    db.prepare("UPDATE memories SET salience = 0.5 WHERE id = ?").run(memoryId);
    const { response } = mockResponse();
    await handleSearch(
      db,
      response,
      new URL("http://x/api/search?q=deudas"),
      fakeEmbed,
      "fake",
    );
    const row = db
      .prepare("SELECT salience FROM memories WHERE id = ?")
      .get(memoryId) as { salience: number };
    expect(row.salience).toBeCloseTo(0.5);
  });
});
