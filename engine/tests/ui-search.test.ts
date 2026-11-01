import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchHeader } from "../ui/src/components/SearchHeader";

describe("SearchHeader", () => {
  it("avisa del corte con cuántos resultados hay y qué hacer", () => {
    const html = renderToStaticMarkup(
      createElement(SearchHeader, { term: "alpha", count: 50, truncated: true, fetching: false }),
    );

    expect(html).toContain("50 resultados, puede haber más: afina la consulta o elige un ámbito");
  });

  it("con un ámbito elegido no manda elegir otro", () => {
    const html = renderToStaticMarkup(
      createElement(SearchHeader, {
        term: "deploy",
        scope: "trabajo",
        count: 50,
        truncated: true,
        fetching: false,
      }),
    );

    expect(html).toContain("afina la consulta o busca en toda la memoria");
    expect(html).not.toContain("elige un ámbito");
  });

  it("monta la región de estado con y sin aviso, para que se anuncie al aparecer", () => {
    const idle = renderToStaticMarkup(
      createElement(SearchHeader, { term: "alpha", count: 3, truncated: false, fetching: false }),
    );
    const cut = renderToStaticMarkup(
      createElement(SearchHeader, { term: "alpha", count: 50, truncated: true, fetching: false }),
    );

    expect(idle).toContain('role="status"');
    expect(cut).toContain('role="status"');
    expect(cut).toContain("50 resultados");
  });

  it("no avisa del corte cuando la lista está completa", () => {
    const html = renderToStaticMarkup(
      createElement(SearchHeader, { term: "alpha", count: 3, truncated: false, fetching: false }),
    );

    expect(html).toContain("Resultados para");
    expect(html).not.toContain("puede haber más");
  });
});
