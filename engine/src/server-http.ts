#!/usr/bin/env node
// HTTP MCP server (Streamable HTTP): reads the environment, opens the database, composes the
// handler and listens. The dispatch lives in `http/routes.ts`; the environment table is in
// DEPLOY.md.
import { createServer as createHttpServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDefaultDb } from "./store/db.js";
import { parseHostList } from "./http/host.js";
import { loadMaxBodyBytes } from "./http/body.js";
import { bindHost, httpPort, loadAuth } from "./http/guard.js";
import { LoginAttempts } from "./http/login.js";
import { LOGIN_CSS } from "./http/login-css.js";
import { createRequestHandler } from "./http/routes.js";
import { createServer } from "./server-core.js";
import { loginAssets, serveUi } from "./viewer-static.js";
import { ForgetConfirmations, loadAllowDelete } from "./http/viewer/actions.js";
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

const db = openDefaultDb();
// The consolidation run started from the interface: one at a time per process.
const consolidationJob = new ConsolidationJob(db);
const ALLOW_DELETE = loadAllowDelete();
const forgetConfirmations = new ForgetConfirmations();

const handler = createRequestHandler({
  attempts: new LoginAttempts(),
  loginCss: LOGIN_CSS,
  loginAssets: loginAssets(),
  db,
  auth: AUTH,
  allowedHosts: ALLOWED_HOSTS,
  maxBodyBytes: MAX_BODY_BYTES,
  job: consolidationJob,
  allowDelete: ALLOW_DELETE,
  confirmations: forgetConfirmations,
  // Stateless: every request is independent, with its own server and transport, as in the
  // SDK's simpleStatelessStreamableHttp.ts example.
  handleMcp: async (req, res, parsedBody) => {
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
  },
  serveUi,
});

const httpServer = createHttpServer(handler);

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

