import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
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
