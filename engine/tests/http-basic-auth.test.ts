import { describe, it, expect } from "vitest";
import { checkBasicAuth } from "../src/http/guard.js";

const auth = { user: "brain", pass: "s3cret:with:colons" };
const header = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;

describe("http-guard: checkBasicAuth", () => {
  it("lets everything through when no credentials are configured", () => {
    expect(checkBasicAuth(undefined, null)).toBe(true);
    expect(checkBasicAuth("Basic garbage", null)).toBe(true);
  });

  it("accepts the right credentials, including a password that contains colons", () => {
    expect(checkBasicAuth(header("brain", "s3cret:with:colons"), auth)).toBe(true);
  });

  it("rejects a missing header", () => {
    expect(checkBasicAuth(undefined, auth)).toBe(false);
  });

  it("rejects a non-Basic scheme", () => {
    expect(checkBasicAuth("Bearer s3cret", auth)).toBe(false);
  });

  it("rejects a wrong user or a wrong password", () => {
    expect(checkBasicAuth(header("other", "s3cret:with:colons"), auth)).toBe(false);
    expect(checkBasicAuth(header("brain", "nope"), auth)).toBe(false);
  });

  it("rejects a value that is a prefix or an extension of the real one", () => {
    expect(checkBasicAuth(header("brain", "s3cret"), auth)).toBe(false);
    expect(checkBasicAuth(header("brain", "s3cret:with:colons!"), auth)).toBe(false);
  });

  it("rejects a payload without a colon", () => {
    expect(checkBasicAuth(`Basic ${Buffer.from("brain").toString("base64")}`, auth)).toBe(false);
  });
});
