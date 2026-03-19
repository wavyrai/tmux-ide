import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

    assert.ok(Array.isArray(options));
    assert.ok(options.length > 0);
    for (const cmd of options) {
      assert.ok(Array.isArray(cmd), "each option should be an array");
      assert.ok(cmd.length >= 2, "each command should have at least 2 elements");
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

    assert.deepStrictEqual(all, expected);
  });
});

describe("themeOptions", () => {
  it("includes expected color settings", () => {
    const opts = themeOptions("my-session", {});

    const optionNames = opts.map((o) => o[3]);
    assert.ok(optionNames.includes("status-style"));
    assert.ok(optionNames.includes("pane-border-style"));
    assert.ok(optionNames.includes("pane-active-border-style"));
  });

  it("uses default colors when no theme provided", () => {
    const opts = themeOptions("s", {});

    assert.deepStrictEqual(opts[0], [
      "set-option",
      "-t",
      "s",
      "status-style",
      "bg=colour235,fg=colour248",
    ]);
    assert.deepStrictEqual(opts[1], ["set-option", "-t", "s", "pane-border-style", "fg=colour238"]);
    assert.deepStrictEqual(opts[2], [
      "set-option",
      "-t",
      "s",
      "pane-active-border-style",
      "fg=colour75",
    ]);
  });

  it("respects custom theme overrides", () => {
    const opts = themeOptions("my-session", { accent: "red", border: "blue" });

    assert.deepStrictEqual(opts[1], [
      "set-option",
      "-t",
      "my-session",
      "pane-border-style",
      "fg=blue",
    ]);
    assert.deepStrictEqual(opts[2], [
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

    assert.deepStrictEqual(opts[0], [
      "set-option",
      "-t",
      "my-session",
      "pane-border-status",
      "top",
    ]);
    assert.strictEqual(opts[1][3], "pane-border-format");
    assert.ok(opts[1][4].includes("pane_current_path"));
  });
});

describe("behaviorOptions", () => {
  it("includes mouse, escape-time, and status-interval", () => {
    const opts = behaviorOptions("test-session");

    const mouseOpt = opts.find((o) => o[3] === "mouse");
    assert.deepStrictEqual(mouseOpt, ["set-option", "-t", "test-session", "mouse", "on"]);

    const escapeOpt = opts.find((o) => o[3] === "escape-time");
    assert.deepStrictEqual(escapeOpt, ["set-option", "-t", "test-session", "escape-time", "0"]);

    const intervalOpt = opts.find((o) => o[3] === "status-interval");
    assert.deepStrictEqual(intervalOpt, [
      "set-option",
      "-t",
      "test-session",
      "status-interval",
      "1",
    ]);
  });
});

describe("statusBarOptions", () => {
  it("includes two-line status mode", () => {
    const opts = statusBarOptions("my-session", {});
    const statusOpt = opts.find((o) => o[3] === "status");
    assert.deepStrictEqual(statusOpt, ["set-option", "-t", "my-session", "status", "2"]);
  });

  it("includes status-format[1] with pane tabs", () => {
    const opts = statusBarOptions("my-session", {});
    const formatOpt = opts.find((o) => o[3] === "status-format[1]");
    assert.ok(formatOpt, "should include status-format[1]");
    assert.ok(formatOpt[4].includes("#{P:"), "format should use pane loop");
    assert.ok(formatOpt[4].includes("pane_id"), "format should reference pane_id");
  });

  it("includes status-left with session name", () => {
    const opts = statusBarOptions("my-session", {});
    const leftOpt = opts.find((o) => o[3] === "status-left");
    assert.ok(leftOpt[4].includes("MY-SESSION IDE"));
  });

  it("includes all expected status bar settings", () => {
    const opts = statusBarOptions("s", {});
    const names = opts.map((o) => o[3]);

    assert.ok(names.includes("status-left"));
    assert.ok(names.includes("status-left-length"));
    assert.ok(names.includes("status-right"));
    assert.ok(names.includes("status-justify"));
    assert.ok(names.includes("window-status-current-format"));
    assert.ok(names.includes("window-status-format"));
    assert.ok(names.includes("status"));
    assert.ok(names.includes("status-format[1]"));
  });
});

describe("keyBindings", () => {
  it("includes the mouse click binding", () => {
    const bindings = keyBindings();

    assert.strictEqual(bindings.length, 1);
    assert.deepStrictEqual(bindings[0], [
      "bind-key",
      "-n",
      "MouseDown1StatusDefault",
      "select-pane",
      "-t",
      "=",
    ]);
  });
});
