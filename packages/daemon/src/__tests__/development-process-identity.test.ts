import { expect, it, vi } from "vitest";
import { linuxDevelopmentProcessIdentity } from "../lib/development-state.ts";
const stat = (state: string, start = "123") =>
  `42 (fixture (name)) ${[state, ...Array(18).fill("0"), start].join(" ")}`;
const missing = () => {
  throw Object.assign(new Error("gone"), { code: "ENOENT" });
};
it("classifies confirmed zombies and dead processes before executable lookup", () => {
  for (const state of ["Z", "X", "x"]) {
    const exe = vi.fn(missing);
    expect(linuxDevelopmentProcessIdentity(42, () => stat(state), exe)).toBeNull();
    expect(exe).not.toHaveBeenCalled();
  }
  expect(
    linuxDevelopmentProcessIdentity(
      42,
      () => stat("S"),
      () => "/exact/node",
    ),
  ).toBe("linux:123:/exact/node");
});
it("rechecks an exit between stat and exe without trusting a live replacement", () => {
  let reads = 0;
  expect(
    linuxDevelopmentProcessIdentity(42, () => stat(reads++ === 0 ? "S" : "Z"), missing),
  ).toBeNull();
  reads = 0;
  expect(() =>
    linuxDevelopmentProcessIdentity(42, () => stat("S", reads++ === 0 ? "123" : "456"), missing),
  ).toThrow("gone");
  expect(() =>
    linuxDevelopmentProcessIdentity(
      42,
      () => stat("S"),
      () => {
        throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      },
    ),
  ).toThrow("unreadable");
  expect(() =>
    linuxDevelopmentProcessIdentity(
      42,
      () => stat("S", "invalid"),
      () => "/node",
    ),
  ).toThrow("Invalid Linux process stat");
});

it("fences successful executable reads against PID reuse and malformed terminal states", () => {
  let reads = 0;
  expect(() =>
    linuxDevelopmentProcessIdentity(
      42,
      () => stat("S", reads++ === 0 ? "123" : "456"),
      () => "/same/node",
    ),
  ).toThrow("incarnation changed");
  reads = 0;
  expect(
    linuxDevelopmentProcessIdentity(
      42,
      () => stat(reads++ === 0 ? "S" : "Z"),
      () => "/same/node",
    ),
  ).toBeNull();
  expect(() =>
    linuxDevelopmentProcessIdentity(
      42,
      () => stat("Z", "bad"),
      () => "/node",
    ),
  ).toThrow("Invalid Linux process stat");
  expect(() =>
    linuxDevelopmentProcessIdentity(
      42,
      () => stat("Z").replace("42 (", "999 ("),
      () => "/node",
    ),
  ).toThrow("Invalid Linux process stat");
});
