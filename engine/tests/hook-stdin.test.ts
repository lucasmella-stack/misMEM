import { afterEach, describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { readStdin } from "../src/hooks/client.js";

const real = Object.getOwnPropertyDescriptor(process, "stdin")!;

function fakeStdin(isTTY: boolean): PassThrough {
  const stream = Object.assign(new PassThrough(), { isTTY });
  Object.defineProperty(process, "stdin", { value: stream, configurable: true });
  return stream;
}

afterEach(() => Object.defineProperty(process, "stdin", real));

describe("readStdin (shared by the inject and used hooks)", () => {
  it("returns what was piped once stdin ends", async () => {
    const s = fakeStdin(false);
    const p = readStdin();
    s.write('{"prompt":"hola"}');
    s.end();
    await expect(p).resolves.toBe('{"prompt":"hola"}');
  });

  it("returns an empty string on a TTY without waiting", async () => {
    fakeStdin(true);
    await expect(readStdin()).resolves.toBe("");
  });

  it("gives up on a stdin nobody closes", async () => {
    const s = fakeStdin(false);
    s.write("partial");
    const started = Date.now();
    await expect(readStdin()).resolves.toBe("partial");
    expect(Date.now() - started).toBeLessThan(4000);
  }, 6000);

  it("resolves with what it has when stdin errors", async () => {
    const s = fakeStdin(false);
    const p = readStdin();
    s.write("x");
    s.destroy(new Error("boom"));
    await expect(p).resolves.toBe("x");
  });
});
