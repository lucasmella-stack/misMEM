import { describe, it, expect } from "vitest";
import { hostAllowed, hostName, parseHostList } from "../src/http/host.js";

describe("http-host: hostName", () => {
  it("saca el puerto, los corchetes de IPv6 y las mayúsculas", () => {
    expect(hostName("localhost:3200")).toBe("localhost");
    expect(hostName("127.0.0.1")).toBe("127.0.0.1");
    expect(hostName("[::1]:3200")).toBe("::1");
    expect(hostName("Mem.Example.COM.")).toBe("mem.example.com");
  });

  it("sin cabecera no hay nombre", () => {
    expect(hostName(undefined)).toBeUndefined();
    expect(hostName("")).toBeUndefined();
  });
});

describe("http-host: hostAllowed sin auth", () => {
  const open = { auth: false, extra: [] };

  it("atiende los nombres de loopback", () => {
    for (const host of ["localhost:3200", "127.0.0.1:3200", "[::1]:3200", "app.localhost:3200"]) {
      expect(hostAllowed(host, open)).toBe(true);
    }
  });

  it("rechaza un dominio ajeno aunque la conexión llegue por 127.0.0.1 (DNS rebinding)", () => {
    expect(hostAllowed("attacker.example:3200", open)).toBe(false);
    expect(hostAllowed("127.0.0.1.attacker.example", open)).toBe(false);
    expect(hostAllowed("localhost.attacker.example", open)).toBe(false);
  });

  it("rechaza una petición sin Host", () => {
    expect(hostAllowed(undefined, open)).toBe(false);
  });

  it("MISMEM_ALLOWED_HOSTS añade nombres a propósito", () => {
    const extra = parseHostList(" mem.lan , Box.Local ");
    expect(extra).toEqual(["mem.lan", "box.local"]);
    expect(hostAllowed("mem.lan:3200", { auth: false, extra })).toBe(true);
    expect(hostAllowed("box.local", { auth: false, extra })).toBe(true);
    expect(hostAllowed("otro.lan", { auth: false, extra })).toBe(false);
  });
});

describe("http-host: hostAllowed con auth", () => {
  it("no filtra: las credenciales cubren el caso y detrás de un proxy el Host es público", () => {
    expect(hostAllowed("mem.example.com", { auth: true, extra: [] })).toBe(true);
  });
});
