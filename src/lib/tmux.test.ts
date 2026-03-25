import { describe, it, beforeEach, afterEach, mock, expect } from "bun:test";
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
} from "./tmux.ts";

let mockExec;
let restoreExec;

beforeEach(() => {
  mockExec = mock();
  restoreExec = _setExecutor(mockExec);
});

afterEach(() => {
  restoreExec();
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
    mockExec.mockImplementation(() => "");
    const result = getSessionState("my-session");
    expect(result).toEqual({ running: true, reason: null });
    expect(mockExec.mock.calls[0][1]).toEqual(["has-session", "-t", "my-session"]);
  });

  it('returns SESSION_NOT_FOUND for "can\'t find session"', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("can't find session: my-session");
    });
    const result = getSessionState("my-session");
    expect(result).toEqual({ running: false, reason: "SESSION_NOT_FOUND" });
  });

  it('returns TMUX_UNAVAILABLE for "connection refused"', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("error connecting to /tmp/tmux-1000/default (connection refused)");
    });
    const result = getSessionState("my-session");
    expect(result).toEqual({ running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it('returns TMUX_UNAVAILABLE for "no server running"', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("no server running on /tmp/tmux-1000/default");
    });
    const result = getSessionState("my-session");
    expect(result).toEqual({ running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it("throws for unknown errors", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("something totally unexpected");
    });
    expect(() => getSessionState("my-session")).toThrow(TmuxError);
  });
});

describe("hasSession", () => {
  it("returns true when session exists", () => {
    mockExec.mockImplementation(() => "");
    expect(hasSession("proj")).toBe(true);
  });

  it("returns false for SESSION_NOT_FOUND", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    expect(hasSession("proj")).toBe(false);
  });

  it("returns false for TMUX_UNAVAILABLE", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("no server running on /tmp/tmux-1000/default");
    });
    expect(hasSession("proj")).toBe(false);
  });

  it("throws for unknown errors", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("unexpected failure");
    });
    expect(() => hasSession("proj")).toThrow(TmuxError);
  });
});

describe("killSession", () => {
  it("returns stopped: true when kill succeeds", () => {
    mockExec.mockImplementation(() => "");
    const result = killSession("proj");
    expect(result).toEqual({ stopped: true, reason: null });
    expect(mockExec.mock.calls[0][1]).toEqual(["kill-session", "-t", "proj"]);
  });

  it("returns stopped: false for missing session", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    const result = killSession("proj");
    expect(result).toEqual({ stopped: false, reason: "SESSION_NOT_FOUND" });
  });

  it("returns stopped: false for unavailable tmux", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("failed to connect to server");
    });
    const result = killSession("proj");
    expect(result).toEqual({ stopped: false, reason: "TMUX_UNAVAILABLE" });
  });

  it("throws for unknown errors", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("disk error");
    });
    expect(() => killSession("proj")).toThrow(TmuxError);
  });
});

// --- listPanes ---

describe("listPanes", () => {
  it("parses multi-pane output correctly", () => {
    mockExec.mockImplementation(() => "0|Editor|120|40|1\n1|Shell|80|40|0\n");
    const panes = listPanes("proj");
    expect(panes).toEqual([
      { index: 0, title: "Editor", width: 120, height: 40, active: true },
      { index: 1, title: "Shell", width: 80, height: 40, active: false },
    ]);
  });

  it("returns empty array for empty output", () => {
    mockExec.mockImplementation(() => "  \n");
    const panes = listPanes("proj");
    expect(panes).toEqual([]);
  });

  it("handles pane titles containing pipe characters", () => {
    // The split("|") will split on the first pipe in the title, causing misparse.
    // This documents the current behavior — titles with pipes are truncated.
    mockExec.mockImplementation(() => "0|A|B|120|40|0\n");
    const panes = listPanes("proj");
    // With pipe in title, index=0, title="A", width=NaN (from "B"), ...
    expect(panes[0].index).toBe(0);
    expect(panes[0].title).toBe("A");
  });
});

// --- createDetachedSession ---

describe("createDetachedSession", () => {
  it("returns trimmed pane ID", () => {
    mockExec.mockImplementation(() => "  %0\n");
    const id = createDetachedSession("proj", "/workspace");
    expect(id).toBe("%0");
  });

  it("uses default dimensions when not specified", () => {
    mockExec.mockImplementation(() => "%0\n");
    createDetachedSession("proj", "/workspace");
    const args = mockExec.mock.calls[0][1];
    expect(args.includes("200")).toBeTruthy(); // default cols
    expect(args.includes("50")).toBeTruthy(); // default lines
  });

  it("passes custom dimensions", () => {
    mockExec.mockImplementation(() => "%0\n");
    createDetachedSession("proj", "/workspace", { cols: 300, lines: 80 });
    const args = mockExec.mock.calls[0][1];
    expect(args.includes("300")).toBeTruthy();
    expect(args.includes("80")).toBeTruthy();
  });
});

