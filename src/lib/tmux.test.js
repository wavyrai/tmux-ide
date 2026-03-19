import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  _setExecutor,
  _setSpawner,
  TmuxError,
  getSessionState,
  hasSession,
  killSession,
  listPanes,
  createDetachedSession,
  splitPane,
  sendLiteral,
  getSessionVariable,
  setSessionVariable,
  startSessionMonitor,
  stopSessionMonitor,
  setPaneTitle,
  selectPane,
  getPaneCurrentCommand,
  setSessionEnvironment,
  attachSession,
  runSessionCommand,
} from "./tmux.js";

let mockExec;
let restoreExec;

beforeEach(() => {
  mockExec = mock.fn();
  restoreExec = _setExecutor(mockExec);
});

afterEach(() => {
  restoreExec();
  mock.restoreAll();
});

// --- Helpers ---

function makeExecError(stderr) {
  const err = new Error("Command failed");
  err.stderr = stderr;
  return err;
}

// --- Error classification (via public API) ---

describe("getSessionState", () => {
  it("returns running: true when has-session succeeds", () => {
    mockExec.mock.mockImplementation(() => "");
    const result = getSessionState("my-session");
    assert.deepStrictEqual(result, { running: true, reason: null });
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], [
      "has-session",
      "-t",
      "my-session",
    ]);
  });

  it('returns SESSION_NOT_FOUND for "can\'t find session"', () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("can't find session: my-session");
    });
    const result = getSessionState("my-session");
    assert.deepStrictEqual(result, { running: false, reason: "SESSION_NOT_FOUND" });
  });

  it('returns TMUX_UNAVAILABLE for "connection refused"', () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("error connecting to /tmp/tmux-1000/default (connection refused)");
    });
    const result = getSessionState("my-session");
    assert.deepStrictEqual(result, { running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it('returns TMUX_UNAVAILABLE for "no server running"', () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("no server running on /tmp/tmux-1000/default");
    });
    const result = getSessionState("my-session");
    assert.deepStrictEqual(result, { running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it("throws for unknown errors", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("something totally unexpected");
    });
    assert.throws(
      () => getSessionState("my-session"),
      (err) => err instanceof TmuxError && err.code === "TMUX_ERROR",
    );
  });
});

describe("hasSession", () => {
  it("returns true when session exists", () => {
    mockExec.mock.mockImplementation(() => "");
    assert.strictEqual(hasSession("proj"), true);
  });

  it("returns false for SESSION_NOT_FOUND", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    assert.strictEqual(hasSession("proj"), false);
  });

  it("returns false for TMUX_UNAVAILABLE", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("no server running on /tmp/tmux-1000/default");
    });
    assert.strictEqual(hasSession("proj"), false);
  });

  it("throws for unknown errors", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("unexpected failure");
    });
    assert.throws(
      () => hasSession("proj"),
      (err) => err instanceof TmuxError && err.code === "TMUX_ERROR",
    );
  });
});

describe("killSession", () => {
  it("returns stopped: true when kill succeeds", () => {
    mockExec.mock.mockImplementation(() => "");
    const result = killSession("proj");
    assert.deepStrictEqual(result, { stopped: true, reason: null });
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], ["kill-session", "-t", "proj"]);
  });

  it("returns stopped: false for missing session", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    const result = killSession("proj");
    assert.deepStrictEqual(result, { stopped: false, reason: "SESSION_NOT_FOUND" });
  });

  it("returns stopped: false for unavailable tmux", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("failed to connect to server");
    });
    const result = killSession("proj");
    assert.deepStrictEqual(result, { stopped: false, reason: "TMUX_UNAVAILABLE" });
  });

  it("throws for unknown errors", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("disk error");
    });
    assert.throws(
      () => killSession("proj"),
      (err) => err instanceof TmuxError && err.code === "TMUX_ERROR",
    );
  });
});

// --- listPanes ---

