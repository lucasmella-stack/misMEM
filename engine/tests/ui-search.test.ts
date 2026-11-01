import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SearchHeader } from "../ui/src/components/SearchHeader";
import { SearchResults } from "../ui/src/components/list/SearchResults";

describe("SearchResults", () => {
  it("monta la región de estado también mientras busca, antes de que llegue el aviso", () => {
    // A server render never runs the query, so the list stays in its pending state.
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(SearchResults, { term: "alpha", scope: undefined, selected: undefined, onSelect: () => {} }),
      ),
    );

    expect(html).toContain("Buscando en la memoria");
    // The loader is a status region too: what matters is the header's own region, present already.
    expect(html).toContain("Resultados para");
    expect(html.match(/role="status"/g)?.length).toBe(2);
  });
});

describe("SearchResults con datos", () => {
  it("pasa el corte de /api/search al aviso de la cabecera", () => {
    const client = new QueryClient();
    const hit = (id: string) => ({ layer: "memory", id, scope: "x", text: `alpha ${id}`, created_at: 0, salience: 1 });
    client.setQueryData(["search", "", "alpha"], { hits: [hit("a"), hit("b")], limit: 2, truncated: true });

    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SearchResults, { term: "alpha", scope: undefined, selected: undefined, onSelect: () => {} }),
      ),
    );

    expect(html).toContain("2 resultados, puede haber más");
  });
});

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
