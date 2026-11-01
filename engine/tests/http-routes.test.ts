import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { ConsolidationJob } from "../src/consolidation/job.js";
import { ACTION_MAX_BODY_BYTES, ForgetConfirmations } from "../src/http/viewer/actions.js";
import { LoginAttempts } from "../src/http/login.js";
import { createRequestHandler, type HttpRoutesDeps, type RequestHandler } from "../src/http/routes.js";
import { openDb } from "../src/store/db.js";

// The dispatch is tested here without opening a port: server-http.test.ts covers the
// real process (bind, auth and Host), and this file pins the order of the checks.

const AUTH = { user: "brain", pass: "s3cret" };
const basic = (user: string, pass: string): string => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
  /** How many times `end` was called: the dispatch catch closes a response already sent. */
  endCount: number;
  setHeader(name: string, value: string): void;
  end(payload?: string): void;
}

function mockRes(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    headersSent: false,
    endCount: 0,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      // ServerResponse sets headersSent on end and a second end does not rewrite the body.
      this.endCount++;
      this.headersSent = true;
      this.body = payload ?? this.body;
    },
  };
}

async function request(
  handler: RequestHandler,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: readonly string[] } = {},
): Promise<MockResponse> {
  const res = mockRes();
  // readJsonBody listens for "data"/"end": a Readable is the minimal IncomingMessage
  // stand-in with a body. Without `body` nothing is emitted, as in a GET.
  const req = Object.assign(Readable.from((opts.body ?? []).map((chunk) => Buffer.from(chunk))), {
    method: opts.method ?? "GET",
    url: path,
    headers: { host: "localhost", ...opts.headers },
  });
  await handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  return res;
}

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

function makeHandler(overrides: Partial<HttpRoutesDeps> = {}): RequestHandler {
  return createRequestHandler({
    db,
    auth: AUTH,
    allowedHosts: [],
    maxBodyBytes: 1024,
    job: new ConsolidationJob(db),
    allowDelete: false,
    confirmations: new ForgetConfirmations(),
    handleMcp: async () => {
      throw new Error("el test no debe llegar a /mcp");
    },
    serveUi: (res) => {
      res.statusCode = 200;
      res.end("ui");
    },
    attempts: new LoginAttempts(),
    loginCss: "body{}",
    loginAssets: new Map(),
    ...overrides,
  });
}