describe("listPanes", () => {
  it("parses multi-pane output correctly", () => {
    mockExec.mock.mockImplementation(() => "0|Editor|120|40|1\n1|Shell|80|40|0\n");
    const panes = listPanes("proj");
    assert.deepStrictEqual(panes, [
      { index: 0, title: "Editor", width: 120, height: 40, active: true },
      { index: 1, title: "Shell", width: 80, height: 40, active: false },
    ]);
  });

  it("returns empty array for empty output", () => {
    mockExec.mock.mockImplementation(() => "  \n");
    const panes = listPanes("proj");
    assert.deepStrictEqual(panes, []);
  });

  it("handles pane titles containing pipe characters", () => {
    // The split("|") will split on the first pipe in the title, causing misparse.
    // This documents the current behavior — titles with pipes are truncated.
    mockExec.mock.mockImplementation(() => "0|A|B|120|40|0\n");
    const panes = listPanes("proj");
    // With pipe in title, index=0, title="A", width=NaN (from "B"), ...
    assert.strictEqual(panes[0].index, 0);
    assert.strictEqual(panes[0].title, "A");
  });
});

// --- createDetachedSession ---

describe("createDetachedSession", () => {
  it("returns trimmed pane ID", () => {
    mockExec.mock.mockImplementation(() => "  %0\n");
    const id = createDetachedSession("proj", "/workspace");
    assert.strictEqual(id, "%0");
  });

  it("uses default dimensions when not specified", () => {
    mockExec.mock.mockImplementation(() => "%0\n");
    createDetachedSession("proj", "/workspace");
    const args = mockExec.mock.calls[0].arguments[1];
    assert.ok(args.includes("200")); // default cols
    assert.ok(args.includes("50")); // default lines
  });

  it("passes custom dimensions", () => {
    mockExec.mock.mockImplementation(() => "%0\n");
    createDetachedSession("proj", "/workspace", { cols: 300, lines: 80 });
    const args = mockExec.mock.calls[0].arguments[1];
    assert.ok(args.includes("300"));
    assert.ok(args.includes("80"));
  });
});

// --- splitPane ---

describe("splitPane", () => {
  it("uses -v for vertical direction", () => {
    mockExec.mock.mockImplementation(() => "%1\n");
    splitPane("%0", "vertical", "/workspace", 30);
    const args = mockExec.mock.calls[0].arguments[1];
    assert.ok(args.includes("-v"));
    assert.ok(!args.includes("-h"));
  });

  it("uses -h for horizontal direction", () => {
    mockExec.mock.mockImplementation(() => "%2\n");
    splitPane("%0", "horizontal", "/workspace", 50);
    const args = mockExec.mock.calls[0].arguments[1];
    assert.ok(args.includes("-h"));
    assert.ok(!args.includes("-v"));
  });

  it("passes percent correctly", () => {
    mockExec.mock.mockImplementation(() => "%3\n");
    splitPane("%0", "vertical", "/workspace", 42);
    const args = mockExec.mock.calls[0].arguments[1];
    const pIdx = args.indexOf("-p");
    assert.strictEqual(args[pIdx + 1], "42");
  });

  it("returns trimmed pane ID", () => {
    mockExec.mock.mockImplementation(() => "  %5\n");
    const id = splitPane("%0", "vertical", "/workspace", 30);
    assert.strictEqual(id, "%5");
  });
});

// --- sendLiteral ---

describe("sendLiteral", () => {
  it("sends text with -l flag then Enter", () => {
    mockExec.mock.mockImplementation(() => "");
    sendLiteral("%0", "echo hello");
    assert.strictEqual(mockExec.mock.callCount(), 2);
    // First call: send-keys with -l and the text
    const firstArgs = mockExec.mock.calls[0].arguments[1];
    assert.deepStrictEqual(firstArgs, ["send-keys", "-t", "%0", "-l", "--", "echo hello"]);
    // Second call: send Enter
    const secondArgs = mockExec.mock.calls[1].arguments[1];
    assert.deepStrictEqual(secondArgs, ["send-keys", "-t", "%0", "Enter"]);
  });
});

