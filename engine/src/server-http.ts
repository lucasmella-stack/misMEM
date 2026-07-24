#!/usr/bin/env node
/**
 * HTTP MCP server (Streamable HTTP transport).
 *
 * Diseñado para deploy detrás de Traefik con BasicAuth.
 * Reemplazo drop-in de Engram (mismo path /mcp, mismas tools mem_*).
 *
 * Env vars:
 *   MISMEM_HTTP_PORT     (default 3200)
 *   MISMEM_HTTP_HOST     (default 0.0.0.0)
 *   MISMEM_AUTH_USER     opcional — si está, requiere BasicAuth en /mcp
 *   MISMEM_AUTH_PASS     opcional — pareja del anterior
 *   MISMEM_DB            ruta SQLite (default ~/.mismem/mem.db)
 *
 * Endpoints:
 *   GET  /healthz   →  200 ok (liveness)
 *   POST /mcp       →  MCP JSON-RPC (Streamable HTTP)
 *   GET  /mcp       →  SSE stream (Streamable HTTP)
 *   DELETE /mcp     →  cierra stream
 */
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDefaultDb } from "./db.js";
import { createServer } from "./server-core.js";
import {
  handleViewerHtml,
  handleStats,
  handleRecent,
  handleSearch,
} from "./viewer.js";

const PORT = Number(process.env.MISMEM_HTTP_PORT ?? 3200);
const HOST = process.env.MISMEM_HTTP_HOST ?? "0.0.0.0";
const AUTH_USER = process.env.MISMEM_AUTH_USER;
const AUTH_PASS = process.env.MISMEM_AUTH_PASS;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkBasicAuth(req: IncomingMessage): boolean {
  if (!AUTH_USER || !AUTH_PASS) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);
  return safeEqual(user, AUTH_USER) && safeEqual(pass, AUTH_PASS);
}

function send401(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="misMEM"');
  res.end("Unauthorized");
}

const db = openDefaultDb();

const httpServer = createHttpServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", service: "mismem" }));
      return;
    }

    if (url.pathname === "/mcp") {
      if (!checkBasicAuth(req)) {
        send401(res);
        return;
      }
      // Stateless: cada request es independiente — server + transport per-request.
      // Coincide con el ejemplo oficial simpleStatelessStreamableHttp.ts del SDK.
      const mcpServer = createServer(db);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    // Read-only viewer + JSON API. Misma BasicAuth que /mcp.
    if (
      url.pathname === "/viewer" ||
      url.pathname === "/" ||
      url.pathname.startsWith("/api/")
    ) {
      if (!checkBasicAuth(req)) {
        send401(res);
        return;
      }
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET");
        res.end("Method Not Allowed");
        return;
      }
      if (url.pathname === "/api/stats") return handleStats(db, res);
      if (url.pathname === "/api/recent") return handleRecent(db, res, url);
      if (url.pathname === "/api/search") return handleSearch(db, res, url);
      return handleViewerHtml(res);
    }

    res.statusCode = 404;
    res.end("Not Found");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error("[mcp]", err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: message }));
    } else {
      res.end();
    }
  }
});

httpServer.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(
    `misMEM HTTP listening on http://${HOST}:${PORT} (mcp=/mcp viewer=/viewer)`,
  );
});

const shutdown = (): void => {
  httpServer.close();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
