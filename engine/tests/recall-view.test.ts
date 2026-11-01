import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import {
  MAX_DETAILS_CHARS,
  MAX_TEXT_CHARS,
  recallForModel,
  recallMissForModel,
  type RecallHitView,
} from "../src/queries/recall-view.js";
import type { RecallHit } from "../src/schema.js";

// Fixed clock near midnight UTC: a local-time formatter would report the next day in
// UTC+1 or further east, so this instant pins the date to UTC rather than to the host zone.
const AT = Date.UTC(2026, 9, 30, 23, 30);

function insertMemory(
  db: DB,
  memory: {
    id: string;
    gist: string;
    details?: string | null;
    salience?: number;
    scope?: string;
  },
): void {
  db.prepare(
    `INSERT INTO memories (id, scope, gist, details, source_episode_ids, salience, created_at)
     VALUES (?, ?, ?, ?, '[]', ?, ?)`,
  ).run(memory.id, memory.scope ?? "p/a", memory.gist, memory.details ?? null, memory.salience ?? 1, AT);
}

function insertTrait(db: DB, id: string, name: string, polarity: string, scope = "p/a"): void {
  db.prepare(
    `INSERT INTO traits (id, scope, name, evidence_memory_ids, polarity, created_at, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?, ?)`,
  ).run(id, scope, name, polarity, AT, AT);
}

function insertEpisode(
  db: DB,
  episode: { id: string; body: string; scope?: string; consolidatedInto?: string },
): void {
  db.prepare(
    `INSERT INTO episodes (id, scope, body, created_at, consolidated_into) VALUES (?, ?, ?, ?, ?)`,
  ).run(episode.id, episode.scope ?? "p/a", episode.body, AT, episode.consolidatedInto ?? null);
}

const hit = (partial: Partial<RecallHit> & Pick<RecallHit, "layer" | "id">): RecallHit => ({
  scope: "p/a",
  text: "text",
  created_at: AT,
  ...partial,
});

// A lone surrogate means a cut fell in the middle of an emoji's UTF-16 pair.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("topes publicados", () => {
  it("son los 2.000 y 1.200 puntos de código que documentan docs/recall.md y el CHANGELOG", () => {
    expect(MAX_TEXT_CHARS).toBe(2000);
    expect(MAX_DETAILS_CHARS).toBe(1200);
  });
});

