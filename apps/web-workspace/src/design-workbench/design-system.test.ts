import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./design-workbench.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const tokenSource = readFileSync(new URL("../design-tokens.css", import.meta.url), "utf8");

/** Architectural guardrail: visual exceptions belong in the token contract, not components. */
describe("design workbench visual contract", () => {
  it("requires named tokens for every absolute dimension and color", () => {
    expect(css.match(/(?<![\w-])-?\d*\.?\d+(?:px|rem|em|vh|vw|ch|pt|ms|s)\b/g)).toBeNull();
    expect(css.match(/#[a-f\d]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch)\(/gi)).toBeNull();
    const typography = [
      ...css.matchAll(/\b(?:font-size|font-family|line-height|font-weight)\s*:\s*([^;}]+)/g),
    ];
    expect(typography.filter((match) => !match[1].trim().startsWith("var("))).toEqual([]);
  });

  it("resolves every workbench token from the shared token contract", () => {
    const references = [...css.matchAll(/var\((--dw-[\w-]+)/g)].map((match) => match[1]);
    const definitions = new Set(
      [...tokenSource.matchAll(/(--dw-[\w-]+)\s*:/g)].map((match) => match[1]),
    );
    expect(references.length).toBeGreaterThan(0);
    expect([...new Set(references)].filter((name) => !definitions.has(name))).toEqual([]);
  });

  it("keeps terminal geometry instantaneous and prevents style escape hatches", () => {
    expect(css).not.toMatch(/!important|\b(?:animation|transition)(?:-[\w-]+)?\s*:/);
    expect(css).not.toMatch(/--dw-[\w-]+\s*:/);
  });
});
