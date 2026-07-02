/**
 * Unit tests for process-tree parsing, subtree walking, token extraction, and
 * agent-command resolution. All pure — no live `ps` is invoked here.
 */
import { describe, expect, it } from "vitest";
import {
  commandTokens,
  parsePsOutput,
  resolveAgentCommand,
  subtreeCommands,
  type ProcEntry,
} from "./process-tree.ts";

describe("parsePsOutput", () => {
  it("parses normal pid/ppid/command lines", () => {
    const raw = ["100 1 /sbin/launchd", "200 100 node /usr/local/bin/claude --foo"].join("\n");
    expect(parsePsOutput(raw)).toEqual([
      { pid: 100, ppid: 1, command: "/sbin/launchd" },
      { pid: 200, ppid: 100, command: "node /usr/local/bin/claude --foo" },
    ]);
  });

  it("tolerates the leading whitespace padding ps emits on numeric columns", () => {
    const raw = ["  100     1 -zsh", "  2001   100 vim notes.md"].join("\n");
    expect(parsePsOutput(raw)).toEqual([
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 2001, ppid: 100, command: "vim notes.md" },
    ]);
  });

  it("skips malformed lines without throwing", () => {
    const raw = ["", "garbage without numbers", "100 1 bash", "42", "  ", "7 x notcmd"].join("\n");
    expect(parsePsOutput(raw)).toEqual([{ pid: 100, ppid: 1, command: "bash" }]);
  });

  it("keeps commands that contain many spaces intact", () => {
    expect(parsePsOutput("300 200 node a b c --flag=1")).toEqual([
      { pid: 300, ppid: 200, command: "node a b c --flag=1" },
    ]);
  });
});

describe("subtreeCommands", () => {
  const tree: ProcEntry[] = [
    { pid: 100, ppid: 1, command: "-zsh" },
    { pid: 200, ppid: 100, command: "node cli.js" },
    { pid: 300, ppid: 200, command: "node /usr/local/bin/claude" },
  ];

  it("returns commands deepest-first and includes the root", () => {
    expect(subtreeCommands(tree, 100)).toEqual([
      "node /usr/local/bin/claude",
      "node cli.js",
      "-zsh",
    ]);
  });

  it("starts from an interior pid", () => {
    expect(subtreeCommands(tree, 200)).toEqual(["node /usr/local/bin/claude", "node cli.js"]);
  });

  it("returns [] for a pid absent from the table", () => {
    expect(subtreeCommands(tree, 999)).toEqual([]);
  });

  it("guards cycles without looping forever", () => {
    const cyclic: ProcEntry[] = [
      { pid: 1, ppid: 2, command: "a" },
      { pid: 2, ppid: 1, command: "b" },
    ];
    expect(subtreeCommands(cyclic, 1)).toEqual(["b", "a"]);
  });

  it("honors maxDepth", () => {
    const deep: ProcEntry[] = [
      { pid: 1, ppid: 0, command: "d0" },
      { pid: 2, ppid: 1, command: "d1" },
      { pid: 3, ppid: 2, command: "d2" },
      { pid: 4, ppid: 3, command: "d3" },
    ];
    // maxDepth 1 → only the root and its direct children are walked.
    expect(subtreeCommands(deep, 1, 1)).toEqual(["d1", "d0"]);
  });
});

describe("commandTokens", () => {
  it("extracts argv0 basename and a script-path basename", () => {
    expect(commandTokens("node /Users/x/.nvm/versions/node/v20/bin/claude --foo")).toEqual([
      "node",
      "claude",
    ]);
  });

  it("ignores a flag in the second position", () => {
    expect(commandTokens("claude --resume")).toEqual(["claude"]);
  });

  it("returns the basename of an incidental .claude path, not 'claude'", () => {
    // The false-positive guard: a path segment `.claude` must not leak through.
    expect(commandTokens("vim /Users/x/.claude/notes.md")).toEqual(["vim", "notes.md"]);
  });

  it("returns [] for an empty command", () => {
    expect(commandTokens("   ")).toEqual([]);
  });
});

