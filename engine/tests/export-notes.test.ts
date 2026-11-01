import { describe, expect, it } from "vitest";
import {
  day,
  episodeNote,
  episodePath,
  link,
  memoryNote,
  memoryPath,
  safeName,
  scopeNote,
  scopePathResolver,
  text,
  traitNote,
  traitPath,
  type NoteEpisode,
  type NoteMemory,
  type NotePaths,
  type NoteTrait,
} from "../src/export/notes.js";

const AT = Date.UTC(2026, 0, 2);

const memory = (id: string, gist: string, scope = "a", details: string | null = null): NoteMemory => ({
  id,
  scope,
  gist,
  details,
  created_at: AT,
});

const trait = (id: string, name: string, evidence: string[], scope = "a"): NoteTrait => ({
  id,
  scope,
  name,
  strength: 2,
  polarity: "neutral",
  evidence_memory_ids: JSON.stringify(evidence),
  updated_at: AT,
});

const episode = (id: string, body: string, scope = "a"): NoteEpisode => ({ id, scope, body, created_at: AT });

// Hand-written paths: these tests pin each note's body, so links must not come from the
// path functions (tested below). The real wiring (which map carries each id, and the scope
// resolver fed by the whole db) is covered by `obsidian.test.ts` through `exportObsidian`.
const PATHS: NotePaths = {
  memory: new Map([
    ["mem-abcdef", "Memorias/una memoria (abcdef)"],
    ["mem-other1", "Memorias/otra memoria (other1)"],
  ]),
  trait: new Map([["trt-123456", "Rasgos/un rasgo (123456)"]]),
  episode: () => "Episodios/2026-01-02 un episodio (987654)",
  scope: (scope: string) => `Ámbitos/${scope}`,
};