// --- splitPane ---

describe("splitPane", () => {
  it("uses -v for vertical direction", () => {
    mockExec.mockImplementation(() => "%1\n");
    splitPane("%0", "vertical", "/workspace", 30);
    const args = mockExec.mock.calls[0][1];
    expect(args.includes("-v")).toBeTruthy();
    expect(!args.includes("-h")).toBeTruthy();
  });

  it("uses -h for horizontal direction", () => {
    mockExec.mockImplementation(() => "%2\n");
    splitPane("%0", "horizontal", "/workspace", 50);
    const args = mockExec.mock.calls[0][1];
    expect(args.includes("-h")).toBeTruthy();
    expect(!args.includes("-v")).toBeTruthy();
  });

  it("passes percent correctly", () => {
    mockExec.mockImplementation(() => "%3\n");
    splitPane("%0", "vertical", "/workspace", 42);
    const args = mockExec.mock.calls[0][1];
    const pIdx = args.indexOf("-p");
    expect(args[pIdx + 1]).toBe("42");
  });

  it("returns trimmed pane ID", () => {
    mockExec.mockImplementation(() => "  %5\n");
    const id = splitPane("%0", "vertical", "/workspace", 30);
    expect(id).toBe("%5");
  });
});

// --- sendLiteral ---

describe("sendLiteral", () => {
  it("sends text with -l flag then Enter", () => {
    mockExec.mockImplementation(() => "");
    sendLiteral("%0", "echo hello");
    expect(mockExec.mock.calls.length).toBe(2);
    // First call: send-keys with -l and the text
    const firstArgs = mockExec.mock.calls[0][1];
    expect(firstArgs).toEqual(["send-keys", "-t", "%0", "-l", "--", "echo hello"]);
    // Second call: send Enter
    const secondArgs = mockExec.mock.calls[1][1];
    expect(secondArgs).toEqual(["send-keys", "-t", "%0", "Enter"]);
  });
});

// --- getSessionVariable / setSessionVariable ---

describe("getSessionVariable", () => {
  it("returns trimmed value when variable exists", () => {
    mockExec.mockImplementation(() => "  some-value\n");
    const value = getSessionVariable("proj", "@my_var");
    expect(value).toBe("some-value");
  });

  it("returns null when variable is empty", () => {
    mockExec.mockImplementation(() => "\n");
    const value = getSessionVariable("proj", "@my_var");
    expect(value).toBe(null);
  });

  it("returns null when show-option throws", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    const value = getSessionVariable("proj", "@my_var");
    expect(value).toBe(null);
  });
});

describe("setSessionVariable", () => {
  it("sets variable with correct args", () => {
    mockExec.mockImplementation(() => "");
    setSessionVariable("proj", "@my_var", "hello");
    expect(mockExec.mock.calls[0][1]).toEqual(["set-option", "-t", "proj", "@my_var", "hello"]);
  });
});

// --- startSessionMonitor / stopSessionMonitor ---

describe("startSessionMonitor", () => {
  it("spawns detached process and stores PID", () => {
    const fakeChild = { pid: 12345, unref: mock() };
    const restoreSpawn = _setSpawner(mock(() => fakeChild));

    mockExec.mockImplementation(() => "");
    startSessionMonitor("proj", "/path/to/monitor.js");

    // Check spawn was called correctly
    expect(fakeChild.unref.mock.calls.length).toBe(1);

    // First call checks for existing PID (show-option), then stores new PID (set-option)
    const lastCall = mockExec.mock.calls[mockExec.mock.calls.length - 1];
    const setArgs = lastCall[1];
    expect(setArgs).toEqual(["set-option", "-t", "proj", "@monitor_pid", "12345"]);

    restoreSpawn();
  });

  it("spawns bun directly without shell wrapper", () => {
    const fakeChild = { pid: 99, unref: mock() };
    const mockSpawn = mock(() => fakeChild);
    const restoreSpawn = _setSpawner(mockSpawn);

    mockExec.mockImplementation(() => "");
    startSessionMonitor("proj", "/path/to/monitor.ts");

    const spawnCall = mockSpawn.mock.calls[0];
    expect(spawnCall[0]).toBe("bun");
    const args = spawnCall[1];
    expect(args).toEqual(["/path/to/monitor.ts", "proj", "0"]);

    restoreSpawn();
  });
});

