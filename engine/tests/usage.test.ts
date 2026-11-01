import { describe, it, expect } from "vitest";
import { formatInjection } from "../src/hooks/inject.js";
import {
  assistantReply,
  injectedMemories,
  lastTurn,
  overlap,
  recalledMemories,
  usedMemoryIds,
} from "../src/hooks/usage.js";

const user = (text: string) => ({ type: "user", message: { content: [{ type: "text", text }] } });
const assistant = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});
const toolResult = (payload: unknown) => ({
  type: "user",
  message: {
    content: [
      { type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: JSON.stringify(payload) }] },
    ],
  },
});
const hits = (...rows: Array<{ layer: string; id: string; text: string }>) => ({ hits: rows });

describe("lastTurn", () => {
  it("corta en el último mensaje escrito por la persona", () => {
    const lines = [user("vieja"), assistant("vieja"), user("nueva"), assistant("nueva")];
    expect(lastTurn(lines)).toEqual([lines[2], lines[3]]);
  });

  it("un mensaje que sólo trae tool_result no abre un turno nuevo", () => {
    const lines = [user("pregunta"), toolResult(hits()), assistant("respuesta")];
    expect(lastTurn(lines)).toHaveLength(3);
  });
});

describe("recalledMemories", () => {
  it("toma sólo la capa memory y no repite", () => {
    const lines = [
      toolResult(hits(
        { layer: "memory", id: "m1", text: "el deploy usa docker compose" },
        { layer: "episode", id: "e1", text: "un episodio suelto" },
        { layer: "trait", id: "t1", text: "un rasgo" },
      )),
      toolResult(hits({ layer: "memory", id: "m1", text: "el deploy usa docker compose" })),
    ];
    expect(recalledMemories(lines)).toEqual([{ id: "m1", text: "el deploy usa docker compose" }]);
  });

  it("un resultado que no es de recall no aporta nada", () => {
    expect(recalledMemories([toolResult({ ok: true })])).toEqual([]);
  });
});

describe("usedMemoryIds", () => {
  const usado = { id: "usado", text: "el deploy de florfitt usa docker compose con traefik" };
  const ignorado = { id: "ignorado", text: "la receta del chimichurri lleva perejil y ajo" };

  it("se queda con el recuerdo cuyas palabras reaparecen en la respuesta", () => {
    const reply = "Para el deploy de florfitt tenés docker compose detrás de traefik, como quedó definido.";
    expect(usedMemoryIds([usado, ignorado], reply)).toEqual(["usado"]);
  });

  it("una respuesta vacía no usa nada", () => {
    expect(usedMemoryIds([usado], "")).toEqual([]);
  });

  it("una sola palabra compartida no alcanza aunque la fracción sea alta", () => {
    // Measured on 898 memories put in front over eight days: a single word in common passes
    // by chance about as often as it passes for a reason.
    const corto = { id: "corto", text: "docker" };
    expect(overlap(corto.text, "docker").fraction).toBe(1);
    expect(usedMemoryIds([corto], "docker")).toEqual([]);
  });

  it("dos palabras distintivas compartidas sí alcanzan", () => {
    // The floor used to be three, which left most turns writing a single memory, and a pair
    // needs two in the same turn: that is what `co_use` is built from.
    const dos = { id: "dos", text: "usa docker" };
    expect(usedMemoryIds([dos], "el servicio usa docker detrás del proxy")).toEqual(["dos"]);
  });

  it("las palabras vacías no cuentan como solapamiento", () => {
    const reply = "de la que el en los una para por con sobre";
    expect(usedMemoryIds([usado, ignorado], reply)).toEqual([]);
  });
});

describe("injectedMemories", () => {
  // Claude Code stores a hook's additionalContext this way, not as tool_result.
  const adjunto = (texto: unknown, tipo = "hook_additional_context") => ({
    type: "attachment",
    attachment: { type: tipo, content: texto },
  });
  const bloque = formatInjection([
    { layer: "memory", id: "01INY0000000000000000000AA", scope: "trabajo", text: "el deploy usa docker compose", created_at: 1 },
  ]);

  it("ve lo que el hook de inyección adelantó", () => {
    expect(injectedMemories([adjunto([bloque])])).toEqual([
      { id: "01INY0000000000000000000AA", text: "el deploy usa docker compose" },
    ]);
  });

  it("acepta el contenido como cadena suelta además de como lista", () => {
    expect(injectedMemories([adjunto(bloque)])).toHaveLength(1);
  });

  it("ignora el contexto que puso otro hook", () => {
    expect(injectedMemories([adjunto(["algo de otro hook"])])).toEqual([]);
  });

  it("ignora un adjunto que no es contexto de hook", () => {
    expect(injectedMemories([adjunto([bloque], "environment")])).toEqual([]);
  });

  it("un recuerdo inyectado y usado cuenta como usado", () => {
    const reply = "El deploy usa docker compose, como quedó definido.";
    expect(usedMemoryIds(injectedMemories([adjunto([bloque])]), reply)).toEqual([
      "01INY0000000000000000000AA",
    ]);
  });
});

describe("assistantReply", () => {
  it("junta sólo el texto del asistente", () => {
    const lines = [user("hola"), toolResult(hits()), assistant("respuesta"), assistant("segunda")];
    expect(assistantReply(lines)).toBe("respuesta\nsegunda");
  });
});
