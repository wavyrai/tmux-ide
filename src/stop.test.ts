import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _setExecutor } from "./lib/tmux.ts";
import { IdeError } from "./lib/errors.ts";
import { stop } from "./stop.ts";

let mockExec;
let restoreExec;
let tmpDir;

beforeEach(() => {
  mockExec = mock.fn();
  restoreExec = _setExecutor(mockExec);
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-stop-test-"));
});

afterEach(() => {
  restoreExec();
  mock.restoreAll();
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeIdeYml(name) {
  writeFileSync(join(tmpDir, "ide.yml"), `name: ${name}\n`);
}

function makeExecError(stderr) {
  const err = new Error("Command failed");
  err.stderr = stderr;
  return err;
}

describe("stop", () => {
  it("calls stopSessionMonitor before killSession", async () => {
    writeIdeYml("my-app");
    const callLog = [];
    mockExec.mock.mockImplementation((_cmd, args) => {
      callLog.push(args[0]);
      if (args[0] === "show-option") return "\n";
      return "";
    });

    const logged = [];
    const origLog = console.log;
    console.log = (...a) => logged.push(a.join(" "));

    try {
      await stop(tmpDir);
      // show-option (stopSessionMonitor) should come before kill-session
      const showIdx = callLog.indexOf("show-option");
      const killIdx = callLog.indexOf("kill-session");
      assert.ok(showIdx < killIdx, "stopSessionMonitor should be called before killSession");
    } finally {
      console.log = origLog;
    }
  });

  it("outputs JSON when --json is passed", async () => {
    writeIdeYml("test-proj");
    mockExec.mock.mockImplementation((_cmd, args) => {
      if (args[0] === "show-option") return "\n";
      return "";
    });

    const logged = [];
    const origLog = console.log;
    console.log = (...a) => logged.push(a.join(" "));

    try {
      await stop(tmpDir, { json: true });
      const output = JSON.parse(logged[0]);
      assert.deepStrictEqual(output, { stopped: "test-proj" });
    } finally {
      console.log = origLog;
    }
  });

  it("outputs human-readable message by default", async () => {
    writeIdeYml("my-app");
    mockExec.mock.mockImplementation((_cmd, args) => {
      if (args[0] === "show-option") return "\n";
      return "";
    });

    const logged = [];
    const origLog = console.log;
    console.log = (...a) => logged.push(a.join(" "));

    try {
      await stop(tmpDir);
      assert.ok(logged[0].includes('Stopped session "my-app"'));
    } finally {
      console.log = origLog;
    }
  });

  it("throws IdeError when session not found", async () => {
    writeIdeYml("missing");
    mockExec.mock.mockImplementation((_cmd, args) => {
      if (args[0] === "show-option") {
        throw makeExecError("can't find session: missing");
      }
      if (args[0] === "kill-session") {
        throw makeExecError("can't find session: missing");
      }
      return "";
    });

    await assert.rejects(
      () => stop(tmpDir),
      (err) => err instanceof IdeError && err.message.includes("No active session"),
    );
  });

  it("falls back to dir basename when ide.yml has no name", async () => {
    // Write minimal YAML without a name field
    writeFileSync(join(tmpDir, "ide.yml"), "rows:\n  - panes:\n      - title: Shell\n");
    mockExec.mock.mockImplementation((_cmd, args) => {
      if (args[0] === "show-option") return "\n";
      return "";
    });

    const logged = [];
    const origLog = console.log;
    console.log = (...a) => logged.push(a.join(" "));

    try {
      await stop(tmpDir);
      // Session name should be the basename of the temp dir
      assert.ok(logged[0].includes("Stopped session"));
    } finally {
      console.log = origLog;
    }
  });

  it("falls back to dir basename when no ide.yml exists", async () => {
    // No ide.yml written
    mockExec.mock.mockImplementation((_cmd, args) => {
      if (args[0] === "show-option") return "\n";
      return "";
    });

    const logged = [];
    const origLog = console.log;
    console.log = (...a) => logged.push(a.join(" "));

    try {
      await stop(tmpDir);
      assert.ok(logged[0].includes("Stopped session"));
    } finally {
      console.log = origLog;
    }
  });
});
