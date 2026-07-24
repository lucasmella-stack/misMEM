import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import { capture } from "../src/tools.js";
import {
  handleStats,
  handleRecent,
  handleSearch,
  handleViewerHtml,
} from "../src/viewer.js";

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
  it("returns FTS hits", () => {
    capture(db, { scope: "x", body: "alpha beta gamma" });
    const res = mockRes();
    handleSearch(
      db,
      res as unknown as import("node:http").ServerResponse,
      urlFor("/api/search?q=alpha"),
    );
    const j = JSON.parse(res.body);
    expect(j.hits.length).toBe(1);
  });

  it("rejects empty query", () => {
    const res = mockRes();
    handleSearch(
      db,
      res as unknown as import("node:http").ServerResponse,
      urlFor("/api/search?q=%20"),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("viewer: /viewer HTML", () => {
  it("serves HTML with security headers", () => {
    const res = mockRes();
    handleViewerHtml(res as unknown as import("node:http").ServerResponse);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(res.body).toContain("<title>misMEM viewer</title>");
  });
});
