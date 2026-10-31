import { describe, expect, it } from "vitest";
import { applyTheme, loadTheme, resolveTheme, saveTheme, type ThemeChoice } from "../ui/src/lib/theme";

/** Reading the theme must never break startup: a hostile localStorage counts as empty. */
function reader(value: string | null): Pick<Storage, "getItem"> {
  return {
    getItem: (key) => {
      expect(key).toBe("mismem-theme");
      return value;
    },
  };
}

function brokenReader(): Pick<Storage, "getItem"> {
  return {
    getItem: () => {
      throw new Error("localStorage bloqueado");
    },
  };
}

function writer(): Pick<Storage, "setItem"> & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
}

/** The DOM does not exist in the test environment: the attribute contract applyTheme uses is enough. */
function rootStub(): HTMLElement {
  const attributes = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  } as unknown as HTMLElement;
}

describe("resolveTheme", () => {
  it("sigue la preferencia del sistema cuando la elección es system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("la elección explícita gana sobre la preferencia del sistema", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("loadTheme", () => {
  it("sin almacenamiento devuelve dark", () => {
    expect(loadTheme(null)).toBe("dark");
  });

  it("si la lectura lanza devuelve dark", () => {
    expect(loadTheme(brokenReader())).toBe("dark");
  });

  it("un valor guardado inválido devuelve dark", () => {
    expect(loadTheme(reader("solarized"))).toBe("dark");
  });

  it("devuelve la elección guardada cuando es válida", () => {
    expect(loadTheme(reader("light"))).toBe("light");
    expect(loadTheme(reader("system"))).toBe("system");
  });
});

describe("saveTheme", () => {
  it("guarda la elección bajo mismem-theme", () => {
    const storage = writer();
    saveTheme(storage, "light");
    expect(storage.entries.get("mismem-theme")).toBe("light");
  });

  it("ignora los errores de escritura", () => {
    const storage: Pick<Storage, "setItem"> = {
      setItem: () => {
        throw new Error("cuota llena");
      },
    };
    expect(() => saveTheme(storage, "dark" as ThemeChoice)).not.toThrow();
  });
});

describe("applyTheme", () => {
  it("pone data-theme en la raíz", () => {
    const root = rootStub();
    applyTheme(root, "light");
    expect(root.getAttribute("data-theme")).toBe("light");
    applyTheme(root, "dark");
    expect(root.getAttribute("data-theme")).toBe("dark");
  });
});
