// Whether the server understands what the hook asks for: `recall` accepts `reinforce` since
// 0.5.0 and an older server drops it silently, so the hook would inject AND reinforce. The result
// is cached, and the "no" is short-lived so the hook turns itself on after a deploy.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { remoteToolNames } from "./client.js";

const READY_TTL_MS = 6 * 3_600_000;
const NOT_READY_TTL_MS = 10 * 60_000;

interface State {
  url: string;
  ready: boolean;
  checked: number;
}

function statePath(dbPath: string): string {
  return join(dirname(dbPath), "hook-readiness.json");
}

function read(path: string): State | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch {
    return undefined;
  }
}

function write(path: string, state: State): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    /* without a cache it asks again: annoying, not broken */
  }
}

export function isFresh(state: State | undefined, url: string, at: number): boolean {
  if (!state || state.url !== url) return false;
  const ttl = state.ready ? READY_TTL_MS : NOT_READY_TTL_MS;
  return at - state.checked < ttl;
}

/** `probe` exists so it can be tested without network. */
export async function serverReady(
  url: string,
  dbPath: string,
  timeoutMs: number,
  opts: { at?: number; probe?: (url: string, timeoutMs: number) => Promise<string[]> } = {},
): Promise<boolean> {
  const at = opts.at ?? Date.now();
  const path = statePath(dbPath);
  const cached = read(path);
  if (isFresh(cached, url, at)) return cached!.ready;

  const probe = opts.probe ?? remoteToolNames;
  let ready = false;
  try {
    ready = (await probe(url, timeoutMs)).includes("reinforce");
  } catch {
    // Server down or slow: not injecting is cheaper than injecting wrong.
    ready = false;
  }
  write(path, { url, ready, checked: at });
  return ready;
}
