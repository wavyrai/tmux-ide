import { describe, it, expect } from "bun:test";
import { log } from "./log.ts";

function captureConsole(method: "log" | "warn" | "error" | "debug", fn: () => void): unknown[][] {
  const original = console[method];
  const calls: unknown[][] = [];
  (console as Record<string, typeof console.log>)[method] = (...args: unknown[]) => {
    calls.push(args);
  };
  try {
    fn();
  } finally {
    (console as Record<string, typeof console.log>)[method] = original;
  }
  return calls;
}

describe("log", () => {
  it("log.info forwards to console.log", () => {
    const calls = captureConsole("log", () => log.info("a", 1, { b: 2 }));
    expect(calls).toEqual([["a", 1, { b: 2 }]]);
  });

  it("log.warn forwards to console.warn", () => {
    const calls = captureConsole("warn", () => log.warn("warn"));
    expect(calls).toEqual([["warn"]]);
  });

  it("log.error forwards to console.error", () => {
    const calls = captureConsole("error", () => log.error(new Error("x")));
    expect(calls.length).toBe(1);
    expect(calls[0]![0]).toBeInstanceOf(Error);
  });

  it("log.debug forwards to console.debug", () => {
    const calls = captureConsole("debug", () => log.debug("dbg"));
    expect(calls).toEqual([["dbg"]]);
  });
});
