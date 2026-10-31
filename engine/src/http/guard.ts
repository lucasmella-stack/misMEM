// What the HTTP server decides before answering a request. Kept out of server-http.ts, which
// listens on import, so it can be tested.
import { timingSafeEqual } from "node:crypto";
import { envPositiveNumber } from "../env.js";

/**
 * Loopback unless told otherwise: without MISMEM_AUTH_* the Host guard only stops browser
 * DNS rebinding, any LAN client can send `Host: localhost`. Containers opt in to 0.0.0.0
 * explicitly. An empty value counts as undefined.
 */
export function bindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.MISMEM_HTTP_HOST || "127.0.0.1";
}

/**
 * A garbage port used to reach listen() as NaN, which fails far from the variable that caused
 * it. Same rule as every other numeric env var: anything but a positive finite number means unset.
 */
export function httpPort(env: NodeJS.ProcessEnv = process.env): number {
  return envPositiveNumber("MISMEM_HTTP_PORT", 3200, env);
}

export interface BasicCredentials {
  user: string;
  pass: string;
}

/**
 * With neither variable there is no auth (local use). With only one, the server refuses to
 * start: coming up open instead would be the opposite of what whoever set the other one wanted.
 */
export function loadAuth(env: NodeJS.ProcessEnv = process.env): BasicCredentials | null {
  const user = env.MISMEM_AUTH_USER;
  const pass = env.MISMEM_AUTH_PASS;
  if (!user && !pass) return null;
  if (!user) throw new Error("MISMEM_AUTH_PASS está definida pero falta MISMEM_AUTH_USER");
  if (!pass) throw new Error("MISMEM_AUTH_USER está definida pero falta MISMEM_AUTH_PASS");
  return { user, pass };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function checkBasicAuth(header: string | undefined, auth: BasicCredentials | null): boolean {
  if (!auth) return true;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, auth.user) && safeEqual(pass, auth.pass);
}