// --- getSessionVariable / setSessionVariable ---

describe("getSessionVariable", () => {
  it("returns trimmed value when variable exists", () => {
    mockExec.mock.mockImplementation(() => "  some-value\n");
    const value = getSessionVariable("proj", "@my_var");
    assert.strictEqual(value, "some-value");
  });

  it("returns null when variable is empty", () => {
    mockExec.mock.mockImplementation(() => "\n");
    const value = getSessionVariable("proj", "@my_var");
    assert.strictEqual(value, null);
  });

  it("returns null when show-option throws", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    const value = getSessionVariable("proj", "@my_var");
    assert.strictEqual(value, null);
  });
});

describe("setSessionVariable", () => {
  it("sets variable with correct args", () => {
    mockExec.mock.mockImplementation(() => "");
    setSessionVariable("proj", "@my_var", "hello");
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], [
      "set-option",
      "-t",
      "proj",
      "@my_var",
      "hello",
    ]);
  });
});

// --- startSessionMonitor / stopSessionMonitor ---

describe("startSessionMonitor", () => {
  it("spawns detached process and stores PID", () => {
    const fakeChild = { pid: 12345, unref: mock.fn() };
    const restoreSpawn = _setSpawner(mock.fn(() => fakeChild));

    mockExec.mock.mockImplementation(() => "");
    startSessionMonitor("proj", "/path/to/monitor.js");

    // Check spawn was called correctly
    assert.strictEqual(fakeChild.unref.mock.callCount(), 1);

    // Check PID was stored via set-option
    const setArgs = mockExec.mock.calls[0].arguments[1];
    assert.deepStrictEqual(setArgs, ["set-option", "-t", "proj", "@monitor_pid", "12345"]);

    restoreSpawn();
  });
});

describe("stopSessionMonitor", () => {
  it("kills process by stored PID", () => {
    mockExec.mock.mockImplementation(() => "  42\n");
    const origKill = process.kill;
    const killCalls = [];
    process.kill = (pid) => killCalls.push(pid);
    try {
      stopSessionMonitor("proj");
      assert.deepStrictEqual(killCalls, [42]);
    } finally {
      process.kill = origKill;
    }
  });

  it("handles missing PID gracefully", () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    // Should not throw
    stopSessionMonitor("proj");
  });

  it("handles empty PID gracefully", () => {
    mockExec.mock.mockImplementation(() => "\n");
    // Should not throw (no pid to kill)
    stopSessionMonitor("proj");
  });
});

// --- Other public functions ---

describe("setPaneTitle", () => {
  it("calls select-pane with -T flag", () => {
    mockExec.mock.mockImplementation(() => "");
    setPaneTitle("%0", "My Pane");
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], [
      "select-pane",
      "-t",
      "%0",
      "-T",
      "My Pane",
    ]);
  });
});

describe("selectPane", () => {
  it("calls select-pane with target", () => {
    mockExec.mock.mockImplementation(() => "");
    selectPane("%2");
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], ["select-pane", "-t", "%2"]);
  });
});

describe("getPaneCurrentCommand", () => {
  it("returns trimmed command name", () => {
    mockExec.mock.mockImplementation(() => "  zsh\n");
    assert.strictEqual(getPaneCurrentCommand("%0"), "zsh");
  });
});

describe("setSessionEnvironment", () => {
  it("calls set-environment with correct args", () => {
    mockExec.mock.mockImplementation(() => "");
    setSessionEnvironment("proj", "PORT", 3000);
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], [
      "set-environment",
      "-t",
      "proj",
      "PORT",
      "3000",
    ]);
  });
});

