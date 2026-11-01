import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ServerResponse } from "node:http";
import { loginAssets, serveUi, UI_DIR } from "../src/viewer-static.js";

interface MockResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(name: string, value: string): void;
  end(payload?: string | Buffer): void;
}

function mockRes(): MockResponse {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(payload) {
      this.body = payload === undefined ? "" : payload.toString();
    },
  };
}

function serve(pathname: string, dir: string): MockResponse {
  const res = mockRes();
  serveUi(res as unknown as ServerResponse, pathname, dir);
  return res;
}

let root: string;
let ui: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mismem-ui-"));
  ui = join(root, "ui");
  mkdirSync(join(ui, "assets"), { recursive: true });
  writeFileSync(join(ui, "index.html"), "<!doctype html><title>misMEM</title>");
  writeFileSync(join(ui, "assets", "index-abc123.js"), "console.log(1)");
  writeFileSync(join(ui, "assets", "index-abc123.css"), "body{}");
  writeFileSync(join(root, "secreto.txt"), "no");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("viewer-static: serveUi", () => {
  it("sirve el index en /, /viewer y /viewer/ con CSP estricta y sin caché", () => {
    for (const path of ["/", "/viewer", "/viewer/"]) {
      const res = serve(path, ui);
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["content-security-policy"]).toMatch(/default-src 'none'/);
      expect(res.headers["content-security-policy"]).toMatch(/script-src 'self'/);
      expect(res.body).toContain("<title>misMEM</title>");
    }
  });

  it("sirve los assets con su tipo y caché larga", () => {
    const js = serve("/viewer/assets/index-abc123.js", ui);
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/text\/javascript/);
    expect(js.headers["cache-control"]).toMatch(/immutable/);
    expect(serve("/viewer/assets/index-abc123.css", ui).headers["content-type"]).toMatch(/text\/css/);
  });

  it("no sale de dist/ui, ni con .. codificado", () => {
    expect(serve("/viewer/../secreto.txt", ui).statusCode).toBe(404);
    expect(serve("/viewer/%2e%2e/secreto.txt", ui).statusCode).toBe(404);
    expect(serve("/viewer/assets/%2e%2e%2f..%2fsecreto.txt", ui).statusCode).toBe(404);
  });

  it("un asset que no existe es 404", () => {
    expect(serve("/viewer/assets/nada.js", ui).statusCode).toBe(404);
    expect(serve("/viewer/assets", ui).statusCode).toBe(404);
    expect(serve("/viewer/assets/%E0%A4%A", ui).statusCode).toBe(404);
  });

  it("sin la interfaz compilada dice cómo compilarla", () => {
    const res = serve("/viewer", join(root, "no-existe"));
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/pnpm build/);
  });
});

describe("recursos de la pantalla de entrada", () => {
  it("la carpeta de la interfaz es absoluta, no relativa al directorio de trabajo", () => {
    // It was read as "dist/ui", which only resolved when the server happened to run from
    // engine/: installed from npm the sign-in page lost its logo for everyone.
    expect(isAbsolute(UI_DIR)).toBe(true);
  });

  it("sirve los dos logos por su ruta, y sin la interfaz compilada no falla", () => {
    const dir = mkdtempSync(join(tmpdir(), "mismem-ui-"));
    expect(loginAssets(dir).size).toBe(0);

    writeFileSync(join(dir, "logo.webp"), "claro");
    writeFileSync(join(dir, "logo-dark.webp"), "oscuro");
    const assets = loginAssets(dir);

    expect([...assets.keys()].sort()).toEqual(["/login-logo-dark.webp", "/login-logo.webp"]);
    expect(assets.get("/login-logo.webp")?.toString()).toBe("claro");
    rmSync(dir, { recursive: true, force: true });
  });
});
