import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeAgentStates, computePortPanes } from "./session-monitor.js";

describe("computeAgentStates", () => {
  it("returns null for non-agent panes", () => {
    const panes = [
      { id: "%0", pid: "100", cmd: "zsh", title: "Shell" },
      { id: "%1", pid: "101", cmd: "node", title: "Dev Server" },
    ];
    const states = computeAgentStates(panes);
    assert.strictEqual(states.get("%0"), null);
    assert.strictEqual(states.get("%1"), null);
  });

  it("detects idle claude pane", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "claude", title: "Claude Code" }];
    const states = computeAgentStates(panes);
    assert.strictEqual(states.get("%0"), "idle");
  });

  it("detects busy claude pane with Braille spinner", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "claude", title: "\u280B Working on something" }];
    const states = computeAgentStates(panes);
    assert.strictEqual(states.get("%0"), "busy");
  });

  it("detects busy codex pane with spinner", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "codex", title: "\u2839 Thinking" }];
    const states = computeAgentStates(panes);
    assert.strictEqual(states.get("%0"), "busy");
  });

  it("handles case-insensitive command matching", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "Claude", title: "idle title" }];
    const states = computeAgentStates(panes);
    assert.strictEqual(states.get("%0"), "idle");
  });

  it("handles missing cmd and title gracefully", () => {
    const panes = [{ id: "%0", pid: "100", cmd: undefined, title: undefined }];
    const states = computeAgentStates(panes);
    assert.strictEqual(states.get("%0"), null);
  });

  it("handles mixed panes correctly", () => {
    const panes = [
      { id: "%0", pid: "100", cmd: "claude", title: "\u280B Busy" },
      { id: "%1", pid: "101", cmd: "zsh", title: "Shell" },
      { id: "%2", pid: "102", cmd: "claude", title: "Idle Claude" },
    ];
    const states = computeAgentStates(panes);
    assert.strictEqual(states.get("%0"), "busy");
    assert.strictEqual(states.get("%1"), null);
    assert.strictEqual(states.get("%2"), "idle");
  });
});

describe("computePortPanes", () => {
  it("returns empty set when no listeners", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "zsh", title: "Shell" }];
    const result = computePortPanes(panes, {
      listeners: new Set(),
      tree: new Map(),
    });
    assert.strictEqual(result.size, 0);
  });

  it("maps a listener PID directly to its pane", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "node", title: "Dev" }];
    const result = computePortPanes(panes, {
      listeners: new Set(["100"]),
      tree: new Map([["100", "1"]]),
    });
    assert.ok(result.has("%0"));
  });

  it("walks up the process tree to find pane owner", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "zsh", title: "Shell" }];
    // Listener PID 300 -> parent 200 -> parent 100 (pane pid)
    const tree = new Map([
      ["300", "200"],
      ["200", "100"],
      ["100", "1"],
    ]);
    const result = computePortPanes(panes, {
      listeners: new Set(["300"]),
      tree,
    });
    assert.ok(result.has("%0"));
  });

  it("does not match listener to unrelated pane", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "zsh", title: "Shell" }];
    // Listener PID 300 walks up to 200 -> 1, never reaching 100
    const tree = new Map([
      ["300", "200"],
      ["200", "1"],
      ["100", "1"],
    ]);
    const result = computePortPanes(panes, {
      listeners: new Set(["300"]),
      tree,
    });
    assert.strictEqual(result.size, 0);
  });

  it("handles multiple panes with different listeners", () => {
    const panes = [
      { id: "%0", pid: "100", cmd: "node", title: "Web" },
      { id: "%1", pid: "200", cmd: "node", title: "API" },
    ];
    const tree = new Map([
      ["150", "100"],
      ["250", "200"],
      ["100", "1"],
      ["200", "1"],
    ]);
    const result = computePortPanes(panes, {
      listeners: new Set(["150", "250"]),
      tree,
    });
    assert.ok(result.has("%0"));
    assert.ok(result.has("%1"));
    assert.strictEqual(result.size, 2);
  });
});
