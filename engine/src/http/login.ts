// The viewer's sign-in. A plain form with no JavaScript: the viewer's CSP forbids inline
// scripts, and a form that needs none cannot break. The page is served by the engine and not
// built with the interface so it stays reachable when `dist/ui` is missing.
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { envPositiveNumber } from "../env.js";
import type { BasicCredentials } from "./guard.js";
import { cookieHeader, issueSession } from "./session.js";

/**
 * Tighter than the viewer's: this page runs no script at all. `form-action 'self'` is the one
 * thing it needs that the viewer's forbids, and without it the browser blocks the submit.
 */
const LOGIN_CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "img-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Attempts allowed inside the window before the server stops checking the password at all. */
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 15 * 60_000;

/**
 * Failed attempts per process. Not per IP on purpose: behind Traefik every request shares the
 * proxy's address, so counting by it would be either useless or a way to lock out everyone.
 */
export class LoginAttempts {
  private failures: number[] = [];

  constructor(private readonly max: number = MAX_ATTEMPTS) {}

  blocked(at: number = Date.now()): boolean {
    this.failures = this.failures.filter((when) => at - when < WINDOW_MS);
    return this.failures.length >= this.max;
  }

  fail(at: number = Date.now()): void {
    this.failures.push(at);
  }

  clear(): void {
    this.failures = [];
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Body of a form POST, capped: nobody signs in with more than a few hundred bytes. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const cap = envPositiveNumber("MISMEM_LOGIN_MAX_BODY_BYTES", 4096);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > cap) throw new Error("cuerpo demasiado grande");
    chunks.push(buf);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function redirect(res: ServerResponse, to: string, cookie?: string): void {
  res.statusCode = 302;
  res.setHeader("location", to);
  if (cookie !== undefined) res.setHeader("set-cookie", cookie);
  res.end();
}

/**
 * A request arrives over TLS when Traefik terminates it and says so; a local viewer on
 * http://127.0.0.1 has none, and marking the cookie Secure there would lose it silently.
 */
function overTls(req: IncomingMessage): boolean {
  return (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0]?.trim() === "https";
}

function loginPage(failed: boolean): string {
  const aviso = failed
    ? '<p class="aviso" role="alert">Usuario o contraseña incorrectos.</p>'
    : "";
  return `<!doctype html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>misMEM — Entrar</title>
<link rel="stylesheet" href="/login.css">
</head><body>
<main>
  <span class="marca" role="img" aria-label="misMEM"></span>
  <p class="lema">Tu memoria, en tu computadora.</p>
  <form method="post" action="/login">
    <div class="campo">
      <label for="usuario">Usuario</label>
      <input id="usuario" name="usuario" type="text" autocomplete="username"
             autocapitalize="none" spellcheck="false" required autofocus>
    </div>
    <div class="campo">
      <label for="clave">Contraseña</label>
      <input id="clave" name="clave" type="password" autocomplete="current-password" required>
    </div>
    <button type="submit">Entrar</button>
    ${aviso}
  </form>
</main>
</body></html>`;
}

/**
 * Answers the sign-in routes. Returns false when the path is not one of them, so the dispatch
 * can carry on. With no credentials configured there is nothing to sign in to.
 */
export async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  deps: {
    auth: BasicCredentials | null;
    attempts: LoginAttempts;
    css: string;
    /** The logo by served path. Empty when the interface was never built. */
    assets: ReadonlyMap<string, Buffer>;
  },
): Promise<boolean> {
  const { auth, attempts, css, assets } = deps;

  // The page cannot reach anything under /viewer: that path is exactly what it signs in for.
  const asset = auth !== null ? assets.get(pathname) : undefined;
  if (asset !== undefined) {
    res.statusCode = 200;
    res.setHeader("content-type", "image/webp");
    res.setHeader("cache-control", "public, max-age=3600");
    res.end(asset);
    return true;
  }

  if (pathname === "/login.css" && auth !== null) {
    res.statusCode = 200;
    res.setHeader("content-type", "text/css; charset=utf-8");
    res.end(css);
    return true;
  }

  if (pathname === "/logout") {
    redirect(res, "/login", cookieHeader("", { secure: overTls(req), expire: true }));
    return true;
  }

  if (pathname !== "/login" || auth === null) return false;

  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("content-security-policy", LOGIN_CSP);
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    res.end(loginPage(new URL(req.url ?? "/", "http://localhost").searchParams.has("error")));
    return true;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "GET, POST");
    res.end();
    return true;
  }

  // Checked before reading the body: a blocked attempt must not even cost a comparison.
  if (attempts.blocked()) {
    res.statusCode = 429;
    res.setHeader("retry-after", String(Math.ceil(WINDOW_MS / 1000)));
    res.end("demasiados intentos");
    return true;
  }

  let form: URLSearchParams;
  try {
    form = await readForm(req);
  } catch {
    attempts.fail();
    redirect(res, "/login?error=1");
    return true;
  }

  const user = form.get("usuario") ?? "";
  const pass = form.get("clave") ?? "";
  // Both are compared before answering so the reply does not say which one was wrong.
  if (safeEqual(user, auth.user) && safeEqual(pass, auth.pass)) {
    attempts.clear();
    redirect(res, "/viewer", cookieHeader(issueSession(auth), { secure: overTls(req) }));
    return true;
  }

  attempts.fail();
  redirect(res, "/login?error=1");
  return true;
}
