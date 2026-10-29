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

  it("no avisa del corte cuando la lista está completa", () => {
    const html = renderToStaticMarkup(
      createElement(SearchHeader, { term: "alpha", count: 3, truncated: false, fetching: false }),
    );

    expect(html).toContain("Resultados para");
    expect(html).not.toContain("puede haber más");
  });
});
