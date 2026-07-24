import { describe, it, expect } from "vitest";
import { classify } from "../src/pareto/classifier.js";

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