describe("recallForModel", () => {
  describe("in a host zone far from UTC", () => {
    const hostTz = process.env.TZ;
    // A host in UTC would pass the date test even with a local-time formatter, so it runs 14
    // hours ahead, where the fixed clock below falls on the next day.
    beforeEach(() => {
      process.env.TZ = "Pacific/Kiritimati";
    });
    afterEach(() => {
      if (hostTz === undefined) delete process.env.TZ;
      else process.env.TZ = hostTz;
    });

    it("adds a UTC date, keeps created_at, via and the order of the hits", () => {
      const db = openDb(":memory:");
      insertMemory(db, { id: "m1", gist: "gist", salience: 0.834 });
      insertTrait(db, "t1", "prefers small PRs", "shadow");
      insertEpisode(db, { id: "e1", body: "raw note" });

      const hits: RecallHitView[] = recallForModel(db, [
        hit({ layer: "memory", id: "m1", salience: 0.834, via: "semantic" }),
        hit({ layer: "trait", id: "t1", text: "prefers small PRs" }),
        hit({ layer: "episode", id: "e1", text: "raw note" }),
      ]);

      expect(hits.map((h) => h.id)).toEqual(["m1", "t1", "e1"]);
      for (const h of hits) {
        expect(h.date).toBe("2026-10-30");
        expect(h.created_at).toBe(AT);
      }
      expect(hits[0]?.salience).toBe(0.834);
      expect(hits[0]?.via).toBe("semantic");
      expect(hits[1]?.salience).toBeUndefined();
      expect(hits[2]?.salience).toBeUndefined();
      db.close();
    });
  });

  it("omits date when created_at is not a usable epoch, without failing the whole recall", () => {
    const db = openDb(":memory:");
    const hits = recallForModel(db, [
      // Not finite: what a corrupted row holds, and there is no date to report for it.
      hit({ layer: "episode", id: "nan", created_at: Number.NaN }),
      // Finite but out of Date's range, so toISOString would throw RangeError.
      hit({ layer: "episode", id: "huge", created_at: Number.MAX_VALUE }),
      // Inside Date's range but past year 9999 (an epoch in microseconds): not YYYY-MM-DD.
      hit({ layer: "episode", id: "micros", created_at: 1e15 }),
    ]);

    for (const view of hits) expect(view).not.toHaveProperty("date");
    expect(hits[0]?.created_at).toBeNaN();
    expect(hits[1]?.created_at).toBe(Number.MAX_VALUE);
    expect(hits[0]?.text).toBe("text");
    db.close();
  });

  it("reads the details of every memory in one batch query and omits empty ones", () => {
    const db = openDb(":memory:");
    insertMemory(db, { id: "m1", gist: "one", details: "Run the migration before the deploy" });
    insertMemory(db, { id: "m2", gist: "two", details: null });
    insertMemory(db, { id: "m3", gist: "three", details: "" });

    const prepare = vi.spyOn(db, "prepare");
    const hits = recallForModel(db, [
      hit({ layer: "memory", id: "m1" }),
      hit({ layer: "memory", id: "m2" }),
      hit({ layer: "memory", id: "m3" }),
    ]);

    expect(hits[0]?.details).toBe("Run the migration before the deploy");
    expect(hits[1]).not.toHaveProperty("details");
    expect(hits[2]).not.toHaveProperty("details");
    const memoryQueries = prepare.mock.calls.filter(([sql]) => sql.includes("FROM memories"));
    expect(memoryQueries).toHaveLength(1);
    db.close();
  });

  it("keeps a text and details of exactly the cap whole, without truncated", () => {
    const db = openDb(":memory:");
    insertMemory(db, { id: "m1", gist: "gist", details: "d".repeat(MAX_DETAILS_CHARS) });
    const [view] = recallForModel(db, [hit({ layer: "memory", id: "m1", text: "t".repeat(MAX_TEXT_CHARS) })]);

    expect(view?.text).toBe("t".repeat(MAX_TEXT_CHARS));
    expect(view?.details).toBe("d".repeat(MAX_DETAILS_CHARS));
    expect(view).not.toHaveProperty("truncated");
    db.close();
  });

  it("cuts text at the cap with an ellipsis and never splits an emoji", () => {
    const db = openDb(":memory:");
    const body = `${"a".repeat(MAX_TEXT_CHARS - 2)}😀${"b".repeat(50)}`;
    const [view] = recallForModel(db, [hit({ layer: "episode", id: "e1", text: body })]);

    expect(Array.from(view?.text ?? "").length).toBe(MAX_TEXT_CHARS);
    expect(view?.text.endsWith("😀…")).toBe(true);
    expect(view?.text).not.toMatch(LONE_SURROGATE);
    expect(view?.truncated).toBe(true);
    db.close();
  });

  it("cuts details at their own cap and marks the hit truncated", () => {
    const db = openDb(":memory:");
    const details = `${"d".repeat(MAX_DETAILS_CHARS)}tail`;
    insertMemory(db, { id: "m1", gist: "gist", details });

    const [view] = recallForModel(db, [hit({ layer: "memory", id: "m1" })]);

    expect(Array.from(view?.details ?? "").length).toBe(MAX_DETAILS_CHARS);
    expect(view?.details?.endsWith("…")).toBe(true);
    expect(view?.truncated).toBe(true);
    db.close();
  });

  it("leaves short strings untouched and without truncated", () => {
    const db = openDb(":memory:");
    insertMemory(db, { id: "m1", gist: "gist", details: "short detail" });

    const [view] = recallForModel(db, [hit({ layer: "memory", id: "m1", text: "short text" })]);

    expect(view?.text).toBe("short text");
    expect(view?.details).toBe("short detail");
    expect(view).not.toHaveProperty("truncated");
    db.close();
  });

  it("includes polarity only when it is not neutral", () => {
    const db = openDb(":memory:");
    insertTrait(db, "shadow", "avoids reviews", "shadow");
    insertTrait(db, "neutral", "uses TypeScript", "neutral");
    insertTrait(db, "light", "prefers small PRs", "light");

    const hits = recallForModel(db, [
      hit({ layer: "trait", id: "shadow" }),
      hit({ layer: "trait", id: "neutral" }),
      hit({ layer: "trait", id: "light" }),
    ]);

    expect(hits[0]?.polarity).toBe("shadow");
    expect(hits[1]).not.toHaveProperty("polarity");
    expect(hits[2]?.polarity).toBe("light");
    db.close();
  });
});

