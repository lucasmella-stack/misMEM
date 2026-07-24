import { describe, it, expect, beforeEach } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import {
  capture,
  recall,
  consolidate,
  crystallize,
  forget,
} from "../src/tools.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

describe("capture", () => {
  it("stores an episode and returns its id", () => {
    const { id } = capture(db, { scope: "test", body: "hola mundo" });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as {
      body: string;
    };
    expect(row.body).toBe("hola mundo");
  });

  it("rejects empty body", () => {
    expect(() => capture(db, { scope: "test", body: "" })).toThrow();
  });
});

describe("recall", () => {
  it("finds episodes via FTS and respects scope", () => {
    capture(db, { scope: "a", body: "alpha beta gamma" });
    capture(db, { scope: "b", body: "alpha delta" });
    const { hits } = recall(db, { query: "alpha", scope: "a" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.scope).toBe("a");
  });

  it("returns empty when no match", () => {
    capture(db, { scope: "a", body: "alpha" });
    const { hits } = recall(db, { query: "zeta" });
    expect(hits).toEqual([]);
  });

  it("ranks traits over memories over episodes", () => {
    const { id: ep } = capture(db, { scope: "s", body: "patron recurrente" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "patron recurrente observado",
      source_episode_ids: [ep],
    });
    crystallize(db, {
      scope: "s",
      name: "patron recurrente",
      evidence_memory_ids: [memory_id],
    });
    const { hits } = recall(db, { query: "patron" });
    expect(hits[0]?.layer).toBe("trait");
  });
});

describe("consolidate", () => {
  it("creates memory and links episodes", () => {
    const { id: e1 } = capture(db, { scope: "s", body: "uno" });
    const { id: e2 } = capture(db, { scope: "s", body: "dos" });
    const { memory_id, consolidated } = consolidate(db, {
      scope: "s",
      gist: "resumen",
      source_episode_ids: [e1, e2],
    });
    expect(consolidated).toBe(2);
    const ep = db
      .prepare("SELECT consolidated_into FROM episodes WHERE id = ?")
      .get(e1) as { consolidated_into: string };
    expect(ep.consolidated_into).toBe(memory_id);
  });

  it("does not consolidate episodes from a different scope", () => {
    const { id } = capture(db, { scope: "other", body: "x" });
    const { consolidated } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [id],
    });
    expect(consolidated).toBe(0);
  });
});

describe("crystallize", () => {
  it("creates a new trait", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [ep],
    });
    const { created, strength } = crystallize(db, {
      scope: "s",
      name: "rasgo",
      evidence_memory_ids: [memory_id],
      polarity: "shadow",
    });
    expect(created).toBe(true);
    expect(strength).toBe(1);
  });

  it("strengthens existing trait on repeat", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    const { memory_id } = consolidate(db, {
      scope: "s",
      gist: "g",
      source_episode_ids: [ep],
    });
    crystallize(db, {
      scope: "s",
      name: "rasgo",
      evidence_memory_ids: [memory_id],
    });
    const second = crystallize(db, {
      scope: "s",
      name: "rasgo",
      evidence_memory_ids: [memory_id],
    });
    expect(second.created).toBe(false);
    expect(second.strength).toBe(2);
  });
});

describe("forget", () => {
  it("dry_run reports counts without deleting", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    consolidate(db, { scope: "s", gist: "g", source_episode_ids: [ep] });
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 60 * 86_400_000,
      ep,
    );
    const r = forget(db, { before_days: 30, dry_run: true });
    expect(r.episodes_to_delete).toBe(1);
    const still = db
      .prepare("SELECT COUNT(*) AS n FROM episodes")
      .get() as { n: number };
    expect(still.n).toBe(1);
  });

  it("actually deletes when dry_run=false", () => {
    const { id: ep } = capture(db, { scope: "s", body: "x" });
    consolidate(db, { scope: "s", gist: "g", source_episode_ids: [ep] });
    db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(
      Date.now() - 60 * 86_400_000,
      ep,
    );
    forget(db, { before_days: 30, dry_run: false });
    const still = db
      .prepare("SELECT COUNT(*) AS n FROM episodes")
      .get() as { n: number };
    expect(still.n).toBe(0);
  });
});
