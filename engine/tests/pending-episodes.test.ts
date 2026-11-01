import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { dispatchEngramTool } from "../src/mcp/engram-compat.js";
import { capture } from "../src/memory/capture.js";
import { consolidate } from "../src/memory/consolidate.js";
import { countPendingEpisodes, pendingEpisodes } from "../src/memory/pending.js";
import { handleRecent } from "../src/http/viewer/read.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("pending episodes: one query behind the viewer and mem_context", () => {
  it("both agree on membership and order, including episodes in the same millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    for (const body of ["one", "two", "three"]) capture(db, { scope: "a", body });
    const done = capture(db, { scope: "a", body: "done" });
    consolidate(db, { scope: "a", gist: "g", source_episode_ids: [done.id] });
    capture(db, { scope: "b", body: "other scope" });
    vi.restoreAllMocks();

    let viewerBody = "";
    const res = { statusCode: 200, setHeader() {}, end(p?: string) { viewerBody = p ?? ""; } };
    handleRecent(db, res as unknown as ServerResponse, new URL("http://x/api/recent?layer=episode&pending=1&scope=a"));
    const viewer = (JSON.parse(viewerBody) as { rows: Array<{ id: string }>; total: number });

    const compat = (await dispatchEngramTool(db, "mem_context", { scope: "a", limit: 50 })) as { hits: Array<{ id: string; layer: string }> };

    expect(compat.hits.map((h) => h.id)).toEqual(viewer.rows.map((r) => r.id));
    expect(viewer.total).toBe(3);
    expect(compat.hits.every((h) => h.layer === "episode")).toBe(true);
  });

  it("keeps the mem_context payload shape (no consolidated_into) and its own limit clamp", async () => {
    for (let i = 0; i < 3; i++) capture(db, { scope: "a", body: `e${i}` });
    const out = (await dispatchEngramTool(db, "mem_context", { limit: 1000 })) as { hits: Array<Record<string, unknown>> };
    expect(Object.keys(out.hits[0]!)).toEqual(["id", "scope", "text", "created_at", "layer"]);
    expect((await dispatchEngramTool(db, "mem_context", { limit: 0 }))).toMatchObject({ hits: expect.any(Array) });
    expect(((await dispatchEngramTool(db, "mem_context", { limit: -5 })) as { hits: unknown[] }).hits).toHaveLength(1);
  });

  it("count ignores limit and offset; the page honours them", async () => {
    for (let i = 0; i < 5; i++) capture(db, { scope: "a", body: `e${i}` });
    expect(countPendingEpisodes(db, "a")).toBe(5);
    expect(countPendingEpisodes(db, null)).toBe(5);
    expect(pendingEpisodes(db, "a", 2, 4)).toHaveLength(1);
    expect(pendingEpisodes(db, null, 2)).toHaveLength(2);
  });
});
