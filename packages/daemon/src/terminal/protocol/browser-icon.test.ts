import { expect, it } from "vitest";
import { browserIcon } from "./browser-icon.ts";
it("accepts bounded pixels only while the publishing browser is alive", () => {
  const icon = "ff00807f".repeat(256);
  expect(browserIcon(`123:${icon}`, (pid) => pid === 123)).toBe(icon);
  expect(browserIcon("123:", () => true)).toBe("");
  expect(browserIcon(`123:${icon}`, () => false)).toBeNull();
  for (const value of [
    "123:https://site/icon",
    "123:file:///tmp/icon",
    "0:",
    "123:" + "g".repeat(2048),
    "123:" + "a".repeat(2049),
  ]) {
    expect(browserIcon(value, () => true)).toBeNull();
  }
});
