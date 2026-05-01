// tests/challenge.test.ts – unit tests for challenge.ts
import { describe, expect, it } from "bun:test";
import { normalizeGraceSeconds, DefaultGraceSeconds, MinGraceSeconds, MaxGraceSeconds } from "../src/challenge.ts";

describe("normalizeGraceSeconds", () => {
  it("returns the value unchanged when within range", () => {
    expect(normalizeGraceSeconds(DefaultGraceSeconds)).toBe(DefaultGraceSeconds);
    expect(normalizeGraceSeconds(60)).toBe(60);
    expect(normalizeGraceSeconds(MaxGraceSeconds)).toBe(MaxGraceSeconds);
  });

  it("clamps to MinGraceSeconds when below minimum", () => {
    expect(normalizeGraceSeconds(0)).toBe(MinGraceSeconds);
    expect(normalizeGraceSeconds(-1)).toBe(MinGraceSeconds);
  });

  it("clamps to MaxGraceSeconds when above maximum", () => {
    expect(normalizeGraceSeconds(9999)).toBe(MaxGraceSeconds);
    expect(normalizeGraceSeconds(MaxGraceSeconds + 1)).toBe(MaxGraceSeconds);
  });
});