describe("resolveAgentCommand", () => {
  it("takes the fast path when pane_current_command is the agent", () => {
    const result = resolveAgentCommand("claude", 200, []);
    expect(result.manifest?.id).toBe("claude");
    expect(result.matchedCommand).toBe("claude");
  });

  it("resolves claude from a node pane via the process tree", () => {
    const table: ProcEntry[] = [
      { pid: 100, ppid: 1, command: "-zsh" },
      { pid: 200, ppid: 100, command: "node" },
      { pid: 300, ppid: 200, command: "node /usr/local/bin/claude --resume" },
    ];
    const result = resolveAgentCommand("node", 200, table);
    expect(result.manifest?.id).toBe("claude");
    expect(result.matchedCommand).toBe("claude");
  });

  it("resolves codex running under bun", () => {
    const table: ProcEntry[] = [
      { pid: 400, ppid: 1, command: "bun" },
      { pid: 500, ppid: 400, command: "bun /Users/x/.bun/bin/codex serve" },
    ];
    const result = resolveAgentCommand("bun", 400, table);
    expect(result.manifest?.id).toBe("codex");
    expect(result.matchedCommand).toBe("codex");
  });

  it("prefers the agent over a deeper transient shell child (Bash tool call)", () => {
    // Claude (2.1.197) is running a `bash` tool subprocess that sits deeper in
    // the tree; the pane must still resolve to claude, not the shell catch-all.
    const table: ProcEntry[] = [
      { pid: 100, ppid: 1, command: "node /usr/local/bin/claude" },
      { pid: 200, ppid: 100, command: "(bash)" },
    ];
    const result = resolveAgentCommand("2.1.197", 100, table);
    expect(result.manifest?.id).toBe("claude");
    expect(result.matchedCommand).toBe("claude");
  });

  it("does NOT resolve claude for vim editing a .claude file", () => {
    // pane_current_command is the foreground `vim`; its subtree touches a
    // .claude path only as an argument — token extraction must reject it.
    const table: ProcEntry[] = [{ pid: 700, ppid: 1, command: "vim /Users/x/.claude/todo.md" }];
    const result = resolveAgentCommand("vim", 700, table);
    expect(result.manifest).toBeUndefined();
    expect(result.matchedCommand).toBe("");
  });

  it("resolves a plain shell pane to the shell manifest", () => {
    const table: ProcEntry[] = [{ pid: 800, ppid: 1, command: "-zsh" }];
    expect(resolveAgentCommand("zsh", 800, table).manifest?.id).toBe("shell");
  });

  it("with an empty table only the fast path can match", () => {
    expect(resolveAgentCommand("node", 200, []).manifest).toBeUndefined();
    expect(resolveAgentCommand("claude", 200, []).manifest?.id).toBe("claude");
  });

  it("reports the resolution source", () => {
    expect(resolveAgentCommand("claude", 200, []).source).toBe("fast");
    expect(resolveAgentCommand("emacs", 200, []).source).toBe("none");
    const table: ProcEntry[] = [
      { pid: 200, ppid: 1, command: "node" },
      { pid: 300, ppid: 200, command: "node /usr/local/bin/claude" },
    ];
    expect(resolveAgentCommand("node", 200, table).source).toBe("tree");
  });
});

describe("resolveAgentCommand — @agent_hint precedence", () => {
  it("a hint wins over the pane command and process tree", () => {
    // pane_current_command would resolve to shell; the hint forces claude.
    const table: ProcEntry[] = [{ pid: 800, ppid: 1, command: "-zsh" }];
    const result = resolveAgentCommand("zsh", 800, table, { hint: "claude" });
    expect(result.manifest?.id).toBe("claude");
    expect(result.matchedCommand).toBe("claude");
    expect(result.source).toBe("hint");
  });

  it("a hint that names no manifest is ignored (falls back to normal resolution)", () => {
    const result = resolveAgentCommand("zsh", 800, [{ pid: 800, ppid: 1, command: "-zsh" }], {
      hint: "not-a-real-agent",
    });
    expect(result.manifest?.id).toBe("shell");
    expect(result.source).toBe("fast");
  });

  it("an empty/blank hint is a no-op", () => {
    expect(resolveAgentCommand("claude", 1, [], { hint: "   " }).source).toBe("fast");
  });

  it("resolution uses the manifests passed in opts", () => {
    const only = [{ id: "codex", commands: ["codex"], states: {} }];
    expect(resolveAgentCommand("claude", 1, [], { manifests: only }).manifest).toBeUndefined();
    expect(resolveAgentCommand("codex", 1, [], { manifests: only }).manifest?.id).toBe("codex");
  });
});
