#!/usr/bin/env node
// mismem-used: the Claude Code `Stop` hook, which reinforces the memories the answer used.
// It reads `transcript_path` from the hook payload, looks at the last turn and reinforces only
// the memories whose words reappear; it never exits with an error, so it cannot break a turn.
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./store/db.js";
import { envOptionalPositiveNumber } from "./env.js";
import { callRemoteTool, readStdin } from "./hooks/client.js";
import { reinforce } from "./memory/reinforce.js";
import {
  assistantReply,
  injectedMemories,
  lastTurn,
  recalledMemories,
  usedMemoryIds,
  type UsageOptions,
} from "./hooks/usage.js";

const REMOTE_TIMEOUT_MS = 5000;

function reinforceLocal(ids: string[]): void {
  const db = openDb(defaultDbPath());
  try {
    reinforce(db, { memory_ids: ids });
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const flagIndex = argv.indexOf("--transcript");
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;

  // With --transcript stdin is not needed, and reading it anyway means waiting on nobody.
  let transcript = fromFlag;
  if (!transcript) {
    const stdin = await readStdin();
    if (!stdin.trim()) return;
    const payload = JSON.parse(stdin) as { transcript_path?: string };
    transcript = payload.transcript_path;
  }
  if (!transcript) return;

  const lines = readFileSync(transcript, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });

  const turn = lastTurn(lines);
  // What the model asked for plus what the injection hook put in front of it, without repeated ids.
  const porId = new Map(
    [...recalledMemories(turn), ...injectedMemories(turn)].map((m) => [m.id, m]),
  );
  const memories = [...porId.values()];
  if (memories.length === 0) return;

  const opts: UsageOptions = {
    minOverlap: envOptionalPositiveNumber("MISMEM_HOOK_MIN_OVERLAP"),
    minShared: envOptionalPositiveNumber("MISMEM_HOOK_MIN_SHARED"),
  };
  const used = usedMemoryIds(memories, assistantReply(turn), opts);

  if (dryRun) {
    console.log(
      JSON.stringify({ recalled: memories.length, used: used.length, memory_ids: used }, null, 2),
    );
    return;
  }
  if (used.length === 0) return;

  const url = process.env.MISMEM_HOOK_URL;
  if (url) await callRemoteTool(url, "reinforce", { memory_ids: used }, REMOTE_TIMEOUT_MS);
  else reinforceLocal(used);
}

main().catch((err: unknown) => {
  // A failing hook cannot cut anyone's turn: it complains and exits clean.
  process.stderr.write(`[mismem-used] ${err instanceof Error ? err.message : String(err)}\n`);
});
