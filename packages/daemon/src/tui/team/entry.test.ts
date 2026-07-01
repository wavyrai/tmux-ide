import { describe, it, expect } from "vitest";
import { shouldOpenCockpit } from "./entry.ts";

describe("shouldOpenCockpit", () => {
  it("launches the project when an ide.yml is present", () => {
    expect(shouldOpenCockpit(true, false)).toBe(false);
  });

  it("opens the cockpit when there's no ide.yml", () => {
    expect(shouldOpenCockpit(false, false)).toBe(true);
  });

  it("forces the cockpit with --team even when an ide.yml is present", () => {
    expect(shouldOpenCockpit(true, true)).toBe(true);
  });

  it("opens the cockpit with --team and no ide.yml", () => {
    expect(shouldOpenCockpit(false, true)).toBe(true);
  });
});
