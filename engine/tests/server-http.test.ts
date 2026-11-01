import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

// server-http.ts listens on import and reads its env at module load, so the only honest test of
// "does the server bind bindHost() and enforce auth/Host" is a real child process.

const ENGINE_ROOT = join(import.meta.dirname, "..");
const AUTH = { user: "brain", pass: "s3cret" };
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

interface Running {
  port: number;
  child: ChildProcess;
  log: () => string;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

interface Reply {
  status: number;
  body: string;
}

// Short on purpose: a firewall that drops packets or a hung child must fail fast, not hang the suite.
const IO_TIMEOUT_MS = 3_000;
const KILL_GRACE_MS = 3_000;

// node:http, not fetch: undici forbids overriding the Host header, which is the point of one test.
function send(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers, timeout: IO_TIMEOUT_MS },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.once("timeout", () => req.destroy(new Error(`no answer from ${path} in ${IO_TIMEOUT_MS} ms`)));
    req.once("error", reject);
    req.end(opts.body);
  });
}

// Every child is recorded the moment it spawns, so afterAll can kill it even if startup of another
// server (or of this one) failed and its handle never reached a test.
const children: ChildProcess[] = [];
const running = (c: ChildProcess): boolean => c.exitCode === null && c.signalCode === null;

async function stop(child: ChildProcess): Promise<void> {
  if (!running(child)) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
  await exited;
  clearTimeout(timer);
}

async function startOnce(dir: string, extraEnv: Record<string, string>): Promise<Running> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {};
  // Start from a clean MISMEM_* slate: the developer's own config must not leak into the child.
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("MISMEM_")) env[k] = v;
  Object.assign(env, {
    MISMEM_DB: join(dir, `mem-${port}.db`),
    MISMEM_HTTP_PORT: String(port),
    MISMEM_EMBEDDINGS: "off",
    ...extraEnv,
  });
  // node --import tsx keeps a single process, so killing the child really stops the server.
  const child = spawn(process.execPath, ["--import", "tsx", "src/server-http.ts"], {
    cwd: ENGINE_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  let out = "";
  child.stdout?.on("data", (c: Buffer) => (out += c.toString()));
  child.stderr?.on("data", (c: Buffer) => (out += c.toString()));
  let exited = false;
  child.once("exit", () => (exited = true));

  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exited) throw new StartupError(`server exited before listening:\n${out}`, out);
    try {
      if ((await send(port, "/healthz")).status === 200) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop(child);
      throw new StartupError(`server did not answer /healthz in time:\n${out}`, out);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return { port, child, log: () => out };
}

class StartupError extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
  }
}

// freePort() releases the port before the child binds it, so another process can grab it in between.
// That shows up as EADDRINUSE in the child's stderr: retry with a new port, nothing else.
async function startServer(dir: string, extraEnv: Record<string, string>): Promise<Running> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await startOnce(dir, extraEnv);
    } catch (err) {
      const portTaken = err instanceof StartupError && err.output.includes("EADDRINUSE");
      if (!portTaken || attempt >= 3) throw err;
    }
  }
}

const mcpInit = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});
const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream" };

let dir: string;
let open: Running;
let secured: Running;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "mismem-http-"));
  // allSettled: if one start fails, wait for the other to finish spawning so afterAll can kill it too.
  const started = await Promise.allSettled([
    startServer(dir, {}),
    startServer(dir, { MISMEM_AUTH_USER: AUTH.user, MISMEM_AUTH_PASS: AUTH.pass }),
  ]);
  for (const r of started) if (r.status === "rejected") throw r.reason;
  [open, secured] = started.map((r) => (r as PromiseFulfilledResult<Running>).value) as [Running, Running];
}, 60_000);

afterAll(async () => {
  await Promise.all(children.map(stop));
  rmSync(dir, { recursive: true, force: true });
});

describe("server-http without auth", () => {
  it("answers /healthz on loopback", async () => {
    const r = await send(open.port, "/healthz");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ status: "ok", service: "mismem" });
  });

  it("binds loopback only, as bindHost() promises", async () => {
    expect(open.log()).toContain(`http://127.0.0.1:${open.port}`);
  });

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

  it.skipIf(!lanIp)("refuses connections on a non-loopback local address", async (ctx) => {
    const code = await new Promise<string>((resolve) => {
      const sock = connect({ host: lanIp!, port: open.port });
      sock.setTimeout(IO_TIMEOUT_MS, () => {
        sock.destroy();
        resolve("TIMEOUT");
      });
      sock.once("connect", () => {
        sock.destroy();
        resolve("CONNECTED");
      });
      sock.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? "ERR"));
    });
    // A firewall that drops the packets gives no answer: that says nothing about the bind address.
    if (code === "TIMEOUT") ctx.skip();
    expect(code).toBe("ECONNREFUSED");
  });

  it("rejects a Host header that is not loopback with 403", async () => {
    const r = await send(open.port, "/healthz", { headers: { host: "evil.example.com" } });
    expect(r.status).toBe(403);
  });

  it("accepts loopback Host names", async () => {
    const r = await send(open.port, "/healthz", { headers: { host: `localhost:${open.port}` } });
    expect(r.status).toBe(200);
  });

  it("serves /mcp without credentials", async () => {
    const r = await send(open.port, "/mcp", { method: "POST", headers: mcpHeaders, body: mcpInit });
    expect(r.status).toBe(200);
    expect(r.body).toContain("mismem");
  });

  it("returns 415 for a non-JSON POST /mcp and 404 for an unknown path", async () => {
    const bad = await send(open.port, "/mcp", { method: "POST", headers: { "content-type": "text/plain" }, body: "x" });
    expect(bad.status).toBe(415);
    expect((await send(open.port, "/nope")).status).toBe(404);
  });
});

describe("server-http with MISMEM_AUTH_USER/PASS", () => {
  it("keeps /healthz open", async () => {
    expect((await send(secured.port, "/healthz")).status).toBe(200);
  });

  it("returns 401 on /mcp and /api without credentials: a caller reads an error, not HTML", async () => {
    for (const path of ["/mcp", "/api/stats"]) {
      const post = path === "/mcp";
      const r = await send(secured.port, path, post ? { method: "POST", headers: mcpHeaders, body: mcpInit } : {});
      expect(r.status, path).toBe(401);
    }
  });

  it("sends a person to the form instead of the browser's dialog", async () => {
    // http.request does not follow redirects, so the 302 arrives as it is.
    const r = await send(secured.port, "/viewer");

    expect(r.status).toBe(302);
  });

  it("returns 401 for wrong credentials", async () => {
    const r = await send(secured.port, "/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, authorization: basic(AUTH.user, "wrong") },
      body: mcpInit,
    });
    expect(r.status).toBe(401);
  });

  it("lets the right credentials through to the MCP handler", async () => {
    const r = await send(secured.port, "/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, authorization: basic(AUTH.user, AUTH.pass) },
      body: mcpInit,
    });
    expect(r.status).toBe(200);
    expect(r.body).toContain("mismem");
  });

  it("lets the right credentials through to the API", async () => {
    const r = await send(secured.port, "/api/stats", { headers: { authorization: basic(AUTH.user, AUTH.pass) } });
    expect(r.status).toBe(200);
  });
});