describe("recallMissForModel", () => {
  it("lists the scopes with memories, traits or pending episodes, most populated first", () => {
    const db = openDb(":memory:");
    insertMemory(db, { id: "m1", gist: "one", scope: "p/a" });
    insertMemory(db, { id: "m2", gist: "two", scope: "p/a" });
    insertMemory(db, { id: "m3", gist: "three", scope: "p/a" });
    // What consolidation leaves behind: the noise memory plus the episodes tied to it. The
    // scope still shows up in the counts with nothing but consolidated episodes, so only the
    // `total > 0` filter keeps it out of the list.
    insertMemory(db, { id: "n1", gist: "[noise] dropped", scope: "p/noise" });
    insertEpisode(db, {
      id: "e4",
      scope: "p/noise",
      body: "chatter nobody cited",
      consolidatedInto: "n1",
    });
    insertTrait(db, "t1", "prefers small PRs", "neutral", "p/b");
    insertEpisode(db, { id: "e1", scope: "p/b", body: "pending note" });
    insertEpisode(db, {
      id: "e2",
      scope: "p/a",
      body: "already distilled",
      consolidatedInto: "m1",
    });
    insertEpisode(db, { id: "e3", scope: "p/c", body: "lone pending" });

    expect(recallMissForModel(db)).toEqual({ scopes: ["p/a", "p/b", "p/c"] });
    db.close();
  });

  it("caps the list at 20 scopes and keeps the most populated ones", () => {
    const db = openDb(":memory:");
    // Distinct counts per scope, so which one falls outside the cap does not depend on collation.
    for (let i = 0; i <= 20; i++) {
      const scope = `p/s${String(i).padStart(2, "0")}`;
      for (let n = 0; n <= i; n++) insertMemory(db, { id: `${scope}-${n}`, gist: "g", scope });
    }

    const { scopes } = recallMissForModel(db);

    expect(scopes).toHaveLength(20);
    expect(scopes[0]).toBe("p/s20");
    expect(scopes).not.toContain("p/s00");
    db.close();
  });

  it("says that the scope it was asked for has nothing, and points at the scopes that do", () => {
    const db = openDb(":memory:");
    insertMemory(db, { id: "m1", gist: "one", scope: "p/a" });

    const view = recallMissForModel(db, "p/typo");

    expect(view.scopes).toEqual(["p/a"]);
    expect(view.hint).toContain("p/typo");
    expect(view.hint).toMatch(/no tiene/);
    expect(view.hint).toContain("usa uno de los que aparecen en scopes");
    db.close();
  });

  it("no remite a una lista de ámbitos vacía cuando la memoria todavía no guarda nada", () => {
    const db = openDb(":memory:");

    const view = recallMissForModel(db, "p/typo");

    expect(view.scopes).toEqual([]);
    expect(view.hint).toContain("p/typo");
    expect(view.hint).toMatch(/no tiene/);
    expect(view.hint).toMatch(/no guarda contenido/);
    expect(view.hint).not.toContain("scopes");
    db.close();
  });

  it("adds no hint when no scope was asked for, even with nothing stored", () => {
    const db = openDb(":memory:");
    expect(recallMissForModel(db)).toEqual({ scopes: [] });
    db.close();
  });
});
