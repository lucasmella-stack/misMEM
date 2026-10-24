import { describe, it, expect } from "vitest";
import { formatInjection } from "../src/inject.js";
import {
  assistantReply,
  injectedMemories,
  lastTurn,
  overlap,
  recalledMemories,
  usedMemoryIds,
} from "../src/usage.js";

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

  it("pocas palabras compartidas no alcanzan aunque la fracción sea alta", () => {
    const corto = { id: "corto", text: "usa docker" };
    expect(overlap(corto.text, "usa docker").fraction).toBe(1);
    expect(usedMemoryIds([corto], "usa docker")).toEqual([]);
  });

  it("las palabras vacías no cuentan como solapamiento", () => {
    const reply = "de la que el en los una para por con sobre";
    expect(usedMemoryIds([usado, ignorado], reply)).toEqual([]);
  });
});

describe("assistantReply", () => {
  it("junta sólo el texto del asistente", () => {
    const lines = [user("hola"), toolResult(hits()), assistant("respuesta"), assistant("segunda")];
    expect(assistantReply(lines)).toBe("respuesta\nsegunda");
  });
});

// Así guarda Claude Code el additionalContext de un hook UserPromptSubmit.
const injection = (text: string) => ({
  type: "attachment",
  attachment: { type: "hook_additional_context", hookEvent: "UserPromptSubmit", content: [text] },
});
const injected = (...rows: Array<{ id: string; scope: string; text: string }>) =>
  injection(formatInjection(rows.map((r) => ({ ...r, layer: "memory" as const, created_at: 0 }))));

describe("injectedMemories", () => {
  it("toma los recuerdos del bloque de inyección de misMEM", () => {
    const lines = [
      user("¿cómo cambio las luces del teclado?"),
      injected(
        { id: "m1", scope: "pc", text: "las luces del teclado del portátil se controlan con nitro-kb" },
        { id: "m2", scope: "pc", text: "el portátil es un Acer Nitro AN17" },
      ),
    ];
    expect(injectedMemories(lines)).toEqual([
      { id: "m1", text: "las luces del teclado del portátil se controlan con nitro-kb" },
      { id: "m2", text: "el portátil es un Acer Nitro AN17" },
    ]);
  });

  it("el contexto de otro hook no cuenta", () => {
    expect(injectedMemories([injection("- [x1] otro — no es de misMEM")])).toEqual([]);
  });

  it("un recuerdo inyectado que la respuesta usa sale como usado", () => {
    const lines = [
      user("¿cómo cambio las luces del teclado?"),
      injected(
        { id: "m1", scope: "pc", text: "las luces del teclado del portátil se controlan con nitro-kb" },
        { id: "m2", scope: "finanzas", text: "la deuda del cashflow quedó saldada" },
      ),
      assistant("Las luces del teclado del portátil se controlan con el comando nitro-kb."),
    ];
    const turn = lastTurn(lines);
    expect(usedMemoryIds(injectedMemories(turn), assistantReply(turn))).toEqual(["m1"]);
  });
});
