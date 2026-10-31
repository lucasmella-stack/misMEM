import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { CHUNK_BYTES, chunkText } from "../src/ingest/walk.js";
import { ingestChatGPTExport } from "../src/ingest/chatgpt.js";
import { ingestVSCodeTranscripts } from "../src/ingest/vscode.js";

let db: DB;
let dir: string;

beforeEach(() => {
  db = openDb(":memory:");
  dir = mkdtempSync(join(tmpdir(), "mismem-chunk-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const bodies = (): string[] =>
  (db.prepare("SELECT body FROM episodes ORDER BY rowid").all() as Array<{ body: string }>).map((r) => r.body);

describe("chunkText", () => {
  it("keeps the 80k cap", () => {
    expect(CHUNK_BYTES).toBe(80_000);
  });

  it("returns short text whole and splits at the cap without losing a character", () => {
    expect(chunkText("abc")).toEqual(["abc"]);
    expect(chunkText("x".repeat(CHUNK_BYTES))).toHaveLength(1);
    const text = "y".repeat(CHUNK_BYTES * 2 + 5);
    const chunks = chunkText(text);
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 5]);
    expect(chunks.join("")).toBe(text);
  });
});

describe("the ingesters chunk with it", () => {
  it("chatgpt: a conversation over the cap becomes tagged chunks", async () => {
    const conv = {
      id: "c1",
      title: "t",
      mapping: {
        n1: {
          message: { id: "m", author: { role: "user" }, content: { parts: ["z".repeat(CHUNK_BYTES + 10)] }, create_time: 1 },
          parent: null,
          children: [],
        },
      },
    };
    writeFileSync(join(dir, "conversations.json"), JSON.stringify([conv]));
    const stats = await ingestChatGPTExport(db, dir);
    expect(stats.conversations).toBe(1);
    const got = bodies();
    expect(got).toHaveLength(2);
    expect(got[0]).toMatch(/source: conversations\.json \[1\/2\]$/);
    expect(got[1]).toMatch(/source: conversations\.json \[2\/2\]$/);
  });

  it("chatgpt: a short conversation is one untagged episode", async () => {
    const conv = {
      id: "c2",
      mapping: { n1: { message: { id: "m", author: { role: "user" }, content: { parts: ["hi"] } }, parent: null, children: [] } },
    };
    writeFileSync(join(dir, "conversations.json"), JSON.stringify([conv]));
    await ingestChatGPTExport(db, dir);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).toMatch(/source: conversations\.json$/);
  });

  it("vscode: a transcript over the cap is split in chunks of at most the cap", async () => {
    const t = join(dir, "workspaceStorage", "ws1", "GitHub.copilot-chat", "transcripts");
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, "a.jsonl"), `${JSON.stringify({ role: "user", content: "w".repeat(CHUNK_BYTES + 100) })}\n`);
    const stats = await ingestVSCodeTranscripts(db, dir);
    expect(stats.files).toBe(1);
    const got = bodies();
    expect(got).toHaveLength(2);
    expect(got.every((b) => b.length <= CHUNK_BYTES)).toBe(true);
    expect(got[0]!.startsWith("# transcript ws1/a.jsonl")).toBe(true);
  });
});
