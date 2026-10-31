import { describe, expect, it } from "vitest";
import {
  SESSION_COOKIE,
  cookieHeader,
  issueSession,
  readCookie,
  sessionTtlMs,
  verifySession,
} from "../src/http/session.js";

const auth = { user: "brain", pass: "una-clave-larga-de-produccion" };
const AHORA = 1_700_000_000_000;

describe("sesión del visor", () => {
  it("una sesión recién emitida vale", () => {
    const value = issueSession(auth, AHORA);

    expect(verifySession(value, auth, AHORA)).toBe(true);
  });

  it("caduca, y un segundo después de caducar ya no vale", () => {
    const value = issueSession(auth, AHORA);
    const vence = AHORA + sessionTtlMs();

    expect(verifySession(value, auth, vence - 1)).toBe(true);
    expect(verifySession(value, auth, vence + 1)).toBe(false);
  });

  it("cambiar la contraseña invalida las sesiones vivas", () => {
    // The key is derived from the credentials, so rotating them logs everyone out. That is the
    // behaviour wanted: a password changed because it leaked must not leave sessions standing.
    const value = issueSession(auth, AHORA);

    expect(verifySession(value, { ...auth, pass: "otra-clave" }, AHORA)).toBe(false);
  });

  it("una firma alterada no pasa, y tampoco una caducidad estirada a mano", () => {
    const value = issueSession(auth, AHORA);
    const [vence, firma] = value.split(".");

    expect(verifySession(`${vence}.${"0".repeat(firma!.length)}`, auth, AHORA)).toBe(false);
    expect(verifySession(`${Number(vence) + 86_400_000}.${firma}`, auth, AHORA)).toBe(false);
  });

  it("una cookie con forma rara no rompe nada: no vale y ya", () => {
    for (const roto of ["", ".", "abc", "abc.def", `${AHORA}`, `${AHORA}..x`]) {
      expect(verifySession(roto, auth, AHORA)).toBe(false);
    }
    expect(verifySession(undefined, auth, AHORA)).toBe(false);
  });

  it("sin credenciales configuradas no hay sesión que emitir ni que creer", () => {
    // Without MISMEM_AUTH_* the server is open by design; a cookie must not become a second
    // door that outlives turning the credentials on.
    expect(verifySession(issueSession(auth, AHORA), null, AHORA)).toBe(false);
  });
});

describe("la cookie que se manda al navegador", () => {
  it("no la puede leer el JavaScript de la página, ni viaja en claro, ni cruza sitios", () => {
    const header = cookieHeader(issueSession(auth, AHORA), { secure: true });

    expect(header).toContain("HttpOnly");
    expect(header).toContain("Secure");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Path=/");
    expect(header.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  });

  it("en claro, sin TLS, no marca Secure o el navegador la tiraría", () => {
    // A local viewer on http://127.0.0.1 would silently lose a Secure cookie.
    expect(cookieHeader(issueSession(auth, AHORA), { secure: false })).not.toContain("Secure");
  });

  it("cerrar sesión manda una cookie ya vencida", () => {
    expect(cookieHeader("", { secure: true, expire: true })).toContain("Max-Age=0");
  });
});

describe("lectura de la cabecera Cookie", () => {
  it("encuentra la sesión entre otras cookies", () => {
    expect(readCookie(`otra=1; ${SESSION_COOKIE}=abc; mas=2`, SESSION_COOKIE)).toBe("abc");
  });

  it("sin cabecera, o sin esa cookie, devuelve undefined", () => {
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie("otra=1", SESSION_COOKIE)).toBeUndefined();
  });

  it("no se confunde con una cookie cuyo nombre termina igual", () => {
    expect(readCookie(`x${SESSION_COOKIE}=noesmia`, SESSION_COOKIE)).toBeUndefined();
  });
});
