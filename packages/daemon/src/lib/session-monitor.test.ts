import { describe, it, expect } from "bun:test";
import { computeAgentStates, computePortPanes } from "./session-monitor.ts";

describe("computeAgentStates", () => {
  it("returns null for non-agent panes", () => {
    const panes = [
      { id: "%0", pid: "100", cmd: "zsh", title: "Shell" },
      { id: "%1", pid: "101", cmd: "node", title: "Dev Server" },
    ];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe(null);
    expect(states.get("%1")).toBe(null);
  });

  it("detects idle claude pane", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "claude", title: "Claude Code" }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("idle");
  });

  it("detects busy claude pane with Braille spinner", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "claude", title: "\u280B Working on something" }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("busy");
  });

  it("detects busy codex pane with spinner", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "codex", title: "\u2839 Thinking" }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("busy");
  });

  it("handles case-insensitive command matching", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "Claude", title: "idle title" }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("idle");
  });

  it("handles missing cmd and title gracefully", () => {
    const panes = [{ id: "%0", pid: "100", cmd: undefined, title: undefined }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe(null);
  });

  it("handles mixed panes correctly", () => {
    const panes = [
      { id: "%0", pid: "100", cmd: "claude", title: "\u280B Busy" },
      { id: "%1", pid: "101", cmd: "zsh", title: "Shell" },
      { id: "%2", pid: "102", cmd: "claude", title: "Idle Claude" },
    ];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("busy");
    expect(states.get("%1")).toBe(null);
    expect(states.get("%2")).toBe("idle");
  });

  it("detects agent via @ide_role lead regardless of command", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "2.1.80", title: "Claude Code", role: "lead" }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("idle");
  });

  it("detects busy teammate via @ide_role with spinner", () => {
    const panes = [
      { id: "%0", pid: "100", cmd: "node", title: "\u2839 Working", role: "teammate" },
    ];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("busy");
  });

  it("ignores widget panes even with @ide_role", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "bun", title: "Explorer", role: "widget" }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe(null);
  });

  it("falls back to command detection when no @ide_role is set", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "claude", title: "Agent 1" }];
    const states = computeAgentStates(panes);
    expect(states.get("%0")).toBe("idle");
  });
});

describe("computePortPanes", () => {
  it("returns empty set when no listeners", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "zsh", title: "Shell" }];
    const result = computePortPanes(panes, {
      listeners: new Set(),
      tree: new Map(),
    });
    expect(result.size).toBe(0);
  });

  it("maps a listener PID directly to its pane", () => {
    const panes = [{ id: "%0", pid: "100", cmd: "node", title: "Dev" }];
    const result = computePortPanes(panes, {
      listeners: new Set(["100"]),
      tree: new Map([["100", "1"]]),
    });
    expect(result.has("%0")).toBeTruthy();
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
    expect(result.has("%0")).toBeTruthy();
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
    expect(result.size).toBe(0);
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
    expect(result.has("%0")).toBeTruthy();
    expect(result.has("%1")).toBeTruthy();
    expect(result.size).toBe(2);
  });
});
