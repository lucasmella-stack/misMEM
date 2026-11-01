import { describe, it, expect } from "vitest";
import { classify } from "../src/consolidation/pareto.js";

describe("Pareto classifier", () => {
  it("texto vacío → L0 importance 0", () => {
    const r = classify("");
    expect(r.importance).toBe(0);
    expect(r.level).toBe(0);
  });

  it("código denso con decisión + sin vecinos → L1+", () => {
    const text = `
class UserStore {
  async function getById(id: string): Promise<User> {
    try { return await db.users.find(id); } catch (e) { throw new Error("nf"); }
  }
}
// Decisión: elegimos Zustand sobre Redux por simplicidad.
`;
    const r = classify(text);
    expect(r.importance).toBeGreaterThan(0.3);
    expect(r.level).toBeGreaterThanOrEqual(1);
  });

  it("texto trivial sin patrones → L0", () => {
    const r = classify("hola que tal");
    expect(r.level).toBe(0);
  });

  it("un hecho corto con un número o tres palabras con contenido no es L0 directo", () => {
    for (const text of [
      "usar pnpm, no npm",
      "Cambiamos la clave de producción",
      "el deploy tarda 40 minutos",
      "puerto SSH del NAS: 2222",
    ]) {
      expect(classify(text, { neighbors: ["otra nota distinta de antes"] }).level).toBeGreaterThan(0);
    }
  });

  it("las palabras de función del rescate no vacían un hecho corto", () => {
    // The rescue list is wider than the one `contentTerms` uses on purpose. If they become
    // the same list again, "hacer", "cada" or "solo" leave these facts with two terms of
    // substance and the prefilter discards them before the LLM, with nobody reading them.
    for (const text of ["hacer backup el viernes", "cada deploy a mano", "solo usar pnpm"]) {
      expect(classify(text).level).toBeGreaterThan(0);
    }
  });

  it("un número suelto no escapa de L0", () => {
    for (const text of ["1", "42", "2026", "ok 2", "1 2 3", "10 20 30"]) {
      expect(classify(text).level).toBe(0);
    }
  });

  it("un número con la palabra que lo explica sí escapa de L0", () => {
    for (const text of ["Node 24", "puerto 5000"]) {
      expect(classify(text).level).toBeGreaterThan(0);
    }
  });

  it("las muletillas cortas siguen siendo L0 sin pasar por el LLM", () => {
    for (const text of ["ok", "dale", "listo", "hola que tal", "ok dale"]) {
      expect(classify(text).level).toBe(0);
    }
  });

  it("una preferencia corta no se descarta como ruido", () => {
    for (const text of ["prefiero Rust para el backend", "dejé de usar npm", "me gusta Vitest"]) {
      expect(classify(text).level).toBeGreaterThan(0);
    }
  });

  it("repetir contenido vecino baja novedad", () => {
    const text = "fix bug in login flow when token expires after refresh";
    const fresh = classify(text);
    const repeated = classify(text, { neighbors: [text] });
    expect(repeated.scores.novelty).toBeLessThan(fresh.scores.novelty);
    expect(repeated.importance).toBeLessThan(fresh.importance);
  });

  it("loss alta sube importance", () => {
    const text = "small note about config";
    const a = classify(text);
    const b = classify(text, { lossHint: 4.5 });
    expect(b.importance).toBeGreaterThan(a.importance);
  });

  it("bloque largo de docs técnicas con decisión → L2/L3", () => {
    const text = `
Decisión arquitectural: migramos de Redux a Zustand. Root cause de la decisión:
Redux requería boilerplate en cada slice, dispatchers y selectors. Zustand permite
crear stores con un solo hook, sin Provider, sin actions. Tradeoff: perdemos las
devtools maduras de Redux pero ganamos velocidad de iteración.

class UserStore {
  async function login(email: string): Promise<Token> {
    try { return await api.post("/login", { email }); }
    catch (e) { throw new AuthError("login failed"); }
  }
  async function logout(): Promise<void> { await api.post("/logout"); }
}

Aprendizaje: nunca importar el store fuera de hooks (rompe SSR en Next.js).
Avoid: side effects en el body del hook. Always: usar selectors específicos para evitar re-renders.
`;
    const r = classify(text);
    expect(r.importance).toBeGreaterThan(0.5);
    expect(r.level).toBeGreaterThanOrEqual(2);
  });

  it("nivel 0 cuando todo es ruido sin densidad ni novedad", () => {
    const text = "hola hola hola";
    const r = classify(text, { neighbors: ["hola hola hola"] });
    expect(r.level).toBe(0);
  });
});