describe("stopSessionMonitor", () => {
  it("kills process group by stored PID", () => {
    mockExec.mockImplementation(() => "  42\n");
    const origKill = process.kill;
    const killCalls: Array<{ pid: number; signal?: string }> = [];
    process.kill = ((pid: number, signal?: string) => {
      killCalls.push({ pid, signal });
    }) as typeof process.kill;
    try {
      stopSessionMonitor("proj");
      // First tries process group kill (negative PID)
      expect(killCalls[0]?.pid).toBe(-42);
      expect(killCalls[0]?.signal).toBe("SIGTERM");
    } finally {
      process.kill = origKill;
    }
  });

  it("handles missing PID gracefully", () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("can't find session: proj");
    });
    // Should not throw
    stopSessionMonitor("proj");
  });

  it("handles empty PID gracefully", () => {
    mockExec.mockImplementation(() => "\n");
    // Should not throw (no pid to kill)
    stopSessionMonitor("proj");
  });
});

// --- Other public functions ---

describe("setPaneTitle", () => {
  it("calls select-pane with -T flag", () => {
    mockExec.mockImplementation(() => "");
    setPaneTitle("%0", "My Pane");
    expect(mockExec.mock.calls[0][1]).toEqual(["select-pane", "-t", "%0", "-T", "My Pane"]);
  });
});

describe("selectPane", () => {
  it("calls select-pane with target", () => {
    mockExec.mockImplementation(() => "");
    selectPane("%2");
    expect(mockExec.mock.calls[0][1]).toEqual(["select-pane", "-t", "%2"]);
  });
});

describe("getPaneCurrentCommand", () => {
  it("returns trimmed command name", () => {
    mockExec.mockImplementation(() => "  zsh\n");
    expect(getPaneCurrentCommand("%0")).toBe("zsh");
  });
});

describe("setSessionEnvironment", () => {
  it("calls set-environment with correct args", () => {
    mockExec.mockImplementation(() => "");
    setSessionEnvironment("proj", "PORT", 3000);
    expect(mockExec.mock.calls[0][1]).toEqual(["set-environment", "-t", "proj", "PORT", "3000"]);
  });
});

describe("attachSession", () => {
  it("calls attach with correct args and stdio inherit", () => {
    mockExec.mockImplementation(() => "");
    attachSession("proj");
    expect(mockExec.mock.calls[0][1]).toEqual(["attach", "-t", "proj"]);
    expect(mockExec.mock.calls[0][2].stdio).toBe("inherit");
  });
});

describe("runSessionCommand", () => {
  it("passes args through to tmux", () => {
    mockExec.mockImplementation(() => "");
    runSessionCommand(["resize-pane", "-t", "%0", "-x", "100"]);
    expect(mockExec.mock.calls[0][1]).toEqual(["resize-pane", "-t", "%0", "-x", "100"]);
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
    mockExec.mockImplementation(() => "");

    try {
      hasSession("test-session");
      expect(stderrCalls.some((msg) => msg.includes("[tmux]"))).toBeTruthy();
      expect(stderrCalls.some((msg) => msg.includes("has-session"))).toBeTruthy();
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
    mockExec.mockImplementation(() => "");

    try {
      hasSession("test-session");
      expect(stderrCalls.length).toBe(0);
    } finally {
      globalThis.__tmuxIdeVerbose = origVerbose;
      console.error = origConsoleError;
    }
  });
});

// --- Error classification edge cases ---

describe("error classification", () => {
  it('classifies "can\'t find window" as SESSION_NOT_FOUND', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("can't find window: proj:0");
    });
    const result = getSessionState("proj");
    expect(result).toEqual({ running: false, reason: "SESSION_NOT_FOUND" });
  });

  it('classifies "unknown target" as SESSION_NOT_FOUND', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("unknown target: proj");
    });
    const result = getSessionState("proj");
    expect(result).toEqual({ running: false, reason: "SESSION_NOT_FOUND" });
  });

  it('classifies "failed to connect to server" as TMUX_UNAVAILABLE', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("failed to connect to server: /tmp/tmux-1000/default");
    });
    const result = getSessionState("proj");
    expect(result).toEqual({ running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it('classifies "error connecting to" as TMUX_UNAVAILABLE', () => {
    mockExec.mockImplementation(() => {
      throw makeExecError("error connecting to /tmp/tmux-1000/default");
    });
    const result = getSessionState("proj");
    expect(result).toEqual({ running: false, reason: "TMUX_UNAVAILABLE" });
  });

  it("handles Buffer stderr in error", () => {
    mockExec.mockImplementation(() => {
      const err = new Error("Command failed");
      err.stderr = Buffer.from("can't find session: proj");
      throw err;
    });
    const result = getSessionState("proj");
    expect(result).toEqual({ running: false, reason: "SESSION_NOT_FOUND" });
  });

  it("falls back to error.message when stderr is empty", () => {
    mockExec.mockImplementation(() => {
      const err = new Error("can't find session: proj");
      err.stderr = "";
      throw err;
    });
    const result = getSessionState("proj");
    expect(result).toEqual({ running: false, reason: "SESSION_NOT_FOUND" });
  });
});
