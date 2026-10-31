// HTTP dispatch: Host, /healthz, /mcp, the viewer and its API. Kept out of server-http.ts, which
// listens on import, so it can be tested without a port; dependencies come in as arguments, and
// the order (Host, healthz, /mcp, viewer, POST, method, routes, 404) is the contract.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import type { ConsolidationJob } from "../consolidation/job.js";
import { BodyTooLargeError, InvalidJsonError, isJsonContentType, readJsonBody } from "./body.js";
import { checkBasicAuth, type BasicCredentials } from "./guard.js";
import { handleLogin, type LoginAttempts } from "./login.js";
import { SESSION_COOKIE, readCookie, verifySession } from "./session.js";
import { hostAllowed } from "./host.js";
import { json, jsonBare, jsonPlain, methodNotAllowed, notFound, payloadTooLarge, unauthorized } from "./respond.js";
import { handleGraph, handleMemories, handleMemory, handleScopes, handleTrait, parseDetailPath } from "./viewer/api.js";
import {
  ACTION_MAX_BODY_BYTES,
  type ForgetConfirmations,
  handleAction,
  writeGuard,
} from "./viewer/actions.js";
import { handleRecent, handleSearch, handleStats } from "./viewer/read.js";

export interface HttpRoutesDeps {
  db: DB;
  auth: BasicCredentials | null;
  /** `MISMEM_ALLOWED_HOSTS`: Host names accepted besides loopback when there is no auth. */
  allowedHosts: readonly string[];
  /** Cap for the POST /mcp body (`MISMEM_HTTP_MAX_BODY_BYTES`). */
  maxBodyBytes: number;
  /** The consolidation run the interface starts: one at a time per process. */
  job: ConsolidationJob;
  allowDelete: boolean;
  confirmations: ForgetConfirmations;
  /** Answers /mcp once authorized and with the body read; the transport lives in the root. */
  handleMcp: (req: IncomingMessage, res: ServerResponse, parsedBody: unknown) => Promise<void>;
  /** The compiled interface; it lives in the root because it reads dist/ui. */
  serveUi: (res: ServerResponse, pathname: string) => void;
  /** Failed sign-ins, so the password cannot be tried over and over. */
  attempts: LoginAttempts;
  /** The sign-in page's stylesheet, served apart because the CSP forbids inline scripts. */
  loginCss: string;
  /** Images the sign-in page needs, by served path: it cannot reach anything under /viewer. */
  loginAssets: ReadonlyMap<string, Buffer>;
}

export type RequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createRequestHandler(deps: HttpRoutesDeps): RequestHandler {
  const { db, auth, allowedHosts, maxBodyBytes, job, allowDelete, confirmations, handleMcp, serveUi } = deps;
  const { attempts, loginCss, loginAssets } = deps;

  return async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host, { auth: auth !== null, extra: allowedHosts })) {
        res.statusCode = 403;
        res.end("Host no permitido");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (url.pathname === "/healthz") {
        jsonBare(res, 200, { status: "ok", service: "mismem" });
        return;
      }

      if (url.pathname === "/mcp") {
        if (!checkBasicAuth(req.headers.authorization, auth)) {
          unauthorized(res);
          return;
        }
        let parsedBody: unknown;
        if (req.method === "POST") {
          // Before reading a byte: the SDK throws 415 anyway, but only after parsing.
          if (!isJsonContentType(req.headers["content-type"])) {
            jsonBare(res, 415, {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Tipo de contenido no soportado: Content-Type debe ser application/json",
              },
              id: null,
            });
            return;
          }
          try {
            parsedBody = await readJsonBody(req, maxBodyBytes);
          } catch (err) {
            if (err instanceof BodyTooLargeError) {
              payloadTooLarge(res);
              return;
            }
            if (err instanceof InvalidJsonError) {
              jsonBare(res, 400, {
                jsonrpc: "2.0",
                error: { code: -32700, message: "Error de parseo" },
                id: null,
              });
              return;
            }
            throw err;
          }
        }
        await handleMcp(req, res, parsedBody);
        return;
      }

      // Sign-in, before the guard below: there would be no way in otherwise.
      if (await handleLogin(req, res, url.pathname, { auth, attempts, css: loginCss, assets: loginAssets })) return;

      // Viewer and its API. Basic still works, for a script or a client that already sends it;
      // a person gets the form instead of the browser's dialog. /mcp above never sees the
      // cookie: an MCP client cannot fill a form, and a session is not a key to the tools.
      if (
        url.pathname === "/viewer" ||
        url.pathname.startsWith("/viewer/") ||
        url.pathname === "/" ||
        url.pathname.startsWith("/api/")
      ) {
        const signedIn =
          checkBasicAuth(req.headers.authorization, auth) ||
          verifySession(readCookie(req.headers.cookie, SESSION_COOKIE), auth);
        if (!signedIn) {
          // The API answers 401 so the other side reads a clean error instead of parsing HTML.
          if (url.pathname.startsWith("/api/")) {
            unauthorized(res);
            return;
          }
          res.statusCode = 302;
          res.setHeader("location", "/login");
          res.end();
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
          const actionOpts = { job, allowDelete, confirmations };
          if (await handleAction(db, res, url.pathname, body, actionOpts)) return;
          res.statusCode = 404;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ error: `acción desconocida: ${url.pathname}` }));
          return;
        }
        if (req.method !== "GET") {
          methodNotAllowed(res);
          return;
        }
        if (url.pathname === "/api/stats") return handleStats(db, res);
        if (url.pathname === "/api/recent") return handleRecent(db, res, url);
        if (url.pathname === "/api/search") {
          await handleSearch(db, res, url);
          return;
        }
        if (url.pathname === "/api/scopes") return handleScopes(db, res);
        if (url.pathname === "/api/consolidate") {
          json(res, 200, job.state());
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
          jsonPlain(res, 404, { error: `endpoint desconocido: ${url.pathname}` });
          return;
        }
        return serveUi(res, url.pathname);
      }

      notFound(res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[mcp]", err);
      if (!res.headersSent) {
        jsonBare(res, 500, { error: message });
      } else {
        res.end();
      }
    }
  };
}