describe("nombres y enlaces", () => {
  it("safeName deja un nombre válido en Obsidian y Windows", () => {
    expect(safeName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe("a b c d e f g h i j k l m n");
    expect(safeName("una frase bastante larga que no entra", 20)).toBe("una frase bastante");
    expect(safeName("termina en punto.")).toBe("termina en punto");
    expect(safeName("///")).toBe("sin título");
  });

  it("safeName quita los caracteres de control: un NUL revienta la escritura y los demás rompen el sync", () => {
    expect(safeName("antes\u0000despues")).toBe("antes despues");
    expect(safeName("control \u0001 y \u001b escape\u007f")).toBe("control y escape");
  });

  it("link limpia la etiqueta y no parte el wikilink", () => {
    expect(link("A")).toBe("[[A]]");
    expect(link("A", "a<b|c\\")).toBe("[[A|a b c]]");
    expect(link("A", "una\netiqueta")).toBe("[[A|una etiqueta]]");
  });

  it("las rutas llevan el nombre saneado, el día y el id corto", () => {
    expect(memoryPath(memory("mem-abcdef", "una memoria"))).toBe("Memorias/una memoria (abcdef)");
    expect(traitPath(trait("trt-123456", "un rasgo", []))).toBe("Rasgos/un rasgo (123456)");
    expect(episodePath(episode("ep-987654", "un episodio"))).toBe("Episodios/2026-01-02 un episodio (987654)");
    expect(day(AT)).toBe("2026-01-02");
  });

  it("un ámbito que colisiona o es reservado lleva un hash estable", () => {
    const long = "x".repeat(60);
    const alpha = `${long} alpha`;
    const beta = `${long} beta`;
    const scopePath = scopePathResolver(["a", "CON", alpha, beta]);
    expect(scopePath("a")).toBe("Ámbitos/a");
    expect(scopePath("CON")).toBe("Ámbitos/CON (a3dbc4)");
    expect(scopePath(alpha)).toBe(`Ámbitos/${long} (34eb2b)`);
    expect(scopePath(beta)).toBe(`Ámbitos/${long} (bbd791)`);
  });
});

describe("notas", () => {
  it("la nota de una memoria fija frontmatter, cuerpo, origen, enlaces y ámbito", () => {
    const m = memory("mem-abcdef", "el gist", "a", "usa fuser -k <puerto>/tcp o [s]lidev");
    const other = memory("mem-other1", "otra memoria");
    const t = trait("trt-123456", "un rasgo", [m.id]);
    const note = memoryNote({
      memory: m,
      salience: 1,
      sources: [episode("ep-987654", "probé fuser -k <puerto>/tcp")],
      citing: [t],
      related: [{ id: other.id, score: 0.97 }],
      memories: [m, other],
      paths: PATHS,
      episodes: false,
    });

    expect(note).toBe(
      [
        "---",
        'id: "mem-abcdef"',
        'scope: "a"',
        "salience: 1.00",
        "created: 2026-01-02",
        'tags: [mismem/memoria, "ámbito/a"]',
        "---",
        "",
        "# el gist",
        "",
        "usa fuser -k \\<puerto>/tcp o \\[s\\]lidev",
        "",
        "## Origen",
        "",
        "> 2026-01-02",
        "> probé fuser -k \\<puerto>/tcp",
        "",
        "",
        "## Rasgos que la citan",
        "",
        "- [[Rasgos/un rasgo (123456)|un rasgo]]",
        "",
        "## Parecidas",
        "",
        "- [[Memorias/otra memoria (other1)|otra memoria]] (0.97)",
        "",
        "Ámbito: [[Ámbitos/a|a]]",
        "",
      ].join("\n"),
    );
  });

  it("con episodios como notas propias, la memoria los enlaza", () => {
    const m = memory("mem-abcdef", "una memoria");
    const e = episode("ep-987654", "un episodio");
    const note = memoryNote({
      memory: m,
      salience: 0.5,
      sources: [e],
      citing: [],
      related: [],
      memories: [m],
      paths: PATHS,
      episodes: true,
    });
    expect(note).toContain("- [[Episodios/2026-01-02 un episodio (987654)|2026-01-02 un episodio]]");
    expect(note).not.toContain("> un episodio");
  });

  it("una memoria sin episodios vivos lo dice y una evidencia olvidada no rompe el rasgo", () => {
    const m = memory("mem-abcdef", "una memoria");
    const t = trait("trt-123456", "un rasgo", [m.id, "mem-gone01"]);
    const memoryPart = memoryNote({
      memory: m,
      salience: 1,
      sources: [],
      citing: [t],
      related: [],
      memories: [m],
      paths: PATHS,
      episodes: false,
    });
    expect(memoryPart).toContain("Sin episodios: ya los borró `forget`.");

    const traitPart = traitNote({
      trait: t,
      evidenceIds: [m.id, "mem-gone01"],
      memories: [m],
      paths: PATHS,
    });
    expect(traitPart).toContain("- [[Memorias/una memoria (abcdef)|una memoria]]");
    expect(traitPart).toContain("- Memoria olvidada (mem-gone01)");
  });

  it("el episodio enlaza a la memoria que lo consolidó y una nota de ámbito lista lo suyo", () => {
    const m = memory("mem-abcdef", "una memoria");
    const t = trait("trt-123456", "un rasgo", [m.id]);
    expect(
      episodeNote({ episode: episode("ep-987654", "un episodio"), memory: "Memorias/una memoria (abcdef)" }),
    ).toContain("Consolidado en [[Memorias/una memoria (abcdef)]]");

    const note = scopeNote({ scope: "a", traits: [t], memories: [m], paths: PATHS });
    expect(note).toBe(`${[
      "---",
      'id: "a"',
      'scope: "a"',
      "tags: [mismem/ámbito]",
      "---",
      "",
      "# a",
      "",
      "## Rasgos",
      "",
      "- [[Rasgos/un rasgo (123456)|un rasgo]]",
      "",
      "## Memorias",
      "",
      "- [[Memorias/una memoria (abcdef)|una memoria]]",
    ].join("\n")}\n`);
  });

  it("el texto escapa justo lo que abre un bloque HTML o un enlace roto", () => {
    expect(text("fuser -k <puerto>/tcp y [s]lidev")).toBe("fuser -k \\<puerto>/tcp y \\[s\\]lidev");
  });
});