describe("attachSession", () => {
  it("calls attach with correct args and stdio inherit", () => {
    mockExec.mock.mockImplementation(() => "");
    attachSession("proj");
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], ["attach", "-t", "proj"]);
    assert.strictEqual(mockExec.mock.calls[0].arguments[2].stdio, "inherit");
  });
});

describe("runSessionCommand", () => {
  it("passes args through to tmux", () => {
    mockExec.mock.mockImplementation(() => "");
    runSessionCommand(["resize-pane", "-t", "%0", "-x", "100"]);
    assert.deepStrictEqual(mockExec.mock.calls[0].arguments[1], [
      "resize-pane",
      "-t",
      "%0",
      "-x",
      "100",
    ]);
  });
});

// --- Debug logging ---

describe("debug logging", () => {
  it("logs to stderr when globalThis.__tmuxIdeVerbose is true", () => {
    const origVerbose = globalThis.__tmuxIdeVerbose;
    const stderrCalls = [];
    const origConsoleError = console.error;
    console.error = (...args) => stderrCalls.push(args.join(" "));

    globalThis.__tmuxIdeVerbose = true;
    mockExec.mock.mockImplementation(() => "");

    try {
      hasSession("test-session");
      assert.ok(stderrCalls.some((msg) => msg.includes("[tmux]")));
      assert.ok(stderrCalls.some((msg) => msg.includes("has-session")));
    } finally {
      globalThis.__tmuxIdeVerbose = origVerbose;
      console.error = origConsoleError;
    }
  });

  it("does not log when neither DEBUG nor verbose is set", () => {
    const origVerbose = globalThis.__tmuxIdeVerbose;
    const stderrCalls = [];
    const origConsoleError = console.error;
    console.error = (...args) => stderrCalls.push(args.join(" "));

    globalThis.__tmuxIdeVerbose = false;
    mockExec.mock.mockImplementation(() => "");

    try {
      hasSession("test-session");
      assert.strictEqual(stderrCalls.length, 0);
    } finally {
      globalThis.__tmuxIdeVerbose = origVerbose;
      console.error = origConsoleError;
    }
  });
});

// --- Error classification edge cases ---

describe("error classification", () => {
  it('classifies "can\'t find window" as SESSION_NOT_FOUND', () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("can't find window: proj:0");
    });
    const result = getSessionState("proj");
    assert.deepStrictEqual(result, { running: false, reason: "SESSION_NOT_FOUND" });
  });

  it('classifies "unknown target" as SESSION_NOT_FOUND', () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("unknown target: proj");
    });
    const result = getSessionState("proj");
    assert.deepStrictEqual(result, { running: false, reason: "SESSION_NOT_FOUND" });
  });

  it('classifies "failed to connect to server" as TMUX_UNAVAILABLE', () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("failed to connect to server: /tmp/tmux-1000/default");
    });
    const result = getSessionState("proj");
    assert.deepStrictEqual(result, { running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it('classifies "error connecting to" as TMUX_UNAVAILABLE', () => {
    mockExec.mock.mockImplementation(() => {
      throw makeExecError("error connecting to /tmp/tmux-1000/default");
    });
    const result = getSessionState("proj");
    assert.deepStrictEqual(result, { running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it("handles Buffer stderr in error", () => {
    mockExec.mock.mockImplementation(() => {
      const err = new Error("Command failed");
      err.stderr = Buffer.from("can't find session: proj");
      throw err;
    });
    const result = getSessionState("proj");
    assert.deepStrictEqual(result, { running: false, reason: "SESSION_NOT_FOUND" });
  });

  it("falls back to error.message when stderr is empty", () => {
    mockExec.mock.mockImplementation(() => {
      const err = new Error("can't find session: proj");
      err.stderr = "";
      throw err;
    });
    const result = getSessionState("proj");
    assert.deepStrictEqual(result, { running: false, reason: "SESSION_NOT_FOUND" });
  });
});
