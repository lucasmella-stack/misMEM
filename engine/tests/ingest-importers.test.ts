import { beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { ingestChatGPTExport } from "../src/ingest/chatgpt.js";
import { ingestVSCodeTranscripts } from "../src/ingest/vscode.js";

const FIXTURES = join(import.meta.dirname, "fixtures");

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

const episodes = (): Array<{ scope: string; body: string }> =>
  db.prepare("SELECT scope, body FROM episodes ORDER BY created_at, rowid").all() as Array<{ scope: string; body: string }>;

describe("ingestChatGPTExport", () => {
  it("keeps user and assistant text and drops null, system, tool and empty messages", async () => {
    const stats = await ingestChatGPTExport(db, join(FIXTURES, "chatgpt-export"));

    const eps = episodes();
    expect(eps).toHaveLength(1);
    expect(eps[0]!.scope).toBe("chatgpt/conv-main");
    const body = eps[0]!.body;
    expect(body).toContain("# Fixture conversation");
    expect(body).toContain("## user\nquestion about zebras");
    expect(body).toContain("## assistant\nanswer about zebras");
    expect(body).toContain("source: conversations.json");
    expect(body).not.toContain("SYSTEM-PROMPT-MARKER");
    expect(body).not.toContain("TOOL-OUTPUT-MARKER");
    // The assistant message with no parts must not leave an empty section behind.
    expect(body.match(/## assistant/g)).toHaveLength(1);

    // 1 imported conversation (6 mapping nodes); skipped: the one without mapping, the unparsable
    // file and conversations-empty.json.
    expect(stats).toEqual({ conversations: 1, messages: 6, skipped: 3 });
  });

  it("skips a conversation whose messages carry no text", async () => {
    const stats = await ingestChatGPTExport(db, join(FIXTURES, "chatgpt-export"));

    const eps = episodes();
    expect(eps).toHaveLength(1);
    expect(eps.map((e) => e.scope)).not.toContain("chatgpt/conv-empty");
    // The title and date alone are not memory; the conversation must count as skipped.
    expect(stats.skipped).toBe(3);
  });

  it("is idempotent: importing the same export twice adds nothing", async () => {
    await ingestChatGPTExport(db, join(FIXTURES, "chatgpt-export"));
    await ingestChatGPTExport(db, join(FIXTURES, "chatgpt-export"));
    expect(episodes()).toHaveLength(1);
  });
});

describe("ingestVSCodeTranscripts", () => {
  it("imports the readable lines of a transcript and survives a malformed JSONL line", async () => {
    const stats = await ingestVSCodeTranscripts(db, join(FIXTURES, "vscode-user"));

    const eps = episodes();
    expect(eps).toHaveLength(1);
    expect(eps[0]!.scope).toBe("vscode/transcripts/ws1");
    const body = eps[0]!.body;
    expect(body).toContain("# transcript ws1/session.jsonl");
    expect(body).toContain("[user] first prompt about llamas");
    expect(body).toContain("[assistant] reply through the text field");
    // An object without a string content is serialised instead of dropped.
    expect(body).toContain('[tool] {"role":"tool","content":{"nested":"object"}}');
    expect(body).not.toContain("this line is not json");

    // 3 records survive out of 5 non-blank lines; the empty file and the all-malformed file are skipped.
    expect(stats).toEqual({ files: 1, records: 3, skipped: 2 });
  });

  it("returns zeroes when the user dir has no workspaceStorage", async () => {
    const stats = await ingestVSCodeTranscripts(db, join(FIXTURES, "chatgpt-export"));
    expect(stats).toEqual({ files: 0, records: 0, skipped: 0 });
    expect(episodes()).toHaveLength(0);
  });
});
