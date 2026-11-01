// @vitest-environment jsdom
// The sign-out button is the only place the viewer navigates on its own, and a failed sign-out
// used to look exactly like one that worked.

import { cleanup, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "../ui/src/components/AppHeader";
import { installDomStubs } from "./support/dom";

installDomStubs();

const assign = vi.fn();

beforeEach(() => {
  assign.mockClear();
  // jsdom refuses a real navigation, and the assertion is about where it was asked to go.
  Object.defineProperty(window, "location", { value: { assign }, writable: true });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function header() {
  return render(
    <AppHeader
      draft=""
      onDraftChange={() => {}}
      onSubmit={() => {}}
      searchRef={createRef<HTMLInputElement>()}
      themeChoice="system"
      onThemeChange={() => {}}
      onConsolidate={() => {}}
      canSignOut
    />,
  );
}

describe("salir del visor", () => {
  it("pide la salida y el formulario de entrada por rutas relativas", async () => {
    // api.ts uses `../api/` so misMEM works mounted on another path behind a proxy; an absolute
    // /logout hits the proxy's root instead of the viewer.
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    header();

    await userEvent.click(screen.getByRole("button", { name: "Salir" }));

    expect(fetchSpy).toHaveBeenCalledWith("../logout", { method: "POST" });
    expect(assign).toHaveBeenCalledWith("../login");
  });

  it("si la salida falla lo dice y no finge que salió", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    header();

    await userEvent.click(screen.getByRole("button", { name: "Salir" }));

    // Navigating anyway left the cookie alive while the screen showed the login form.
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("No se pudo");
  });

  it("si la petición ni sale, tampoco finge", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("red caída"); }));
    header();

    await userEvent.click(screen.getByRole("button", { name: "Salir" }));

    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
