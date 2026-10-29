import { describe, it, expect, beforeEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/db.js";
import type { ConsolidationJob } from "../src/consolidation/job.js";
import { saveMemoryEmbedding } from "../src/embeddings/store.js";
import { capture, consolidate, crystallize } from "../src/tools.js";
import {
  ForgetConfirmations,
  crystallizeFromUi,
  editMemory,
  forgetMemory,
  handleAction,
  loadAllowDelete,
  unconsolidateMemory,
  writeGuard,
} from "../src/viewer-actions.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

function memoryFrom(scope: string, gist: string, bodies: string[]): { memoryId: string; episodeIds: string[] } {
  const episodeIds = bodies.map((body) => capture(db, { scope, body }).id);
  const { memory_id } = consolidate(db, { scope, gist, source_episode_ids: episodeIds });
  return { memoryId: memory_id, episodeIds };
}

const count = (sql: string, ...args: unknown[]): number => (db.prepare(sql).get(...args) as { n: number }).n;
const noReembed = async () => undefined;

function req(headers: Record<string, string>, method = "POST"): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

describe("writeGuard", () => {
  const ok = { "content-type": "application/json", origin: "http://127.0.0.1:3200", host: "127.0.0.1:3200" };

  it("deja pasar un POST JSON desde el propio origen", () => {
    expect(writeGuard(req(ok))).toBeNull();
  });

  it("rechaza lo que no es POST", () => {
    expect(writeGuard(req(ok, "GET"))?.status).toBe(405);
  });

  it("rechaza otro content-type: un formulario de otra web no necesita preflight", () => {
    expect(writeGuard(req({ ...ok, "content-type": "text/plain" }))?.status).toBe(415);
    expect(writeGuard(req({ ...ok, "content-type": "application/x-www-form-urlencoded" }))?.status).toBe(415);
  });

  it("rechaza sin Origin, con Origin ajeno o mal formado", () => {
    const { origin: _origin, ...noOrigin } = ok;
    expect(writeGuard(req(noOrigin))?.status).toBe(403);
    expect(writeGuard(req({ ...ok, origin: "https://attacker.example" }))?.status).toBe(403);
    expect(writeGuard(req({ ...ok, origin: "http://127.0.0.1:9999" }))?.status).toBe(403);
    expect(writeGuard(req({ ...ok, origin: "null" }))?.status).toBe(403);
  });
});

describe("acciones sobre memorias", () => {
  it("editar cambia el texto y tira el vector viejo", async () => {
    const { memoryId } = memoryFrom("a", "texto viejo", ["e1"]);
    saveMemoryEmbedding(db, memoryId, "m", Float32Array.from([1, 0]));

    const out = await editMemory(db, memoryId, { gist: "  texto nuevo ", details: "más" }, noReembed);
    expect(out).toEqual({ id: memoryId, reembedded: true });
    expect(db.prepare("SELECT gist, details FROM memories WHERE id = ?").get(memoryId)).toEqual({
      gist: "texto nuevo",
      details: "más",
    });
    expect(count("SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?", memoryId)).toBe(0);
    // Y el índice FTS ve el texto nuevo, no el viejo.
    expect(count("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'nuevo'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'viejo'")).toBe(0);
  });

  it("editar sin embedder igual guarda", async () => {
    const { memoryId } = memoryFrom("a", "texto", ["e1"]);
    const out = await editMemory(db, memoryId, { gist: "otro" }, async () => {
      throw new Error("sin ollama");
    });
    expect(out.reembedded).toBe(false);
    expect((db.prepare("SELECT gist FROM memories WHERE id = ?").get(memoryId) as { gist: string }).gist).toBe("otro");
  });

  it("editar con un texto vacío falla", async () => {
    const { memoryId } = memoryFrom("a", "texto", ["e1"]);
    await expect(editMemory(db, memoryId, { gist: "   " }, noReembed)).rejects.toThrow();
  });

  it("deshacer la consolidación devuelve los episodios a pendientes, sin strikes", () => {
    const { memoryId, episodeIds } = memoryFrom("a", "memoria", ["e1", "e2"]);
    db.prepare("UPDATE episodes SET uncited_count = 2 WHERE id = ?").run(episodeIds[0]);

    expect(unconsolidateMemory(db, memoryId)).toEqual({ id: memoryId, episodes_released: 2 });
    expect(count("SELECT COUNT(*) AS n FROM memories WHERE id = ?", memoryId)).toBe(0);
    expect(
      db.prepare("SELECT consolidated_into, uncited_count FROM episodes ORDER BY id").all(),
    ).toEqual([
      { consolidated_into: null, uncited_count: 0 },
      { consolidated_into: null, uncited_count: 0 },
    ]);
  });

  it("olvidar borra la memoria y sus episodios, y nada más", () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1", "e2"]);
    const other = memoryFrom("a", "otra", ["e3"]);
    expect(forgetMemory(db, memoryId)).toEqual({ id: memoryId, episodes_deleted: 2 });
    expect(count("SELECT COUNT(*) AS n FROM memories")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into = ?", other.memoryId)).toBe(1);
  });
});

describe("cristalizar desde la interfaz", () => {
  it("crea el rasgo con memorias del mismo ámbito", () => {
    const a = memoryFrom("a", "uno", ["e1"]).memoryId;
    const b = memoryFrom("a", "dos", ["e2"]).memoryId;
    const out = crystallizeFromUi(db, { scope: "a", name: "patrón", polarity: "light", evidence_memory_ids: [a, b, a] });
    expect(out).toMatchObject({ created: true, strength: 2 });
  });

  it("no acepta memorias que no existen ni de otro ámbito", () => {
    const a = memoryFrom("a", "uno", ["e1"]).memoryId;
    const b = memoryFrom("b", "dos", ["e2"]).memoryId;
    expect(() => crystallizeFromUi(db, { scope: "a", name: "x", evidence_memory_ids: [a, "NOPE"] })).toThrow(
      /no existen: NOPE/,
    );
    expect(() => crystallizeFromUi(db, { scope: "a", name: "x", evidence_memory_ids: [a, b] })).toThrow(
      /otro ámbito/,
    );
  });
});

describe("loadAllowDelete", () => {
  it("sólo se enciende a propósito", () => {
    expect(loadAllowDelete({})).toBe(false);
    expect(loadAllowDelete({ MISMEM_VIEWER_ALLOW_DELETE: "0" })).toBe(false);
    expect(loadAllowDelete({ MISMEM_VIEWER_ALLOW_DELETE: "off" })).toBe(false);
    expect(loadAllowDelete({ MISMEM_VIEWER_ALLOW_DELETE: "1" })).toBe(true);
    expect(loadAllowDelete({ MISMEM_VIEWER_ALLOW_DELETE: " True " })).toBe(true);
  });
});

describe("handleAction", () => {
  interface MockResponse {
    statusCode: number;
    body: string;
    setHeader(): void;
    end(payload?: string): void;
  }
  let clock = 1_000_000;
  let confirmations: ForgetConfirmations;
  let allowDelete: boolean;
  beforeEach(() => {
    confirmations = new ForgetConfirmations(() => clock);
    allowDelete = true;
  });

  interface ActionBody {
    impact?: unknown;
    confirm_token?: string;
    error?: string;
    expires_in?: number;
  }

  async function act(path: string, body: unknown = {}): Promise<{ handled: boolean; status: number; body: ActionBody }> {
    const res: MockResponse = {
      statusCode: 200,
      body: "",
      setHeader() {},
      end(payload) {
        this.body = payload ?? "";
      },
    };
    const handled = await handleAction(db, res as unknown as ServerResponse, path, body, {
      reembed: noReembed,
      allowDelete,
      confirmations,
    });
    return { handled, status: res.statusCode, body: res.body ? (JSON.parse(res.body) as ActionBody) : {} };
  }

  it("despacha cada ruta y da 404 a un id que no existe", async () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1"]);
    expect((await act(`/api/memory/${memoryId}/edit`, { gist: "nueva" })).status).toBe(200);
    expect((await act(`/api/memory/NOPE/forget`)).status).toBe(404);
    expect((await act(`/api/memory/${memoryId}/unconsolidate`)).body).toEqual({ id: memoryId, episodes_released: 1 });
  });

  it("un rasgo sólo se olvida", async () => {
    const m = memoryFrom("a", "memoria", ["e1"]).memoryId;
    const t = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [m] }).trait_id;
    expect((await act(`/api/trait/${t}/edit`)).handled).toBe(false);
    const first = await act(`/api/trait/${t}/forget`);
    expect(first.status).toBe(409);
    expect(first.body.impact).toEqual({ memories_cited: 1 });
    expect((await act(`/api/trait/${t}/forget`, { confirm_token: first.body.confirm_token })).status).toBe(200);
    expect(count("SELECT COUNT(*) AS n FROM traits")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM memories")).toBe(1);
  });

  it("sin el interruptor, los dos forget dan 403 y no borran; lo demás sigue", async () => {
    allowDelete = false;
    const { memoryId } = memoryFrom("a", "memoria", ["e1"]);
    const t = crystallize(db, { scope: "a", name: "rasgo", evidence_memory_ids: [memoryId] }).trait_id;
    const memory = await act(`/api/memory/${memoryId}/forget`);
    expect(memory.status).toBe(403);
    expect(memory.body.error).toMatch(/MISMEM_VIEWER_ALLOW_DELETE/);
    expect((await act(`/api/trait/${t}/forget`)).status).toBe(403);
    expect(count("SELECT COUNT(*) AS n FROM memories")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM traits")).toBe(1);
    expect((await act(`/api/memory/${memoryId}/edit`, { gist: "nueva" })).status).toBe(200);
  });

  it("olvidar una memoria pide confirmación con su impacto y borra sólo con el token", async () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1", "e2"]);
    crystallize(db, { scope: "a", name: "uno", evidence_memory_ids: [memoryId] });
    crystallize(db, { scope: "a", name: "dos", evidence_memory_ids: [memoryId] });
    const first = await act(`/api/memory/${memoryId}/forget`);
    expect(first.status).toBe(409);
    expect(first.body).toMatchObject({ expires_in: 60, impact: { episodes: 2, traits_citing: 2 } });
    expect(first.body.error).toBeUndefined();
    expect(count("SELECT COUNT(*) AS n FROM memories")).toBe(1);
    const second = await act(`/api/memory/${memoryId}/forget`, { confirm_token: first.body.confirm_token });
    expect(second).toMatchObject({ status: 200, body: { id: memoryId, episodes_deleted: 2 } });
    expect(count("SELECT COUNT(*) AS n FROM memories")).toBe(0);
  });

  it("el token es de un solo uso, de ese id y caduca a los 60 s", async () => {
    const a = memoryFrom("a", "una", ["e1"]).memoryId;
    const b = memoryFrom("a", "otra", ["e2"]).memoryId;
    const remaining = () => count("SELECT COUNT(*) AS n FROM memories");

    const forA = (await act(`/api/memory/${a}/forget`)).body.confirm_token;
    const wrongId = await act(`/api/memory/${b}/forget`, { confirm_token: forA });
    expect(wrongId.status).toBe(409);
    expect(wrongId.body.error).toMatch(/caducó/);
    // Se gastó al intentarlo con otro id: tampoco sirve ya para el suyo.
    expect((await act(`/api/memory/${a}/forget`, { confirm_token: forA })).status).toBe(409);
    expect(remaining()).toBe(2);

    const late = (await act(`/api/memory/${a}/forget`)).body.confirm_token;
    clock += 60_000;
    expect((await act(`/api/memory/${a}/forget`, { confirm_token: late })).status).toBe(409);
    expect(remaining()).toBe(2);

    const ok = (await act(`/api/memory/${a}/forget`)).body.confirm_token;
    expect((await act(`/api/memory/${a}/forget`, { confirm_token: ok })).status).toBe(200);
    expect((await act(`/api/memory/${b}/forget`, { confirm_token: ok })).status).toBe(409);
    expect(remaining()).toBe(1);
  });

  it("consolidate validates the scope with the shared Scope rules", async () => {
    const started: Array<string | undefined> = [];
    const job = {
      start: (scope?: string) => {
        started.push(scope);
        return { running: true };
      },
    } as unknown as ConsolidationJob;
    const run = async (body: unknown): Promise<number> => {
      const res = { statusCode: 200, setHeader() {}, end() {} };
      await handleAction(db, res as unknown as ServerResponse, "/api/consolidate", body, { job });
      return res.statusCode;
    };
    expect(await run({ scope: "ok" })).toBe(202);
    expect(await run({})).toBe(202);
    expect(await run({ scope: "" })).toBe(400);
    expect(await run({ scope: "x".repeat(129) })).toBe(400);
    expect(started).toEqual(["ok", undefined]);
  });

  it("/api/crystallize embebe el rasgo que acaba de crear", async () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1"]);
    const seen: string[] = [];
    const res = { statusCode: 200, setHeader() {}, end() {} };
    await handleAction(
      db,
      res as unknown as ServerResponse,
      "/api/crystallize",
      { scope: "a", name: "rasgo de la interfaz", evidence_memory_ids: [memoryId] },
      {
        reembed: noReembed,
        embeddingModel: "fake",
        embedFn: async (texts) => {
          seen.push(...texts);
          return texts.map(() => Float32Array.from([1, 0]));
        },
      },
    );

    expect(res.statusCode).toBe(200);
    expect(seen).toContain("rasgo de la interfaz");
    expect(
      db.prepare("SELECT model FROM layer_embeddings WHERE layer = 'trait'").get(),
    ).toEqual({ model: "fake" });
  });

  it("una entrada inválida es 400 y una ruta desconocida no se despacha", async () => {
    const { memoryId } = memoryFrom("a", "memoria", ["e1"]);
    expect((await act(`/api/memory/${memoryId}/edit`, { gist: "" })).status).toBe(400);
    expect((await act("/api/crystallize", { scope: "a" })).status).toBe(400);
    expect((await act("/api/nada")).handled).toBe(false);
  });
});
