// @vitest-environment jsdom
// Renders the real panel: the connectome's place and the slider's cost are about what the
// component does with an event, which no pure function can show.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectomePanel } from "../ui/src/components/graph/ConnectomePanel";
import { DEFAULT_SETTINGS, GraphPanel, type GraphSettings } from "../ui/src/components/GraphPanel";
import { COMMIT_DELAY_MS } from "../ui/src/components/graph/PanelRows";
import type { ConnectomeSummary } from "../ui/src/api";
import { scopePalette } from "../ui/src/lib/graph";
import { installDomStubs } from "./support/dom";

installDomStubs();
afterEach(cleanup);
// Restoring inside a test body never runs when that body fails earlier, and the fake timers then
// reach the next test, which hangs on userEvent for a reason that is not its own.
afterEach(() => void vi.useRealTimers());

const summary: ConnectomeSummary = {
  turns: 40,
  pairs: 6,
  shown: 4,
  min_n: 1,
  max_n: 5,
  hubs: [{ id: "m1", degree: 3, strength: 0.6, support: 5 }],
};

const TOPICS = [
  { entry: { id: "m1", gist: "arquitectura de Daimon" }, color: "#d42300" },
  { entry: { id: "m2", gist: "facturación de ConteNube" }, color: "#946300" },
];

function panel(overrides: Partial<GraphSettings> = {}, width = 375) {
  const onChange = vi.fn();
  render(
    <GraphPanel
      settings={{ ...DEFAULT_SETTINGS, coUse: true, ...overrides }}
      onChange={onChange}
      palette={scopePalette(["s"])}
      unpainted={false}
      width={width}
      topics={TOPICS}
      connectome={
        <ConnectomePanel
          summary={summary}
          labels={new Map([["m1", "una memoria"]])}
          maxHubStrength={0.6}
          drawn={new Set(["m1"])}
          onSelect={() => {}}
        />
      }
    />,
  );
  return onChange;
}

describe("GraphPanel en un contenedor estrecho", () => {
  it("deja alcanzar el interruptor que apaga el conectoma", async () => {
    const user = userEvent.setup();
    panel();

    // At 375px the panel opens collapsed; before this change the connectome's own panel covered
    // it, so neither the trigger nor the switch could be reached from a phone.
    await user.click(screen.getByRole("button", { name: /desplegar los ajustes del grafo/i }));

    const off = screen.getByRole("switch", { name: /aristas por co-uso/i });
    expect(off).toBeTruthy();
    expect(off.getAttribute("aria-checked")).toBe("true");
  });

  it("enseña la lectura del conectoma dentro del mismo panel, no en otro flotante", async () => {
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByRole("button", { name: /desplegar los ajustes del grafo/i }));

    expect(screen.getByText("Turnos medidos")).toBeTruthy();
    // One panel on screen: the old one positioned itself at the top right over the settings.
    expect(document.querySelectorAll("aside").length).toBe(0);
    const positioned = [...document.querySelectorAll("[class*='absolute']")].filter((el) =>
      el.className.includes("right-3"),
    );
    expect(positioned).toEqual([]);
  });

  it("no enseña el conectoma cuando la capa está apagada", async () => {
    const user = userEvent.setup();
    panel({ coUse: false });
    await user.click(screen.getByRole("button", { name: /desplegar los ajustes del grafo/i }));

    expect(screen.queryByText("Turnos medidos")).toBeNull();
    expect(screen.getByRole("switch", { name: /aristas por co-uso/i })).toBeTruthy();
  });
});

/** Arrow presses as the browser sends them: fireEvent is synchronous, so fake timers stay still. */
function pressRight(slider: HTMLElement, times: number) {
  for (let i = 0; i < times; i++) fireEvent.keyDown(slider, { key: "ArrowRight" });
}

