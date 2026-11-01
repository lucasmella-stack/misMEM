// Serves the compiled interface (engine/ui -> dist/ui) at /viewer. Assets carry the hash in
// their name and are cached forever; index.html is not, because it points at the hashes of
// the version that is running.
import { readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Next to the compiled server-http.js: dist/ui. Anchored to this module and never to the
 * working directory, which is wherever the person running the command happened to be.
 */
export const UI_DIR = fileURLToPath(new URL("./ui/", import.meta.url));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

// Scripts only from this server. Styles also allow inline: the graph library inserts its own
// <style> (tooltip) and the browser blocks it otherwise. An injected style runs no code; what
// matters is closing script-src.
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.statusCode = status;
  res.setHeader("content-type", type);
  res.setHeader("x-content-type-options", "nosniff");
  res.end(body);
}

/** `pathname` is the URL's: /, /viewer, /viewer/ or /viewer/assets/... */
export function serveUi(res: ServerResponse, pathname: string, dir = UI_DIR): void {
  const root = resolve(dir);
  const relative = pathname.replace(/^\/(viewer\/?)?/, "");

  if (relative && relative !== "index.html") {
    try {
      // A malformed % makes decodeURIComponent throw, which is a 404 too.
      const file = resolve(root, decodeURIComponent(relative));
      // Nothing outside dist/ui, even with a URL-encoded `..` in the path.
      if (!file.startsWith(root + sep) || !statSync(file).isFile()) throw new Error("fuera de la interfaz");
      res.setHeader("cache-control", "public, max-age=31536000, immutable");
      send(res, 200, TYPES[extname(file)] ?? "application/octet-stream", readFileSync(file));
      return;
    } catch {
      send(res, 404, "text/plain; charset=utf-8", "No encontrado");
      return;
    }
  }

  let html: Buffer;
  try {
    html = readFileSync(join(root, "index.html"));
  } catch {
    // Happens when running through tsx without a build, or from a package built without the interface.
    send(
      res,
      503,
      "text/plain; charset=utf-8",
      "La interfaz de misMEM no está compilada: corre `pnpm build` en engine/ y reinicia el servidor.",
    );
    return;
  }
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-security-policy", CSP);
  res.setHeader("referrer-policy", "no-referrer");
  send(res, 200, TYPES[".html"] as string, html);
}

/**
 * The images the sign-in page needs, by served path. That page cannot reach anything under
 * /viewer — signing in is exactly what it is for — so the engine hands them over itself.
 * Missing them only costs the image: a package built without the interface still signs in.
 */
export function loginAssets(dir = UI_DIR): Map<string, Buffer> {
  const assets = new Map<string, Buffer>();
  for (const [served, file] of [
    ["/login-logo.webp", "logo.webp"],
    ["/login-logo-dark.webp", "logo-dark.webp"],
  ] as const) {
    try {
      assets.set(served, readFileSync(join(dir, file)));
    } catch {
      // Built without the interface: the page renders without its logo rather than failing.
    }
  }
  return assets;
}
