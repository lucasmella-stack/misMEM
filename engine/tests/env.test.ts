import { afterEach, describe, expect, it } from "vitest";
import { envNonNegativeNumber, envOptionalPositiveNumber, envPositiveNumber } from "../src/env.js";
import { decayedSalience } from "../src/memory/salience.js";

const NAME = "MISMEM_TEST_ENV_NUMBER";

afterEach(() => {
  delete process.env[NAME];
  delete process.env.MISMEM_SALIENCE_HALF_LIFE_DAYS;
  delete process.env.MISMEM_HOOK_MIN_OVERLAP;
  delete process.env.MISMEM_HOOK_MIN_SHARED;
});

describe("env number parsing", () => {
  it.each([
    ["7", 7],
    ["0.5", 0.5],
    ["", undefined],
    ["abc", undefined],
    ["0", undefined],
    ["-3", undefined],
    ["Infinity", undefined],
    ["NaN", undefined],
  ])("%j -> %s", (raw, expected) => {
    process.env[NAME] = raw;
    expect(envOptionalPositiveNumber(NAME)).toBe(expected);
    expect(envPositiveNumber(NAME, 42)).toBe(expected ?? 42);
  });

  it("unset falls back", () => {
    expect(envOptionalPositiveNumber(NAME)).toBeUndefined();
    expect(envPositiveNumber(NAME, 42)).toBe(42);
  });

  it("is read on every call, not cached at import", () => {
    process.env[NAME] = "5";
    expect(envPositiveNumber(NAME, 1)).toBe(5);
    process.env[NAME] = "6";
    expect(envPositiveNumber(NAME, 1)).toBe(6);
  });

  it("reads the env it is given, so callers holding their own map stay testable", () => {
    expect(envPositiveNumber(NAME, 42, { [NAME]: "9" })).toBe(9);
    expect(envOptionalPositiveNumber(NAME, { [NAME]: "-9" })).toBeUndefined();
  });

  it("salience half-life uses it: a valid value changes the decay, an invalid one keeps 90 days", () => {
    const DAY = 86_400_000;
    process.env.MISMEM_SALIENCE_HALF_LIFE_DAYS = "10";
    expect(decayedSalience(1, 0, 10 * DAY)).toBeCloseTo(0.5);
    process.env.MISMEM_SALIENCE_HALF_LIFE_DAYS = "0";
    expect(decayedSalience(1, 0, 90 * DAY)).toBeCloseTo(0.5);
  });
});

describe("envNonNegativeNumber", () => {
  it.each([
    ["0", 0],
    ["12", 12],
    ["0.5", 0.5],
    ["abc", 24],
    ["", 24],
    ["  ", 24],
    ["-1", 24],
    ["Infinity", 24],
    ["NaN", 24],
  ])("%j -> %s", (raw, expected) => {
    process.env[NAME] = raw;
    expect(envNonNegativeNumber(NAME, 24)).toBe(expected);
  });

  it("unset falls back", () => {
    expect(envNonNegativeNumber(NAME, 24)).toBe(24);
  });
});

describe("the hook thresholds read by used-cli", () => {
  // used-cli passes undefined to usageOptions when these are not set, and usage.ts then applies
  // its own defaults (0.2 and 3). 0 and "" used to be accepted and made every memory count as used.
  it.each(["0", "", "-1", "abc"])("MISMEM_HOOK_MIN_OVERLAP / MIN_SHARED = %j is ignored", (raw) => {
    process.env.MISMEM_HOOK_MIN_OVERLAP = raw;
    process.env.MISMEM_HOOK_MIN_SHARED = raw;
    expect(envOptionalPositiveNumber("MISMEM_HOOK_MIN_OVERLAP")).toBeUndefined();
    expect(envOptionalPositiveNumber("MISMEM_HOOK_MIN_SHARED")).toBeUndefined();
  });

  it("a positive value is used", () => {
    process.env.MISMEM_HOOK_MIN_OVERLAP = "0.4";
    process.env.MISMEM_HOOK_MIN_SHARED = "5";
    expect(envOptionalPositiveNumber("MISMEM_HOOK_MIN_OVERLAP")).toBe(0.4);
    expect(envOptionalPositiveNumber("MISMEM_HOOK_MIN_SHARED")).toBe(5);
  });
});