describe("http/routes: orden y respuestas", () => {
  it("rechaza un Host no permitido antes que nada, también en /healthz", async () => {
    // Without auth the Host is the only guard: it must beat /healthz and the API.
    const handler = makeHandler({ auth: null });
    for (const path of ["/healthz", "/api/stats"]) {
      const res = await request(handler, path, { headers: { host: "evil.example.com" } });
      expect(res.statusCode, path).toBe(403);
      expect(res.body).toBe("Host no permitido");
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }
  });

  it("sirve /healthz sin auth", async () => {
    const res = await request(makeHandler({ auth: null }), "/healthz");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(res.body)).toEqual({ status: "ok", service: "mismem" });
  });

  it("devuelve 401 con el reto en /api cuando hay auth y faltan credenciales", async () => {
    const res = await request(makeHandler(), "/api/stats");
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Basic realm="misMEM"');
    expect(res.body).toBe("No autorizado");
  });

  it("devuelve 405 para un método que no es GET ni POST en /api", async () => {
    const res = await request(makeHandler(), "/api/stats", {
      method: "PUT",
      headers: { authorization: basic(AUTH.user, AUTH.pass) },
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBe("GET, POST");
    expect(res.body).toBe("Método no permitido");
  });

  it("devuelve 404 JSON para un endpoint /api desconocido", async () => {
    const res = await request(makeHandler(), "/api/nope", {
      headers: { authorization: basic(AUTH.user, AUTH.pass) },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(JSON.parse(res.body)).toEqual({ error: "endpoint desconocido: /api/nope" });
  });

  it("devuelve 404 de texto fuera del visor", async () => {
    const res = await request(makeHandler({ auth: null }), "/nope");
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("No encontrado");
    expect(res.headers["content-type"]).toBeUndefined();
  });
});

// The two 413s cannot move to another file: they share the `request` the handler builds.
describe("http/routes: /api/topics", () => {
  const onAngle = (degrees: number): Float32Array => {
    const r = (degrees * Math.PI) / 180;
    return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
  };

  it("devuelve las islas semánticas con su puerta de entrada", async () => {
    for (const [id, gist, deg, sal] of [
      ["a", "arquitectura de Daimon", 0, 0.5],
      ["b", "Daimon en traefik", 8, 0.9],
      ["c", "llevar el gato al veterinario", 90, 0.5],
    ] as const) {
      db.prepare(
        "INSERT INTO memories (id, scope, gist, source_episode_ids, salience, created_at) VALUES (?,'s',?,'[]',?,0)",
      ).run(id, gist, sal);
      const vec = onAngle(deg);
      db.prepare(
        "INSERT INTO memory_embeddings (memory_id, model, dims, vec, created_at) VALUES (?,'m',4,?,0)",
      ).run(id, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
    }

    const res = await request(makeHandler({ auth: null }), "/api/topics?min_score=0.9");

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      topics: Array<{ size: number; entry: { id: string } }>;
      alone: number;
      considered: number;
    };
    expect(body.considered).toBe(3);
    expect(body.alone).toBe(1);
    expect(body.topics).toHaveLength(1);
    expect(body.topics[0]?.size).toBe(2);
    expect(body.topics[0]?.entry.id).toBe("b");
  });

  it("un min_score fuera de rango o ilegible cae al valor por defecto", async () => {
    const handler = makeHandler({ auth: null });
    for (const raw of ["abc", "-1", "9"]) {
      const res = await request(handler, `/api/topics?min_score=${raw}`);
      expect(res.statusCode, raw).toBe(200);
      expect((JSON.parse(res.body) as { minScore: number }).minScore, raw).toBe(0.85);
    }
  });
});

describe("http/routes: cuerpo demasiado grande (413)", () => {
  it("cierra la conexión en /mcp y manda el texto de respond.payloadTooLarge", async () => {
    // The cap is lowered so it does not depend on makeHandler's default.
    const res = await request(makeHandler({ maxBodyBytes: 16 }), "/mcp", {
      method: "POST",
      headers: {
        authorization: basic(AUTH.user, AUTH.pass),
        "content-type": "application/json",
      },
      // Without Content-Length the cut happens while reading the chunks.
      body: ["x".repeat(17)],
    });
    expect(res.statusCode).toBe(413);
    // Without this the client would keep writing into a socket nobody drains.
    expect(res.headers.connection).toBe("close");
    expect(res.headers["content-type"]).toBeUndefined();
    expect(res.body).toBe("Cuerpo demasiado grande");
  });

  it("en una acción de /api responde JSON y también cierra la conexión", async () => {
    const res = await request(makeHandler(), "/api/crystallize", {
      method: "POST",
      headers: {
        authorization: basic(AUTH.user, AUTH.pass),
        "content-type": "application/json",
        origin: "http://localhost",
      },
      body: ["x".repeat(ACTION_MAX_BODY_BYTES + 1)],
    });
    expect(res.statusCode).toBe(413);
    expect(res.headers.connection).toBe("close");
    expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.body).toBe('{"error":"cuerpo demasiado grande"}');
  });
});

describe("http/routes: error no controlado (500)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("responde el JSON sin charset y deja el error en stderr", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(
      makeHandler({
        handleMcp: async () => {
          throw new Error("boom");
        },
      }),
      "/mcp",
      { headers: { authorization: basic(AUTH.user, AUTH.pass) } },
    );
    expect(res.statusCode).toBe(500);
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.headers["cache-control"]).toBeUndefined();
    expect(res.body).toBe('{"error":"boom"}');
    // The reason goes to the client and the log: that tag is the only trace it leaves.
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[0]).toBe("[mcp]");
  });

  it("con las cabeceras ya enviadas sólo cierra la respuesta", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(
      makeHandler({
        handleMcp: async (_req, response) => {
          response.end("parcial");
          throw new Error("tarde");
        },
      }),
      "/mcp",
      { headers: { authorization: basic(AUTH.user, AUTH.pass) } },
    );
    // A JSON error here would corrupt the body that already went out.
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({});
    expect(res.body).toBe("parcial");
    expect(res.endCount).toBe(2);
  });
});

