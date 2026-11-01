// The viewer's session: a signed cookie so a person meets a form instead of the browser's
// Basic dialog. /mcp keeps Basic and never accepts this cookie — an MCP client cannot fill a
// form, and a cookie must not become a second door into the tools.
import { createHmac, timingSafeEqual } from "node:crypto";
import { envPositiveNumber } from "../env.js";
import type { BasicCredentials } from "./guard.js";

export const SESSION_COOKIE = "mismem_session";

/** Hours a session lasts before the form comes back, from `MISMEM_SESSION_HOURS`. */
export function sessionTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return envPositiveNumber("MISMEM_SESSION_HOURS", 12, env) * 3_600_000;
}

/**
 * The key is derived from the credentials, never stored: rotating the password invalidates
 * every live session, which is what a password changed because it leaked has to do.
 */
function keyOf(auth: BasicCredentials): Buffer {
  return createHmac("sha256", "mismem.session.v1").update(`${auth.user}\u0000${auth.pass}`).digest();
}

function sign(expiry: number, auth: BasicCredentials): string {
  return createHmac("sha256", keyOf(auth)).update(String(expiry)).digest("base64url");
}

/** `<expiry>.<signature>`: the expiry travels in the clear and the signature is what defends it. */
export function issueSession(
  auth: BasicCredentials,
  at: number = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const expiry = at + sessionTtlMs(env);
  return `${expiry}.${sign(expiry, auth)}`;
}

export function verifySession(
  value: string | undefined,
  auth: BasicCredentials | null,
  at: number = Date.now(),
): boolean {
  // No credentials means no session: the cookie must not outlive turning auth on.
  if (auth === null || value === undefined) return false;
  const sep = value.indexOf(".");
  if (sep <= 0) return false;
  const expiry = Number(value.slice(0, sep));
  if (!Number.isSafeInteger(expiry) || expiry <= at) return false;
  const given = Buffer.from(value.slice(sep + 1), "base64url");
  const wanted = Buffer.from(sign(expiry, auth), "base64url");
  if (given.length !== wanted.length) return false;
  return timingSafeEqual(given, wanted);
}

/**
 * `Secure` is left off without TLS because a local viewer on http://127.0.0.1 would lose the
 * cookie silently; behind Traefik the request arrives as https and it is set.
 */
export function cookieHeader(
  value: string,
  opts: { secure: boolean; expire?: boolean },
): string {
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    opts.expire ? "Max-Age=0" : `Max-Age=${Math.floor(sessionTtlMs() / 1000)}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  for (const piece of header.split(";")) {
    const sep = piece.indexOf("=");
    if (sep < 0) continue;
    if (piece.slice(0, sep).trim() === name) return piece.slice(sep + 1).trim();
  }
  return undefined;
}
