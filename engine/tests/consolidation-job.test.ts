import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { ConsolidationJob, JobError } from "../src/consolidation/job.js";

let db: DB;
beforeEach(() => {
  db = openDb(":memory:");
});

const dummy = "x";
const llm = { apiKey: dummy, model: "m", baseUrl: "https://llm.test/v1" };
const config = () => llm;

function captureOld(scope: string, body: string): string {
  const { id } = capture(db, { scope, body });
  db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(Date.now() - 48 * 3_600_000, id);
  return id;
}

describe("ConsolidationJob", () => {
  it("corre en segundo plano y deja log y resumen", async () => {
    const ids = [captureOld("a", "decidimos usar pnpm en todo el monorepo"), captureOld("a", "npm duplicaba dependencias")];
    const distillFn = vi.fn().mockResolvedValue([{ gist: "pnpm en el monorepo", evidence_episode_ids: ids }]);
    const job = new ConsolidationJob(db, config);

    const started = job.start(undefined, { minEpisodesPerScope: 1, paretoPrefilter: false, distillFn });
    expect(started.running).toBe(true);
    await job.finished();

    const state = job.state();
    expect(state.running).toBe(false);
    expect(state.error).toBeNull();
    expect(state.summary).toMatchObject({ memories_created: 1, episodes_consolidated: 2, llm_calls: 1 });
    expect(state.log.some((line) => line.includes("DONE"))).toBe(true);
    expect(state.finished_at).not.toBeNull();
  });

  it("una sola a la vez: la segunda recibe 409", async () => {
    captureOld("a", "algo para consolidar");
    let release: () => void = () => {};
    const distillFn = vi.fn(() => new Promise<[]>((resolve) => (release = () => resolve([]))));
    const job = new ConsolidationJob(db, config);
    job.start(undefined, { minEpisodesPerScope: 1, paretoPrefilter: false, distillFn });

    expect(() => job.start()).toThrow(JobError);
    try {
      job.start();
    } catch (err) {
      expect((err as JobError).status).toBe(409);
    }
    await vi.waitFor(() => expect(distillFn).toHaveBeenCalled());
    release();
    await job.finished();
    expect(job.state().running).toBe(false);
  });

  it("sin clave de proveedor no arranca y lo dice", () => {
    const job = new ConsolidationJob(db, () => {
      throw new Error("Falta DEEPSEEK_API_KEY u OPENROUTER_API_KEY.");
    });
    expect(() => job.start()).toThrow(/DEEPSEEK_API_KEY/);
    expect(job.state().running).toBe(false);
  });

  it("un fallo de la corrida queda como error, no como corrida colgada", async () => {
    const job = new ConsolidationJob(db, config, async () => {
      throw new Error("se cayó la base");
    });
    job.start();
    await job.finished();
    expect(job.state()).toMatchObject({ running: false, error: "se cayó la base", summary: null });
  });

  it("limita la corrida al ámbito pedido", async () => {
    captureOld("a", "del ámbito a");
    captureOld("b", "del ámbito b");
    const distillFn = vi.fn().mockResolvedValue([]);
    const job = new ConsolidationJob(db, config);
    job.start("b", { minEpisodesPerScope: 1, paretoPrefilter: false, distillFn });
    await job.finished();
    expect(job.state().scope).toBe("b");
    expect(distillFn).toHaveBeenCalledTimes(1);
    expect(distillFn.mock.calls[0]?.[2]).toContain("del ámbito b");
    expect(distillFn.mock.calls[0]?.[2]).not.toContain("del ámbito a");
  });
});
