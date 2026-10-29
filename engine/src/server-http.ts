#!/usr/bin/env node
/**
 * HTTP MCP server (Streamable HTTP transport).
 *
 * Diseñado para deploy detrás de Traefik con BasicAuth.
 * Reemplazo drop-in de Engram (mismo path /mcp, mismas tools mem_*).
 *
 * Env vars:
 *   MISMEM_HTTP_PORT     (default 3200)
 *   MISMEM_HTTP_HOST     (default 127.0.0.1; containers set 0.0.0.0)
 *   MISMEM_AUTH_USER     opcional: con MISMEM_AUTH_PASS, BasicAuth en /mcp, /viewer y /api
 *   MISMEM_AUTH_PASS     pareja del anterior; con una sola de las dos no arranca
 *   MISMEM_DB            ruta SQLite (default ~/.mismem/mem.db)
 *   MISMEM_ALLOWED_HOSTS sin auth, nombres de Host aceptados además de loopback (coma)
 *   MISMEM_HTTP_MAX_BODY_BYTES  tope del cuerpo de POST /mcp (default 4 MiB); más, 413
 *   MISMEM_VIEWER_ALLOW_DELETE  1 para que la interfaz pueda olvidar memorias y rasgos (default apagado)
 *
 * Endpoints:
 *   GET  /healthz   →  200 ok (liveness)
 *   POST /mcp       →  MCP JSON-RPC (Streamable HTTP)
 *   GET  /mcp       →  SSE stream (Streamable HTTP)
 *   DELETE /mcp     →  cierra stream
 */
import { createServer as createHttpServer } from "node:http";
import type { ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDefaultDb } from "./db.js";
import { hostAllowed, parseHostList } from "./http-host.js";
import { BodyTooLargeError, InvalidJsonError, isJsonContentType, loadMaxBodyBytes, readJsonBody } from "./http-body.js";
import { bindHost, checkBasicAuth, httpPort, loadAuth } from "./http-guard.js";
import { createServer } from "./server-core.js";
import {
  handleStats,
  handleRecent,
  handleSearch,
  json,
} from "./viewer.js";
import {
  handleEmbeddings,
  handleGraph,
  handleMemories,
  handleMemory,
  handleScopes,
  handleTrait,
  parseDetailPath,
} from "./viewer-api.js";
import { serveUi } from "./viewer-static.js";
import {
  ACTION_MAX_BODY_BYTES,
  ForgetConfirmations,
  handleAction,
  loadAllowDelete,
  writeGuard,
} from "./viewer-actions.js";
import { ConsolidationJob } from "./consolidation/job.js";

const PORT = httpPort();
const HOST = bindHost();
const ALLOWED_HOSTS = parseHostList(process.env.MISMEM_ALLOWED_HOSTS);
const MAX_BODY_BYTES = loadMaxBodyBytes();

let AUTH: ReturnType<typeof loadAuth>;
try {
  AUTH = loadAuth();
} catch (err) {
  console.error(`[mismem-http] ${(err as Error).message}`);
  process.exit(1);
}

function send401(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", 'Basic realm="misMEM"');
  res.end("No autorizado");
}

const db = openDefaultDb();
// La corrida de consolidación que se lanza desde la interfaz: una a la vez por proceso.
const consolidationJob = new ConsolidationJob(db);
const ALLOW_DELETE = loadAllowDelete();
const forgetConfirmations = new ForgetConfirmations();

const httpServer = createHttpServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host, { auth: AUTH !== null, extra: ALLOWED_HOSTS })) {
      res.statusCode = 403;
      res.end("Host no permitido");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/healthz") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ status: "ok", service: "mismem" }));
      return;
    }

    if (url.pathname === "/mcp") {
      if (!checkBasicAuth(req.headers.authorization, AUTH)) {
        send401(res);
        return;
      }
      let parsedBody: unknown;
      if (req.method === "POST") {
        // Antes de leer un byte: el SDK tira 415 igual, pero sólo después de parsear.
        if (!isJsonContentType(req.headers["content-type"])) {
          res.statusCode = 415;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Tipo de contenido no soportado: Content-Type debe ser application/json",
              },
              id: null,
            }),
          );
          return;
        }
        try {
          parsedBody = await readJsonBody(req, MAX_BODY_BYTES);
        } catch (err) {
          if (err instanceof BodyTooLargeError) {
            res.statusCode = 413;
            // Lo que quede sin leer no se drena: se cierra la conexión.
            res.setHeader("connection", "close");
            res.end("Cuerpo demasiado grande");
            return;
          }
          if (err instanceof InvalidJsonError) {
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                error: { code: -32700, message: "Error de parseo" },
                id: null,
              }),
            );
            return;
          }
          throw err;
        }
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
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    // Viewer + su API. Misma BasicAuth que /mcp; las escrituras, además, con writeGuard.
    if (
      url.pathname === "/viewer" ||
      url.pathname.startsWith("/viewer/") ||
      url.pathname === "/" ||
      url.pathname.startsWith("/api/")
    ) {
      if (!checkBasicAuth(req.headers.authorization, AUTH)) {
        send401(res);
        return;
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const rejected = writeGuard(req);
        if (rejected) {
          res.statusCode = rejected.status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: rejected.error }));
          return;
        }
        let body: unknown;
        try {
          body = await readJsonBody(req, ACTION_MAX_BODY_BYTES);
        } catch (err) {
          const tooLarge = err instanceof BodyTooLargeError;
          if (!tooLarge && !(err instanceof InvalidJsonError)) throw err;
          res.statusCode = tooLarge ? 413 : 400;
          if (tooLarge) res.setHeader("connection", "close");
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: tooLarge ? "cuerpo demasiado grande" : "JSON inválido" }));
          return;
        }
        const actionOpts = { job: consolidationJob, allowDelete: ALLOW_DELETE, confirmations: forgetConfirmations };
        if (await handleAction(db, res, url.pathname, body, actionOpts)) return;
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: `acción desconocida: ${url.pathname}` }));
        return;
      }
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.setHeader("allow", "GET, POST");
        res.end("Método no permitido");
        return;
      }
      if (url.pathname === "/api/stats") return handleStats(db, res);
      if (url.pathname === "/api/recent") return handleRecent(db, res, url);
      if (url.pathname === "/api/search") {
        await handleSearch(db, res, url);
        return;
      }
      if (url.pathname === "/api/scopes") return handleScopes(db, res);
      if (url.pathname === "/api/embeddings") return handleEmbeddings(db, res);
      if (url.pathname === "/api/consolidate") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(JSON.stringify(consolidationJob.state()));
        return;
      }
      if (url.pathname === "/api/memories") return handleMemories(db, res, url);
      if (url.pathname === "/api/graph") return handleGraph(db, res, url);
      const detail = parseDetailPath(url.pathname);
      if (detail === "bad") return json(res, 400, { error: "id mal codificado" });
      if (detail) {
        return detail.layer === "memory" ? handleMemory(db, res, detail.id) : handleTrait(db, res, detail.id);
      }
      if (url.pathname.startsWith("/api/")) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: `endpoint desconocido: ${url.pathname}` }));
        return;
      }
      return serveUi(res, url.pathname);
    }

    res.statusCode = 404;
    res.end("No encontrado");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
  console.log(
    `misMEM HTTP escuchando en http://${HOST}:${PORT} (mcp=/mcp viewer=/viewer)`,
  );
});

const shutdown = (): void => {
  httpServer.close();
  db.close();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
