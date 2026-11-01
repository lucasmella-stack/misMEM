import { describe, it, expect, beforeEach } from "vitest";
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { handleRecent, parseOffset } from "../src/http/viewer/read.js";
import { handleMemories } from "../src/http/viewer/api.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
  // Three pending episodes for /api/recent and three memories for /api/memories.
  for (const n of ["p1", "p2", "p3"]) capture(db, { scope: "a", body: `pending ${n}` });
  for (const n of ["m1", "m2", "m3"]) {
    const ep = capture(db, { scope: "a", body: `source ${n}` });
    consolidate(db, { scope: "a", gist: `memory ${n}`, source_episode_ids: [ep.id] });
  }
});

function read<T>(fn: (res: ServerResponse) => void): T {
  let body = "";
  const res = { statusCode: 200, setHeader() {}, end(p?: string) { body = p ?? ""; } };
  fn(res as unknown as ServerResponse);
  return JSON.parse(body) as T;
}

const recentRows = (offset: string): number =>
  read<{ rows: unknown[] }>((res) =>
    handleRecent(db, res, new URL(`http://x/api/recent?layer=episode&pending=1&limit=2&offset=${offset}`)),
  ).rows.length;
const memoryIds = (offset: string): string[] =>
  read<{ memories: Array<{ id: string }> }>((res) =>
    handleMemories(db, res, new URL(`http://x/api/memories?limit=2&offset=${offset}`)),
  ).memories.map((m) => m.id);

describe("parseOffset", () => {
  it.each([
    ["Infinity", 0],
    ["-Infinity", 0],
    ["-4", 0],
    ["abc", 0],
    ["", 0],
    ["NaN", 0],
    ["2.9", 2],
    ["0.5", 0],
    ["3", 3],
    ["1e20", Number.MAX_SAFE_INTEGER],
  ])("%j -> %i", (raw, expected) => {
    expect(parseOffset(raw)).toBe(expected);
  });

  it("treats a missing parameter as 0", () => {
    expect(parseOffset(null)).toBe(0);
  });
});

describe("?offset= is parsed the same by /api/recent and /api/memories", () => {
  it.each(["Infinity", "-Infinity", "-4", "abc", "NaN", ""])("%j returns the first page on both", (raw) => {
    const first = memoryIds("0");
    expect(first).toHaveLength(2);
    expect(memoryIds(raw)).toEqual(first);
    expect(recentRows(raw)).toBe(2);
  });

  it("a huge offset (1e20) is an empty page on both, not an error", () => {
    expect(memoryIds("1e20")).toEqual([]);
    expect(recentRows("1e20")).toBe(0);
  });

  it("floors a fractional offset on both", () => {
    expect(memoryIds("1.9")).toEqual(memoryIds("1"));
    expect(memoryIds("1")).not.toEqual(memoryIds("0"));
    expect(recentRows("2.9")).toBe(recentRows("2"));
    expect(recentRows("2")).toBe(1);
  });
});