describe("http/routes: el formulario de sesión", () => {
  const cookieDe = (res: MockResponse): string => {
    const header = res.headers["set-cookie"] ?? "";
    return header.slice(0, header.indexOf(";"));
  };

  it("sin credenciales y sin sesión, el visor manda al formulario en vez del diálogo del navegador", async () => {
    const res = await request(makeHandler(), "/viewer");

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
  });

  it("la API sigue respondiendo 401, que es lo que un script espera", async () => {
    // A redirect to HTML would turn a clean 401 into a parse error on the other side.
    const res = await request(makeHandler(), "/api/stats");

    expect(res.statusCode).toBe(401);
  });

  it("el formulario se sirve sin credenciales, o no habría forma de entrar", async () => {
    const res = await request(makeHandler(), "/login");

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
  });

  it("con la contraseña correcta deja una cookie y lleva al visor", async () => {
    const res = await request(makeHandler(), "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: [`usuario=${AUTH.user}&clave=${encodeURIComponent(AUTH.pass)}`],
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/viewer");
    expect(res.headers["set-cookie"]).toContain("HttpOnly");
    expect(res.headers["set-cookie"]).toContain("SameSite=Strict");
  });

  it("con la contraseña equivocada no deja cookie y no dice cuál de los dos campos falló", async () => {
    const res = await request(makeHandler(), "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: ["usuario=brain&clave=la-que-no-es"],
    });

    // Back to the form with a flag, never saying which of the two fields was wrong.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login?error=1");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("una sesión válida abre el visor y la API sin volver a pedir la clave", async () => {
    const handler = makeHandler();
    const entrada = await request(handler, "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: [`usuario=${AUTH.user}&clave=${encodeURIComponent(AUTH.pass)}`],
    });
    const cookie = cookieDe(entrada);

    expect((await request(handler, "/viewer", { headers: { cookie } })).statusCode).toBe(200);
    expect((await request(handler, "/api/stats", { headers: { cookie } })).statusCode).toBe(200);
  });

  it("la cookie NO abre /mcp: un cliente MCP manda Basic, y una sesión no es una llave de herramientas", async () => {
    const handler = makeHandler();
    const entrada = await request(handler, "/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: [`usuario=${AUTH.user}&clave=${encodeURIComponent(AUTH.pass)}`],
    });

    const res = await request(handler, "/mcp", { headers: { cookie: cookieDe(entrada) } });
    expect(res.statusCode).toBe(401);
  });

  it("cerrar sesión vence la cookie", async () => {
    const res = await request(makeHandler(), "/logout", { method: "POST" });

    expect(res.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("tras varios intentos fallidos deja de probar la clave y responde 429", async () => {
    const handler = makeHandler();
    const intento = () =>
      request(handler, "/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: ["usuario=brain&clave=la-que-no-es"],
      });

    let ultima = await intento();
    for (let i = 0; i < 20 && ultima.statusCode !== 429; i++) ultima = await intento();

    expect(ultima.statusCode).toBe(429);
  });

  it("sin MISMEM_AUTH_* no hay formulario: el visor es abierto y pedir sesión confundiría", async () => {
    const handler = makeHandler({ auth: null });

    expect((await request(handler, "/viewer")).statusCode).toBe(200);
    expect((await request(handler, "/login")).statusCode).toBe(404);
  });
});

describe("http/routes: salir desde el visor", () => {
  it("dice si hay una sesión que cerrar", async () => {
    // Without credentials the viewer is open and a "salir" button would promise something that
    // does not exist, so the interface has to be able to tell the two apart.
    const conClave = JSON.parse((await request(makeHandler(), "/api/session", {
      headers: { authorization: basic(AUTH.user, AUTH.pass) },
    })).body) as { active?: boolean };
    const sinClave = JSON.parse((await request(makeHandler({ auth: null }), "/api/session")).body) as {
      active?: boolean;
    };

    expect(conClave.active).toBe(true);
    expect(sinClave.active).toBe(false);
  });

  it("cerrar sesión vuelve al formulario con la cookie vencida", async () => {
    const res = await request(makeHandler(), "/logout", { method: "POST" });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/login");
    expect(res.headers["set-cookie"]).toContain("Max-Age=0");
  });
});