describe("el soporte mínimo no pide el grafo en cada paso", () => {
  it("avisa una sola vez, con el último valor, tras una ráfaga de flechas", () => {
    vi.useFakeTimers();
    const onChange = panel({}, 1000);

    const slider = screen.getByRole("slider", { name: /soporte mínimo/i });
    pressRight(slider, 5);

    // Every press moved the thumb, and nothing has been asked of the server yet: before this
    // change those five presses were five GET /api/graph, four of them aborted.
    expect(slider.getAttribute("aria-valuenow")).toBe("6");
    expect(onChange).not.toHaveBeenCalled();

    vi.advanceTimersByTime(COMMIT_DELAY_MS + 1);
    expect(onChange.mock.calls).toEqual([[{ coUseMinN: 6 }]]);
  });

  it("los deslizadores que sólo pintan en el cliente siguen avisando en cada paso", async () => {
    const user = userEvent.setup();
    const onChange = panel({}, 1000);
    await user.click(screen.getByRole("button", { name: /^visualización$/i }));

    pressRight(screen.getByRole("slider", { name: /tamaño de nodo/i }), 2);

    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("la lectura del conectoma", () => {
  it("enseña la etiqueta de un hub y su fuerza con dos decimales", () => {
    render(
      <ConnectomePanel
        summary={summary}
        labels={new Map([["m1", "una memoria"]])}
        maxHubStrength={0.6}
        drawn={new Set(["m1"])}
        onSelect={() => {}}
      />,
    );
    const entry = screen.getByRole("button", { name: /una memoria/i });
    expect(within(entry).getByText("0.60")).toBeTruthy();
  });

  it("respeta el orden en que el motor rankeó los hubs", () => {
    // The engine ranks by accumulated association; the panel must not reorder by neighbours on
    // its own, or the way in disagrees with the halo the canvas paints.
    const dos: ConnectomeSummary = {
      ...summary,
      hubs: [
        { id: "m1", degree: 3, strength: 0.6, support: 5 },
        { id: "m2", degree: 9, strength: 0.2, support: 4 },
      ],
    };

    render(
      <ConnectomePanel
        summary={dos}
        labels={
          new Map([
            ["m1", "la más asociada"],
            ["m2", "la de más vecinos"],
          ])
        }
        maxHubStrength={0.6}
        drawn={new Set(["m1", "m2"])}
        onSelect={() => {}}
      />,
    );

    const entradas = screen.getAllByRole("button").map((b) => b.textContent ?? "");
    expect(entradas[0]).toContain("la más asociada");
    expect(entradas[1]).toContain("la de más vecinos");
  });
});

describe("el selector de qué mide el tamaño", () => {
  it("viene en conexiones y deja volver a la saliencia", async () => {
    const user = userEvent.setup();
    const onChange = panel({}, 1000);
    await user.click(screen.getByRole("button", { name: /^visualización$/i }));

    const toggle = screen.getByRole("switch", { name: /tamaño por conexiones/i });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    await user.click(toggle);
    expect(onChange.mock.calls).toEqual([[{ sizeByConnections: false }]]);
  });
});

describe("el color de los nodos", () => {
  it("viene por ámbito y deja elegir tema o ninguno", async () => {
    const user = userEvent.setup();
    const onChange = panel({}, 1000);

    const porAmbito = screen.getByRole("radio", { name: /ámbito/i });
    expect(porAmbito.getAttribute("aria-checked")).toBe("true");

    await user.click(screen.getByRole("radio", { name: /tema/i }));
    expect(onChange.mock.calls).toEqual([[{ colorBy: "topic" }]]);
  });

  it("con el color por tema enseña los temas, no los ámbitos", async () => {
    const user = userEvent.setup();
    panel({ colorBy: "topic" }, 1000);

    await user.click(screen.getByRole("radio", { name: /tema/i }));

    expect(screen.queryByLabelText("Colores por ámbito")).toBeNull();
    expect(screen.getByLabelText("Colores por tema")).toBeTruthy();
  });
});
