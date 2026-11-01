import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { crystallize } from "../src/memory/crystallize.js";
import {
  handleStats,
  handleRecent,
  handleSearch,
} from "../src/http/viewer/read.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(payload?: string): void;
}

function mockRes(): MockResponse {
  const r: MockResponse = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload ?? "";
    },
  };
  return r;
}

function urlFor(path: string): URL {
  return new URL(`http://x${path}`);
}

describe("viewer: /api/stats", () => {
  it("returns counts for empty db", () => {
    const res = mockRes();
    handleStats(db, res as unknown as import("node:http").ServerResponse);
    expect(res.statusCode).toBe(200);
    const j = JSON.parse(res.body);
    expect(j.counts).toEqual({
      episodes: 0,
      memories: 0,
      traits: 0,
      consolidated: 0,
    });
    expect(j.last).toBeNull();
  });

  it("counts episodes and reports top scopes", () => {
    capture(db, { scope: "a", body: "uno" });
    capture(db, { scope: "a", body: "dos" });
    capture(db, { scope: "b", body: "tres" });
    const res = mockRes();
    handleStats(db, res as unknown as import("node:http").ServerResponse);
    const j = JSON.parse(res.body);
    expect(j.counts.episodes).toBe(3);
    expect(j.topScopes[0]).toEqual({ scope: "a", n: 2 });
    expect(j.last.scope).toBe("b");
  });
});

