#!/usr/bin/env node
// mismem-inject: the Claude Code `UserPromptSubmit` hook, which brings relevant memories
// forward before the model answers, searching with `reinforce: false` because a search nobody
// asked for is not use. It runs every turn, so it never fails and simply injects nothing.
import { readFileSync } from "node:fs";
import { defaultDbPath, openDb } from "./store/db.js";
import { envPositiveNumber } from "./env.js";
import { callRemoteTool, readStdin } from "./hooks/client.js";
import { serverReady } from "./hooks/readiness.js";
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_MEMORIES,
  DEFAULT_MIN_PROMPT_TERMS,
  formatInjection,
  parseScopeList,
  selectForInjection,
  worthRecalling,
} from "./hooks/inject.js";
import type { RecallHit } from "./schema.js";
import { recallHybrid } from "./recall/recall.js";

const DEFAULT_TIMEOUT_MS = 2500;
/** How many memories to ask recall for before filtering; the filter drops several. */
const CANDIDATES = 10;

async function search(query: string, timeoutMs: number): Promise<RecallHit[]> {
  const scope = process.env.MISMEM_HOOK_SCOPE || undefined;
  const args = { query, limit: CANDIDATES, reinforce: false, ...(scope ? { scope } : {}) };
  const url = process.env.MISMEM_HOOK_URL;
  if (url) {
    const dbPath = defaultDbPath();
    // A server without `reinforce` drops the field and reinforces anyway, so it is not called.
    if (!(await serverReady(url, dbPath, timeoutMs))) return [];
    const result = (await callRemoteTool(url, "recall", args, timeoutMs)) as { hits?: RecallHit[] };
    return result?.hits ?? [];
  }
  const db = openDb(defaultDbPath());
  try {
    return (await recallHybrid(db, args)).hits;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const promptFlag = process.argv.indexOf("--prompt");

  let prompt = promptFlag >= 0 ? process.argv[promptFlag + 1] : undefined;
  let transcript: string | undefined;
  if (prompt === undefined) {
    const stdin = await readStdin();
    if (!stdin.trim()) return;
    const payload = JSON.parse(stdin) as { prompt?: string; transcript_path?: string };
    prompt = payload.prompt;
    transcript = payload.transcript_path;
  }
  if (!prompt?.trim()) return;

  const minTerms = envPositiveNumber("MISMEM_HOOK_MIN_PROMPT_TERMS", DEFAULT_MIN_PROMPT_TERMS);
  if (!worthRecalling(prompt, minTerms)) return;

  const hits = await search(prompt, envPositiveNumber("MISMEM_HOOK_TIMEOUT_MS", DEFAULT_TIMEOUT_MS));

  // An id already in the transcript is already in context: repeating it pays twice.
  let alreadyPresent = new Set<string>();
  if (transcript) {
    try {
      const raw = readFileSync(transcript, "utf8");
      alreadyPresent = new Set(hits.filter((hit) => raw.includes(hit.id)).map((hit) => hit.id));
    } catch {
      /* without a readable transcript, inject anyway: repeating costs less than not remembering */
    }
  }

  const chosen = selectForInjection(hits, {
    maxMemories: envPositiveNumber("MISMEM_HOOK_MAX_MEMORIES", DEFAULT_MAX_MEMORIES),
    maxChars: envPositiveNumber("MISMEM_HOOK_MAX_CHARS", DEFAULT_MAX_CHARS),
    excludeScopes: parseScopeList(process.env.MISMEM_HOOK_EXCLUDE_SCOPES),
    alreadyPresent,
  });

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify({ candidates: hits.length, injected: chosen.length, hits: chosen.map((h) => ({ id: h.id, scope: h.scope })) }, null, 2)}\n`,
    );
    return;
  }
  if (chosen.length === 0) return;

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: formatInjection(chosen),
      },
    })}\n`,
  );
}

main().catch((err: unknown) => {
  // Without memories the turn still goes on; with the turn cut short, it does not.
  process.stderr.write(`[mismem-inject] ${err instanceof Error ? err.message : String(err)}\n`);
});
