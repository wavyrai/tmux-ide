import { describe, it, expect } from "bun:test";
import {
  buildSessionOptions,
  themeOptions,
  borderOptions,
  behaviorOptions,
  statusBarOptions,
  keyBindings,
} from "./session-options.ts";

describe("buildSessionOptions", () => {
  it("returns an array of command arrays", () => {
    const options = buildSessionOptions("my-session");

    expect(Array.isArray(options)).toBeTruthy();
    expect(options.length > 0).toBeTruthy();
    for (const cmd of options) {
      expect(Array.isArray(cmd)).toBeTruthy();
      expect(cmd.length >= 2).toBeTruthy();
    }
  });

  it("composes all sub-builders", () => {
    const session = "test";
    const theme = {};
    const all = buildSessionOptions(session, { theme });
    const expected = [
      ...themeOptions(session, theme),
      ...borderOptions(session, theme),
      ...behaviorOptions(session),
      ...statusBarOptions(session, theme),
      ...keyBindings(),
    ];

    expect(all).toEqual(expected);
  });
});

describe("themeOptions", () => {
  it("includes expected color settings", () => {
    const opts = themeOptions("my-session", {});

    const optionNames = opts.map((o) => o[3]);
    expect(optionNames.includes("status-style")).toBeTruthy();
    expect(optionNames.includes("pane-border-style")).toBeTruthy();
    expect(optionNames.includes("pane-active-border-style")).toBeTruthy();
  });

  it("uses default colors when no theme provided", () => {
    const opts = themeOptions("s", {});

    expect(opts[0]).toEqual(["set-option", "-t", "s", "status-style", "bg=colour235,fg=colour248"]);
    expect(opts[1]).toEqual(["set-option", "-t", "s", "pane-border-style", "fg=colour238"]);
    expect(opts[2]).toEqual(["set-option", "-t", "s", "pane-active-border-style", "fg=colour75"]);
  });

  it("respects custom theme overrides", () => {
    const opts = themeOptions("my-session", { accent: "red", border: "blue" });

    expect(opts[1]).toEqual(["set-option", "-t", "my-session", "pane-border-style", "fg=blue"]);
    expect(opts[2]).toEqual([
      "set-option",
      "-t",
      "my-session",
      "pane-active-border-style",
      "fg=red",
    ]);
  });
});

describe("borderOptions", () => {
  it("includes pane-border-status and pane-border-format", () => {
    const opts = borderOptions("my-session", {});

    expect(opts[0]).toEqual(["set-option", "-t", "my-session", "pane-border-status", "top"]);
    expect(opts[1][3]).toBe("pane-border-format");
    expect(opts[1][4].includes("pane_current_path")).toBeTruthy();
  });
});

describe("behaviorOptions", () => {
  it("includes mouse, escape-time, and status-interval", () => {
    const opts = behaviorOptions("test-session");

    const mouseOpt = opts.find((o) => o[3] === "mouse");
    expect(mouseOpt).toEqual(["set-option", "-t", "test-session", "mouse", "on"]);

    const escapeOpt = opts.find((o) => o[3] === "escape-time");
    expect(escapeOpt).toEqual(["set-option", "-t", "test-session", "escape-time", "0"]);

    const intervalOpt = opts.find((o) => o[3] === "status-interval");
    expect(intervalOpt).toEqual(["set-option", "-t", "test-session", "status-interval", "1"]);
  });
});

describe("statusBarOptions", () => {
  it("includes two-line status mode", () => {
    const opts = statusBarOptions("my-session", {});
    const statusOpt = opts.find((o) => o[3] === "status");
    expect(statusOpt).toEqual(["set-option", "-t", "my-session", "status", "2"]);
  });

  it("includes status-format[1] with pane tabs", () => {
    const opts = statusBarOptions("my-session", {});
    const formatOpt = opts.find((o) => o[3] === "status-format[1]");
    expect(formatOpt).toBeTruthy();
    expect(formatOpt[4].includes("#{P:")).toBeTruthy();
    expect(formatOpt[4].includes("pane_id")).toBeTruthy();
  });

  it("includes status-left with session name", () => {
    const opts = statusBarOptions("my-session", {});
    const leftOpt = opts.find((o) => o[3] === "status-left");
    expect(leftOpt[4].includes("MY-SESSION IDE")).toBeTruthy();
  });

  it("includes all expected status bar settings", () => {
    const opts = statusBarOptions("s", {});
    const names = opts.map((o) => o[3]);

    expect(names.includes("status-left")).toBeTruthy();
    expect(names.includes("status-left-length")).toBeTruthy();
    expect(names.includes("status-right")).toBeTruthy();
    expect(names.includes("status-justify")).toBeTruthy();
    expect(names.includes("window-status-current-format")).toBeTruthy();
    expect(names.includes("window-status-format")).toBeTruthy();
    expect(names.includes("status")).toBeTruthy();
    expect(names.includes("status-format[1]")).toBeTruthy();
  });
});

describe("keyBindings", () => {
  it("includes the mouse click binding", () => {
    const bindings = keyBindings();

    expect(bindings.length).toBe(1);
    expect(bindings[0]).toEqual([
      "bind-key",
      "-n",
      "MouseDown1StatusDefault",
      "select-pane",
      "-t",
      "=",
    ]);
  });
});
