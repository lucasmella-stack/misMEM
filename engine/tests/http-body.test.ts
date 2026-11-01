import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { BodyTooLargeError, InvalidJsonError, isJsonContentType, readJsonBody } from "../src/http/body.js";

function request(chunks: string[], headers: Record<string, string> = {}): IncomingMessage {
  const stream = Readable.from(chunks.map((c) => Buffer.from(c))) as unknown as IncomingMessage;
  stream.headers = headers;
  return stream;
}

describe("http-body: readJsonBody", () => {
  it("devuelve el JSON cuando entra en el tope", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await expect(readJsonBody(request([body]), 1024)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
  });

  it("corta por Content-Length sin leer el cuerpo", async () => {
    let read = false;
    const req = request(['{"a":1}'], { "content-length": "5000" });
    req.on("data", () => (read = true));
    await expect(readJsonBody(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(read).toBe(false);
  });

  it("corta en chunked en cuanto pasa el tope, sin juntar el resto", async () => {
    let produced = 0;
    async function* endless(): AsyncGenerator<Buffer> {
      for (;;) {
        produced++;
        yield Buffer.alloc(100, "a");
      }
    }
    const req = Readable.from(endless()) as unknown as IncomingMessage;
    req.headers = {};
    await expect(readJsonBody(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(produced).toBeLessThan(20);
  });

  it("un JSON roto es error de parseo, no de tamaño", async () => {
    await expect(readJsonBody(request(["{no es json"]), 1024)).rejects.toBeInstanceOf(
      InvalidJsonError,
    );
  });

  it("un BOM UTF-8 delante del JSON no impide parsearlo", async () => {
    // The SDK's `req.json()` drops it; returning 400 here would have broken clients that used to work.
    const body = `\uFEFF${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}`;
    await expect(readJsonBody(request([body]), 1024)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
  });
});

describe("http-body: isJsonContentType", () => {
  it("acepta application/json, con o sin parámetros", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("distingue mayúsculas como el SDK, que daría 415 de todos modos", () => {
    expect(isJsonContentType("Application/JSON")).toBe(false);
  });

  it("rechaza otro tipo de medio o la cabecera ausente", () => {
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType(undefined)).toBe(false);
  });
});