describe("viewer: /api/recent", () => {
  it("returns latest episodes with stable order", () => {
    capture(db, { scope: "a", body: "first" });
    capture(db, { scope: "a", body: "second" });
    capture(db, { scope: "a", body: "third" });
    const res = mockRes();
    handleRecent(
      db,
      res as unknown as import("node:http").ServerResponse,
      urlFor("/api/recent?layer=episode&limit=2"),
    );
    const j = JSON.parse(res.body);
    expect(j.rows).toHaveLength(2);
    expect(j.rows[0].text).toBe("third");
  });

  it("filters episodes by scope", () => {
    capture(db, { scope: "a", body: "alpha" });
    capture(db, { scope: "b", body: "beta" });
    const res = mockRes();
    handleRecent(
      db,
      res as unknown as import("node:http").ServerResponse,
      urlFor("/api/recent?layer=episode&scope=b"),
    );
    const j = JSON.parse(res.body);
    expect(j.rows).toHaveLength(1);
    expect(j.rows[0].text).toBe("beta");
  });

  it("recent con pending=1 sólo trae pendientes, pagina y da total", () => {
    capture(db, { scope: "a", body: "pendiente viejo" });
    capture(db, { scope: "a", body: "pendiente medio" });
    const done1 = capture(db, { scope: "a", body: "consolidado uno" });
    const done2 = capture(db, { scope: "a", body: "consolidado dos" });
    capture(db, { scope: "a", body: "pendiente nuevo" });
    consolidate(db, {
      scope: "a",
      gist: "una memoria",
      source_episode_ids: [done1.id, done2.id],
    });

    const read = (query: string) => {
      const res = mockRes();
      handleRecent(db, res as unknown as import("node:http").ServerResponse, urlFor(`/api/recent?${query}`));
      return JSON.parse(res.body);
    };

    // The total is the scope's pending count, not the page's row count.
    const page1 = read("layer=episode&scope=a&pending=1&limit=2&offset=0");
    expect(page1.rows.map((r: { text: string }) => r.text)).toEqual(["pendiente nuevo", "pendiente medio"]);
    expect(page1.total).toBe(3);
    expect(page1.rows.every((r: { consolidated_into: string | null }) => r.consolidated_into === null)).toBe(true);

    const page2 = read("layer=episode&scope=a&pending=1&limit=2&offset=2");
    expect(page2.rows.map((r: { text: string }) => r.text)).toEqual(["pendiente viejo"]);
    expect(page2.total).toBe(3);

    // An invalid offset does not break the page: it counts as 0.
    const badOffset = read("layer=episode&scope=a&pending=1&limit=2&offset=-4");
    expect(badOffset.rows.map((r: { text: string }) => r.text)).toEqual(["pendiente nuevo", "pendiente medio"]);

    // Without pending=1 the response stays as before, with no total.
    const plain = read("layer=episode&scope=a&limit=2");
    expect("total" in plain).toBe(false);
    expect(plain.rows).toHaveLength(2);
  });

  it("recent con layer=trait pagina y devuelve el total del ámbito", () => {
    crystallize(db, { scope: "a", name: "uno", evidence_memory_ids: ["mem_uno"] });
    crystallize(db, { scope: "a", name: "dos", evidence_memory_ids: ["mem_dos"] });
    crystallize(db, { scope: "a", name: "tres", evidence_memory_ids: ["mem_tres"] });
    crystallize(db, { scope: "b", name: "ajeno", evidence_memory_ids: ["mem_ajeno"] });

    const read = (query: string) => {
      const res = mockRes();
      handleRecent(db, res as unknown as import("node:http").ServerResponse, urlFor(`/api/recent?${query}`));
      return JSON.parse(res.body);
    };

    const page1 = read("layer=trait&scope=a&limit=2&offset=0");
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(3);

    const page2 = read("layer=trait&scope=a&limit=2&offset=2");
    expect(page2.rows).toHaveLength(1);
    expect(page2.total).toBe(3);

    // Both pages together bring the three traits of the scope, without the foreign one.
    const names = [...page1.rows, ...page2.rows].map((row: { text: string }) => row.text);
    expect(new Set(names).size).toBe(3);
    expect(names).not.toContain("ajeno");

    // Without a scope the default view counts every trait and still paginates.
    const all = read("layer=trait&limit=2&offset=0");
    expect(all.rows).toHaveLength(2);
    expect(all.total).toBe(4);
  });

  it("con fuerza y fecha empatadas desempata por id para que las páginas no se pisen", () => {
    // Fixed ids inserted out of order: without the id tie-break SQLite would return insertion order,
    // so the test fails every time instead of one run in six with random ulids.
    const ids = ["t3", "t1", "t5", "t2", "t6", "t4"];
    const insert = db.prepare(
      "INSERT INTO traits (id, scope, name, evidence_memory_ids, created_at, updated_at) VALUES (?, 'a', ?, '[]', 1, 1)",
    );
    for (const id of ids) insert.run(id, `rasgo ${id}`);

    const read = (query: string) => {
      const res = mockRes();
      handleRecent(db, res as unknown as import("node:http").ServerResponse, urlFor(`/api/recent?${query}`));
      return JSON.parse(res.body);
    };

    const rows = [
      ...read("layer=trait&scope=a&limit=2&offset=0").rows,
      ...read("layer=trait&scope=a&limit=2&offset=2").rows,
      ...read("layer=trait&scope=a&limit=2&offset=4").rows,
    ];
    expect(rows.map((row: { id: string }) => row.id)).toEqual([...ids].sort().reverse());
  });

  it("rejects invalid layer", () => {
    const res = mockRes();
    handleRecent(
      db,
      res as unknown as import("node:http").ServerResponse,
      urlFor("/api/recent?layer=bogus"),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("viewer: /api/search", () => {
  it("returns FTS hits", async () => {
    capture(db, { scope: "x", body: "alpha beta gamma" });
    const res = mockRes();
    await handleSearch(
      db,
      res as unknown as import("node:http").ServerResponse,
      urlFor("/api/search?q=alpha"),
    );
    const j = JSON.parse(res.body);
    expect(j.hits.length).toBe(1);
  });

  it("marca el corte cuando hay más coincidencias que el tope y no cuando no lo hay", async () => {
    capture(db, { scope: "x", body: "alpha uno" });
    capture(db, { scope: "x", body: "alpha dos" });
    capture(db, { scope: "x", body: "alpha tres" });

    const read = async (query: string) => {
      const res = mockRes();
      await handleSearch(
        db,
        res as unknown as import("node:http").ServerResponse,
        urlFor(`/api/search?${query}`),
      );
      return JSON.parse(res.body);
    };

    // Exactly the cap also reads as cut: the flag says the page filled, not that more exist
    // (deciding that would mean recounting the fused recall on every search).
    const full = await read("q=alpha&limit=3");
    expect(full.hits).toHaveLength(3);
    expect(full.truncated).toBe(true);

    const cut = await read("q=alpha&limit=2");
    expect(cut.hits).toHaveLength(2);
    expect(cut.limit).toBe(2);
    expect(cut.truncated).toBe(true);

    const whole = await read("q=alpha&limit=10");
    expect(whole.hits).toHaveLength(3);
    expect(whole.limit).toBe(10);
    expect(whole.truncated).toBe(false);
  });

  it("rejects empty query", async () => {
    const res = mockRes();
    await handleSearch(
      db,
      res as unknown as import("node:http").ServerResponse,
      urlFor("/api/search?q=%20"),
    );
    expect(res.statusCode).toBe(400);
  });
});
