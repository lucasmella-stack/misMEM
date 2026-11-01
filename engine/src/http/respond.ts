// HTTP responses shared by the dispatch (routes.ts) and the viewer handlers. Each helper fixes
// the status and headers without unifying them: the viewer and the MCP SDK read content-type
// and cache-control as they are, so changing them alters the contract even with the same body.
import type { ServerResponse } from "node:http";

/** Interface JSON: explicit UTF-8 and no cache. */
export function json(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

/** JSON without charset or cache headers: the /mcp JSON-RPC errors and the generic 500. */
export function jsonBare(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

/** UTF-8 JSON with no cache header: the 404 of an /api route that does not exist. */
export function jsonPlain(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

/** BasicAuth 401: without the challenge the browser does not ask for credentials. */
export function unauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="misMEM"');
  res.end("No autorizado");
}

/** 404 of a route that belongs to nobody, without content-type. */
export function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.end("No encontrado");
}

/** /api 405 for anything that is not GET or POST. */
export function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.setHeader("allow", "GET, POST");
  res.end("Método no permitido");
}

/** /mcp 413: the connection closes because the rest of the body is not drained. */
export function payloadTooLarge(res: ServerResponse): void {
  res.statusCode = 413;
  res.setHeader("connection", "close");
  res.end("Cuerpo demasiado grande");
}
