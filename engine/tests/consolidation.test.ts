import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Database as DB } from "better-sqlite3";
import { openDb } from "../src/store/db.js";
import { capture } from "../src/memory/capture.js";
import { runConsolidation } from "../src/consolidation/run.js";
import { truncateEpisode } from "../src/consolidation/budget.js";
import { LlmFatalError, LlmInvalidJsonError, LlmTruncatedError } from "../src/consolidation/llm.js";

let db: DB;

beforeEach(() => {
  db = openDb(":memory:");
});

const llmCfg = { apiKey: "x", model: "x", baseUrl: "x" };

function captureOld(scope: string, body: string, ageHours: number): string {
  const { id } = capture(db, { scope, body });
  const ts = Date.now() - ageHours * 3600 * 1000;
  db.prepare("UPDATE episodes SET created_at = ? WHERE id = ?").run(ts, id);
  return id;
}

describe("runConsolidation", () => {
  const pendingScopes = (): string[] =>
    (db.prepare("SELECT DISTINCT scope FROM episodes WHERE consolidated_into IS NULL ORDER BY scope").all() as { scope: string }[]).map(
      (r) => r.scope,
    );

  it("skipea scopes con menos episodios que minEpisodes", async () => {
    captureOld("solo", "uno", 48);
    captureOld("solo", "dos", 48);
    const distillFn = vi.fn();

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 3,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.scopes_skipped_too_few).toBe(1);
    expect(summary.memories_created).toBe(0);
  });

  describe("MISMEM_CONSOLIDATION_MIN_AGE_HOURS / MIN_EPISODES from the environment", () => {
    const run = async (): Promise<number> => {
      const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
        const id = /[0-9A-HJKMNP-TV-Z]{26}/.exec(user)?.[0] ?? "";
        return [{ gist: "g", evidence_episode_ids: [id] }];
      });
      const summary = await runConsolidation(db, { llm: llmCfg, distillFn, paretoPrefilter: false, log: () => {} });
      return summary.memories_created;
    };
    afterEach(() => vi.unstubAllEnvs());

    it("a garbage MIN_AGE_HOURS falls back to 24 instead of silently consolidating nothing", async () => {
      for (const n of ["a", "b", "c"]) captureOld("s", `episodio ${n}`, 48);
      vi.stubEnv("MISMEM_CONSOLIDATION_MIN_AGE_HOURS", "abc");
      expect(await run()).toBeGreaterThan(0);
    });

    it("MIN_AGE_HOURS=0 is honoured: a brand-new episode is eligible", async () => {
      // One second old: with age 0 the episode and the cutoff can share a millisecond, and
      // the query is strictly `created_at < cutoff`.
      for (const n of ["a", "b", "c"]) captureOld("s", `episodio ${n}`, 1 / 3600);
      expect(pendingScopes()).toEqual(["s"]);
      expect(await run()).toBe(0); // default 24h: too young
      vi.stubEnv("MISMEM_CONSOLIDATION_MIN_AGE_HOURS", "0");
      expect(await run()).toBeGreaterThan(0);
    });

    it("a garbage or zero MIN_EPISODES falls back to 3", async () => {
      captureOld("s", "uno", 48);
      captureOld("s", "dos", 48);
      for (const raw of ["abc", "0"]) {
        vi.stubEnv("MISMEM_CONSOLIDATION_MIN_EPISODES", raw);
        expect(await run()).toBe(0);
      }
      vi.stubEnv("MISMEM_CONSOLIDATION_MIN_EPISODES", "2");
      expect(await run()).toBeGreaterThan(0);
    });
  });

  it("un ámbito chico que lleva tiempo quieto se consolida igual: si no, queda pendiente para siempre", async () => {
    const lone = captureOld("charla-vieja", "decidimos migrar el hosting a Hetzner por costo", 24 * 20);
    captureOld("activo", "idea suelta de esta semana", 48);
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) =>
      user.includes(lone) ? [{ gist: "Hosting en Hetzner", evidence_episode_ids: [lone] }] : [],
    );

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 3,
      quietDays: 14,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(1);
    expect(summary.memories_created).toBe(1);
    expect(summary.scopes_skipped_too_few).toBe(1);
    expect(pendingScopes()).toEqual(["activo"]);
  });

  it("un ámbito chico con un episodio reciente espera a juntar el mínimo, aunque tenga otro viejo", async () => {
    captureOld("mixto", "algo de hace un mes", 24 * 30);
    captureOld("mixto", "algo de anteayer", 48);
    const distillFn = vi.fn();

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 3,
      quietDays: 14,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.scopes_skipped_too_few).toBe(1);
  });

  it("ignora episodios m\u00e1s nuevos que minAgeHours", async () => {
    capture(db, { scope: "fresh", body: "ahora 1" });
    capture(db, { scope: "fresh", body: "ahora 2" });
    capture(db, { scope: "fresh", body: "ahora 3" });
    const distillFn = vi.fn();

    const summary = await runConsolidation(db, {
      minAgeHours: 24,
      minEpisodesPerScope: 1,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.scopes_seen).toBe(0);
  });

  it("destila y consolida episodios v\u00e1lidos via mock LLM", async () => {
    const ids = [
      captureOld("proj-x", "decidimos usar Zustand", 48),
      captureOld("proj-x", "porque Redux era overkill", 48),
      captureOld("proj-x", "migrar UserStore primero", 48),
    ];

    const distillFn = vi.fn().mockResolvedValue([
      {
        gist: "Decisi\u00f3n: Zustand sobre Redux para state",
        details: "Why: Redux era overkill\nWhere: UserStore primero",
        evidence_episode_ids: ids,
        type: "decision",
        confidence: 0.9,
      },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.memories_created).toBe(1);
    expect(summary.episodes_consolidated).toBe(3);

    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL")
      .get() as { n: number };
    expect(remaining.n).toBe(0);

    const mem = db
      .prepare("SELECT scope, gist, salience FROM memories LIMIT 1")
      .get() as { scope: string; gist: string; salience: number };
    expect(mem.scope).toBe("proj-x");
    expect(mem.salience).toBe(0.9);
  });

  it("'sin se\u00f1al' suma un strike a toda la tanda en vez de mandarla a ruido a la primera", async () => {
    const ids = [
      captureOld("noise", "decidimos migrar el hosting a Hetzner", 48),
      captureOld("noise", "dale", 48),
      captureOld("noise", "listo", 48),
    ];
    const distillFn = vi.fn().mockResolvedValue([]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.memories_created).toBe(0);
    expect(summary.episodes_consolidated).toBe(0);
    expect(summary.episodes_uncited_pending).toBe(3);
    for (const id of ids) {
      const row = db
        .prepare("SELECT consolidated_into, uncited_count FROM episodes WHERE id = ?")
        .get(id) as { consolidated_into: string | null; uncited_count: number };
      expect(row).toEqual({ consolidated_into: null, uncited_count: 1 });
    }
  });

  it("agotados los strikes por 'sin se\u00f1al', la tanda pasa a ruido con salience baja", async () => {
    captureOld("noise", "ok", 48);
    captureOld("noise", "dale", 48);
    captureOld("noise", "listo", 48);
    const distillFn = vi.fn().mockResolvedValue([]);
    const opts = { minEpisodesPerScope: 1, paretoPrefilter: false, uncitedStrikes: 2, llm: llmCfg, distillFn, log: () => {} };

    await runConsolidation(db, opts);
    const summary = await runConsolidation(db, opts);

    expect(summary.memories_created).toBe(1);
    expect(summary.episodes_consolidated).toBe(3);
    const mem = db.prepare("SELECT gist, salience FROM memories LIMIT 1").get() as { gist: string; salience: number };
    expect(mem.gist).toBe("[noise] 3 episodios sin citar en 2 tandas");
    expect(mem.salience).toBeLessThan(0.2);
  });

  it("filtra evidence_episode_ids inv\u00e1lidos (anti-hallucination)", async () => {
    const ids = [
      captureOld("p", "a", 48),
      captureOld("p", "b", 48),
      captureOld("p", "c", 48),
    ];

    const distillFn = vi.fn().mockResolvedValue([
      {
        gist: "memoria con un id inventado",
        evidence_episode_ids: [...ids, "01INVENTADO000000000000000"],
      },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.memories_created).toBe(1);
    expect(summary.episodes_consolidated).toBe(3);
  });

  it("un episodio sin citar queda pendiente con strike, no como ruido, y no se repaga en la corrida", async () => {
    const ids = [
      captureOld("mix", "decidimos usar pnpm en todo el monorepo", 48),
      captureOld("mix", "porque npm duplicaba dependencias", 48),
      captureOld("mix", "jaja dale", 48),
    ];
    const distillFn = vi.fn().mockResolvedValue([
      { gist: "Decisión: pnpm en el monorepo", evidence_episode_ids: [ids[0], ids[1]] },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.episodes_consolidated).toBe(2);
    expect(summary.episodes_uncited_pending).toBe(1);
    // Sending it again in the same run would pay twice for the same episode.
    expect(distillFn).toHaveBeenCalledTimes(1);

    const left = db
      .prepare("SELECT consolidated_into, uncited_count FROM episodes WHERE id = ?")
      .get(ids[2]) as { consolidated_into: string | null; uncited_count: number };
    expect(left.consolidated_into).toBeNull();
    expect(left.uncited_count).toBe(1);
  });

  it("agotados los strikes el episodio sin citar pasa a ruido", async () => {
    const ids = [
      captureOld("mix", "decidimos usar pnpm en todo el monorepo", 48),
      captureOld("mix", "porque npm duplicaba dependencias", 48),
      captureOld("mix", "jaja dale nos vemos", 48),
    ];
    // Always cites the first one it receives: the last stays uncited on every batch.
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      const first = ids.find((id) => user.includes(id));
      return first ? [{ gist: `memoria de ${first}`, evidence_episode_ids: [first] }] : [];
    });
    const opts = {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      uncitedStrikes: 2,
      llm: llmCfg,
      distillFn,
      log: () => {},
    };

    await runConsolidation(db, opts);
    expect(
      (db.prepare("SELECT uncited_count AS n FROM episodes WHERE id = ?").get(ids[2]) as { n: number }).n,
    ).toBe(1);

    await runConsolidation(db, opts);

    const stub = db
      .prepare("SELECT m.gist, m.salience FROM episodes e JOIN memories m ON m.id = e.consolidated_into WHERE e.id = ?")
      .get(ids[2]) as { gist: string; salience: number };
    expect(stub.gist).toBe("[noise] 1 episodio sin citar en 2 tandas");
    expect(stub.salience).toBeLessThan(0.2);
  });

  it("una memoria sin evidencia válida no deja a todos los episodios como ruido por error", async () => {
    const ids = [captureOld("x", "uno con algo", 48), captureOld("x", "dos con algo", 48)];
    const distillFn = vi.fn().mockResolvedValue([
      { gist: "inventada", evidence_episode_ids: ["01INVENTADO000000000000000"] },
      { gist: "real", evidence_episode_ids: [ids[0]] },
    ]);

    await runConsolidation(db, { minEpisodesPerScope: 1, paretoPrefilter: false, llm: llmCfg, distillFn, log: () => {} });

    const gists = db
      .prepare("SELECT m.gist FROM episodes e JOIN memories m ON m.id = e.consolidated_into ORDER BY e.created_at, e.id")
      .all() as { gist: string }[];
    expect(gists.map((g) => g.gist)).toEqual(["real"]);
    const left = db
      .prepare("SELECT consolidated_into, uncited_count FROM episodes WHERE id = ?")
      .get(ids[1]) as { consolidated_into: string | null; uncited_count: number };
    expect(left.consolidated_into).toBeNull();
    expect(left.uncited_count).toBe(1);
  });

  it("si todo lo que devolvió el LLM es inventado, los episodios quedan pendientes", async () => {
    captureOld("y", "uno con algo", 48);
    captureOld("y", "dos con algo", 48);
    const distillFn = vi.fn().mockResolvedValue([
      { gist: "inventada", evidence_episode_ids: ["01INVENTADO000000000000000"] },
    ]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1, paretoPrefilter: false, llm: llmCfg, distillFn, log: () => {},
    });

    expect(summary.episodes_consolidated).toBe(0);
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL")
      .get() as { n: number };
    expect(pending.n).toBe(2);
  });

  it("dryRun no llama al LLM ni crea memorias", async () => {
    captureOld("d", "uno", 48);
    captureOld("d", "dos", 48);
    captureOld("d", "tres", 48);

    const distillFn = vi.fn();
    const summary = await runConsolidation(db, { dryRun: true, distillFn, log: () => {} });

    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.memories_created).toBe(0);
  });

  it("un error fatal del proveedor corta la corrida en vez de repetirse por cada ámbito", async () => {
    for (const scope of ["a", "b", "c"]) {
      for (const n of [1, 2, 3]) captureOld(scope, `decisión ${scope} ${n} sobre la arquitectura`, 48);
    }
    const distillFn = vi.fn().mockRejectedValue(new LlmFatalError("HTTP 402: sin saldo"));

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(1);
    expect(summary.aborted).toBe(true);
    expect(summary.errors).toHaveLength(1);
  });

  it("arma tandas que entran en el presupuesto y vacía el ámbito en la misma corrida", async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => captureOld("grande", `${n} ${"x".repeat(30_000)}`, 48));
    const prompts: string[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      prompts.push(user);
      const batch = ids.filter((id) => user.includes(id));
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      maxPromptChars: 70_000,
      maxEpisodeChars: 40_000,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(prompts.map((p) => ids.filter((id) => p.includes(id)).length)).toEqual([2, 2, 1]);
    expect(prompts.every((p) => p.length < 70_000 + 2_000)).toBe(true);
    expect(summary.episodes_consolidated).toBe(5);
  });

  it("recorta un episodio enorme en vez de mandarlo entero", async () => {
    const ids = [captureOld("enorme", `inicio ${"y".repeat(100_000)} final`, 48)];
    ids.push(captureOld("enorme", "otro episodio con contenido", 48));
    let prompt = "";
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      prompt = user;
      return [{ gist: "resumen", evidence_episode_ids: ids }];
    });

    await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      maxEpisodeChars: 10_000,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(prompt.length).toBeLessThan(12_000);
    expect(prompt).toContain("inicio");
    expect(prompt).toContain("final");
    expect(prompt).toContain("[recortado]");
  });

  it("si la respuesta llega cortada, parte la tanda a la mitad y no pierde episodios", async () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => captureOld("charlas", `charla ${n} con decisiones`, 48));
    const sizes: number[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      const batch = ids.filter((id) => user.includes(id));
      sizes.push(batch.length);
      if (batch.length > 2) throw new LlmTruncatedError("cortada");
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(sizes).toEqual([8, 4, 2, 2, 2, 2]);
    expect(summary.episodes_consolidated).toBe(8);
    expect(summary.scopes_failed).toBe(0);
  });

  it("un JSON mal armado también parte la tanda en vez de perderla", async () => {
    const ids = [1, 2, 3, 4].map((n) => captureOld("json", `nota ${n} con decisiones`, 48));
    const sizes: number[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      const batch = ids.filter((id) => user.includes(id));
      sizes.push(batch.length);
      if (batch.length > 2) throw new LlmInvalidJsonError("JSON inválido");
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1, paretoPrefilter: false, llm: llmCfg, distillFn, log: () => {},
    });

    expect(sizes).toEqual([4, 2, 2]);
    expect(summary.episodes_consolidated).toBe(4);
  });

  const pendingIds = (): string[] =>
    (db.prepare("SELECT id FROM episodes WHERE consolidated_into IS NULL ORDER BY created_at").all() as { id: string }[]).map(
      (r) => r.id,
    );
  const noiseCount = (): number =>
    (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE gist LIKE '[noise]%'").get() as { n: number }).n;

  it.each([
    ["una respuesta cortada", () => new LlmTruncatedError("cortada")],
    ["un JSON inválido", () => new LlmInvalidJsonError("JSON inválido")],
  ])("%s con un solo episodio lo deja pendiente, sin marcarlo ruido, y sigue con el resto", async (_name, fail) => {
    const poison = captureOld("cola", "episodio que el LLM no logra procesar", 48);
    const ok = [
      captureOld("cola", "decidimos usar Zustand para el estado", 47),
      captureOld("cola", "porque Redux era overkill en este repo", 46),
    ];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      if (user.includes(poison)) throw fail();
      const evidence = ok.filter((id) => user.includes(id));
      return [{ gist: "Zustand sobre Redux", evidence_episode_ids: evidence }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(summary.scopes_failed).toBe(0);
    expect(pendingIds()).toEqual([poison]);
    expect(noiseCount()).toBe(0);
    expect(summary.episodes_consolidated).toBe(2);
    expect(summary.episodes_skipped).toBe(1);
  });

  it("un episodio salteado no se reintenta dentro de la misma corrida", async () => {
    const poison = captureOld("uno", "episodio único que no entra", 48);
    const distillFn = vi.fn().mockRejectedValue(new LlmTruncatedError("cortada"));

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(1);
    expect(pendingIds()).toEqual([poison]);
    expect(summary.episodes_skipped).toBe(1);
  });

  it("después de un JSON inválido de un episodio, la tanda siguiente vuelve a llenarse", async () => {
    const poison = captureOld("cola", "veneno con barras que rompen el JSON", 48);
    const rest = [2, 3, 4, 5, 6].map((n) => captureOld("cola", `decisión ${n} sobre el stack elegido`, 48));
    const sizes: number[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      const batch = [poison, ...rest].filter((id) => user.includes(id));
      sizes.push(batch.length);
      if (batch.includes(poison)) throw new LlmInvalidJsonError("JSON inválido");
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(sizes).toEqual([6, 3, 1, 5]);
    expect(summary.episodes_consolidated).toBe(5);
    expect(summary.episodes_skipped).toBe(1);
    expect(summary.scopes_failed).toBe(0);
  });

  it("el tope estrechado por una respuesta cortada no se filtra al ámbito siguiente", async () => {
    const big = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => captureOld("cortado-a", `charla ${n} con decisiones`, 48));
    const small = [1, 2, 3, 4, 5, 6].map((n) => captureOld("cortado-b", `nota ${n} con decisiones`, 48));
    const sizes: number[] = [];
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      const batch = [...big, ...small].filter((id) => user.includes(id));
      sizes.push(batch.length);
      // 8 gets cut, so the scope narrows its cap to 4; a full 6-episode batch still fits.
      if (batch.length > 6) throw new LlmTruncatedError("cortada");
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      maxEpisodesPerBatch: 8,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    // The cap is per scope: the 6 of the second one must ride in a single call, not 4 + 2.
    expect(sizes).toEqual([8, 4, 4, 6]);
    expect(summary.episodes_consolidated).toBe(big.length + small.length);
  });

  it("un episodio salteado en un ámbito no se cuenta como salteado en el siguiente", async () => {
    const poison = captureOld("salta-a", "episodio que el LLM no logra procesar", 48);
    const ok = [1, 2].map((n) => captureOld("salta-a", `decisión ${n} sobre el stack elegido`, 47));
    const later = captureOld("salta-b", "decisión suelta sobre el despliegue", 46);
    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) => {
      if (user.includes(poison)) throw new LlmTruncatedError("cortada");
      const batch = [poison, ...ok, later].filter((id) => user.includes(id));
      return [{ gist: `tanda de ${batch.length}`, evidence_episode_ids: batch }];
    });

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    // Only the poison episode is skipped; a leaked set would make the next scope add it again.
    expect(summary.episodes_skipped).toBe(1);
    expect(pendingIds()).toEqual([poison]);
  });

  it("la suite no le pide vectores al proveedor de embeddings real tras consolidar", async () => {
    const ids = [1, 2].map((n) => captureOld("t", `decisión ${n} sobre el stack elegido`, 48));
    const distillFn = vi.fn().mockResolvedValue([{ gist: "stack", evidence_episode_ids: ids }]);
    const fetchSpy = vi.fn().mockResolvedValue(new Response("no", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await runConsolidation(db, { minEpisodesPerScope: 1, paretoPrefilter: false, llm: llmCfg, distillFn, log: () => {} });
    } finally {
      vi.unstubAllGlobals();
    }

    // The backfill reads the real config: without vitest's env it reaches the developer's embedding server.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("el backfill de la corrida nocturna respeta el tope de 64", async () => {
    const insert = db.prepare(
      "INSERT INTO memories (id, scope, gist, source_episode_ids, created_at) VALUES (?, 's', ?, '[]', ?)",
    );
    for (let i = 0; i < 70; i++) insert.run(`pending-${i}`, `pendiente ${i}`, Date.now());
    const seen: string[] = [];
    const embedFn = vi.fn(async (texts: string[]) => {
      seen.push(...texts);
      return texts.map(() => Float32Array.from([1, 0]));
    });

    await runConsolidation(db, { llm: llmCfg, embedFn, log: () => {} });

    expect(seen).toHaveLength(64);
    const stored = db.prepare("SELECT COUNT(*) AS n FROM memory_embeddings").get() as { n: number };
    expect(stored.n).toBe(64);
  });

  it("respeta el tope de llamadas por corrida y deja el resto para la próxima", async () => {
    const ids: string[] = [];
    for (const scope of ["a", "b", "c"]) {
      for (const n of [1, 2, 3]) ids.push(captureOld(scope, `nota ${scope} ${n} sobre el despliegue`, 48));
    }
    // Cites everything it receives: each call consolidates its whole scope.
    const distillFn = vi.fn().mockResolvedValue([{ gist: "despliegue", evidence_episode_ids: ids }]);

    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: false,
      maxCalls: 2,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(2);
    expect(summary.llm_calls).toBe(2);
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM episodes WHERE consolidated_into IS NULL")
      .get() as { n: number };
    expect(pending.n).toBe(3);
  });

  it("Pareto pre-filter: episodios L0 cortos triviales se marcan como noise sin LLM", async () => {
    captureOld("trivial", "ok", 48);
    captureOld("trivial", "dale", 48);
    captureOld("trivial", "listo", 48);

    const distillFn = vi.fn();
    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: true,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    // All fall into L0 → no LLM call, one stub memory is created.
    expect(distillFn).not.toHaveBeenCalled();
    expect(summary.episodes_dropped_pareto_l0).toBe(3);
    expect(summary.memories_created).toBe(1);
  });

  it("Pareto pre-filter: un hecho corto llega al LLM en vez de caer como ruido", async () => {
    captureOld("corto", "ok", 48);
    const fact = captureOld("corto", "usar pnpm, no npm", 48);

    const distillFn = vi.fn(async (_cfg: unknown, _sys: string, user: string) =>
      user.includes(fact) ? [{ gist: "Se usa pnpm en vez de npm", evidence_episode_ids: [fact] }] : [],
    );
    const summary = await runConsolidation(db, {
      minEpisodesPerScope: 1,
      paretoPrefilter: true,
      llm: llmCfg,
      distillFn,
      log: () => {},
    });

    expect(distillFn).toHaveBeenCalledTimes(1);
    expect(distillFn.mock.calls[0]?.[2]).toContain("usar pnpm, no npm");
    expect(summary.episodes_dropped_pareto_l0).toBe(1);
    const row = db.prepare("SELECT m.gist FROM episodes e JOIN memories m ON m.id = e.consolidated_into WHERE e.id = ?").get(fact) as { gist: string };
    expect(row.gist).toBe("Se usa pnpm en vez de npm");
  });
});

describe("truncateEpisode", () => {
  const body = "a".repeat(50) + "z".repeat(50);

  it("conserva el principio y el final dentro del tope", () => {
    const cut = truncateEpisode(body, 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.startsWith("a")).toBe(true);
    expect(cut.endsWith("z")).toBe(true);
  });

  it("con un tope más chico que la marca de recorte igual respeta el tope", () => {
    const cut = truncateEpisode(body, 5);
    expect(cut).toBe("aaaaa");
  });
});
