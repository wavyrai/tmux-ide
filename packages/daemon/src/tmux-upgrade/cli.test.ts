import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteTmuxIdeArgsCommand } from "../lib/remote-tmux-command.ts";
import { forwardedUpgradeArgs, runUpgradeCli } from "./cli.ts";
import {
  answerIsYes,
  confirmAt,
  executableFromLsof,
  ownPaneFrom,
  procExePath,
  killGuardArgs,
  killOutcome,
  parseWorkerState,
  readWorkerResult,
  targetSocket,
  writeWorkerResult,
} from "./io.ts";

const uid = process.getuid?.() ?? 0;

describe("targetSocket", () => {
  it("prefers --socket-path, then --socket-name, then the shell's server, then the default", () => {
    const env = { TMUX_TMPDIR: "/t", TMUX: "/inside/sock,123,0" };
    expect(targetSocket({ socketName: "work" }, env)).toBe(`/t/tmux-${uid}/work`);
    expect(targetSocket({}, env)).toBe("/inside/sock");
    expect(targetSocket({}, { TMUX_TMPDIR: "/t" })).toBe(`/t/tmux-${uid}/default`);
    expect(targetSocket({}, {})).toBe(`/tmp/tmux-${uid}/default`);
  });
  it("reads TMUX_IDE_TMUX_SOCKET_PATH and _NAME as doctor does, after the flags", () => {
    const env = { TMUX_TMPDIR: "/t", TMUX: "/inside/sock,1,0" };
    expect(targetSocket({}, { ...env, TMUX_IDE_TMUX_SOCKET_PATH: "/env/s" })).toBe("/env/s");
    expect(targetSocket({}, { ...env, TMUX_IDE_TMUX_SOCKET_NAME: "work" })).toBe(
      `/t/tmux-${uid}/work`,
    );
    expect(
      targetSocket({ socketPath: "/flag/s" }, { ...env, TMUX_IDE_TMUX_SOCKET_PATH: "/env/s" }),
    ).toBe("/flag/s");
  });
  it("rejects --socket-path together with --socket-name", () => {
    expect(() => targetSocket({ socketPath: "/x/s", socketName: "n" }, {})).toThrow(/not both/);
  });
});

describe("runUpgradeCli", () => {
  it("rejects both socket flags before anything else, --ssh included", async () => {
    for (const ssh of [undefined, "spark"])
      await expect(
        runUpgradeCli({
          yes: true,
          endRunningAgents: false,
          json: true,
          dryRun: false,
          resumeAgents: true,
          socketPath: "/x/s",
          socketName: "n",
          ssh,
          cliEntry: "/nonexistent/cli.js",
        }),
      ).rejects.toThrow(/not both/);
  });
});

describe("forwardedUpgradeArgs", () => {
  it("forwards every choice to the remote run, and nothing it did not get", () => {
    const base = {
      yes: false,
      endRunningAgents: false,
      json: false,
      dryRun: false,
      resumeAgents: true,
      cliEntry: "/cli.js",
    };
    expect(forwardedUpgradeArgs(base)).toEqual([]);
    expect(
      forwardedUpgradeArgs({
        ...base,
        yes: true,
        endRunningAgents: true,
        resumeAgents: false,
        dryRun: true,
        json: true,
        socketPath: "/tmp/it's here",
      }),
    ).toEqual([
      "--yes",
      "--end-running-agents",
      "--no-resume-agents",
      "--dry-run",
      "--json",
      "--socket-path",
      "/tmp/it's here",
    ]);
  });
});

describe("remoteTmuxIdeArgsCommand", () => {
  it("passes each argument through the remote shell unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "remote-args-"));
    try {
      const bin = join(root, ".local", "bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "tmux-ide"), '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
      const args = ["servers", "upgrade", "--socket-path", "/a b/it's $HOME `id`;x"];
      const out = execFileSync("/bin/sh", ["-c", remoteTmuxIdeArgsCommand(args)], {
        env: { HOME: root, PATH: "/usr/bin:/bin" },
        encoding: "utf8",
      });
      expect(out.trimEnd().split("\n")).toEqual(args);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseWorkerState", () => {
  const state = {
    server: {
      host: "spark-04ad",
      socketPath: "/tmp/tmux-1000/default",
      pid: 4242,
      startTime: 1_700_000_000,
      version: "3.5a",
      executable: "/usr/bin/tmux",
      features: "stock",
    },
    client: "/b/tmux",
    snapshotPath: "/s.json",
    resumeAgents: true,
  };
  it("reads the state the prompt wrote", () => {
    expect(parseWorkerState(JSON.stringify(state))).toEqual(state);
  });
  it("rejects a state with a missing pid or an unknown field", () => {
    expect(() =>
      parseWorkerState(JSON.stringify({ ...state, server: { ...state.server, pid: 0 } })),
    ).toThrow();
    expect(() => parseWorkerState(JSON.stringify({ ...state, extra: 1 }))).toThrow();
  });
});

describe("the guarded kill", () => {
  it("asks tmux to end the server only when both pid and start time match", () => {
    expect(killGuardArgs({ pid: 4242, startTime: 1_700_000_000 })).toEqual([
      "if-shell",
      "-F",
      "#{&&:#{==:#{pid},4242},#{==:#{start_time},1700000000}}",
      "kill-server",
      "display-message -p identity-mismatch",
    ]);
  });
  it("reads a mismatch as a refusal, and a lost server as ended", () => {
    expect(killOutcome({ stdout: "identity-mismatch\n" })).toBe("mismatch");
    expect(killOutcome({ stdout: "" })).toBe("ended");
    expect(killOutcome({ stderr: "server exited unexpectedly" })).toBe("ended");
    expect(killOutcome({ stderr: "no server running on /s" })).toBe("ended");
    expect(killOutcome({ stderr: "permission denied" })).toEqual({ error: "permission denied" });
  });
});

describe("process facts", () => {
  it("takes the executable from lsof's first txt name", () => {
    expect(
      executableFromLsof(
        "p123\nftxt\nn/opt/homebrew/Cellar/tmux/3.5a/bin/tmux\nftxt\nn/usr/lib/dyld\n",
      ),
    ).toBe("/opt/homebrew/Cellar/tmux/3.5a/bin/tmux");
    expect(executableFromLsof("p123\n")).toBe("");
  });
  it("drops Linux's ' (deleted)' suffix from a replaced binary", () => {
    expect(procExePath("/usr/bin/tmux (deleted)")).toBe("/usr/bin/tmux");
    expect(procExePath("/usr/bin/tmux")).toBe("/usr/bin/tmux");
  });
  it("finds the pane this process runs in from its ancestry", () => {
    const lines = ["700\tapi:0.1", "555\tweb:1.0"];
    expect(ownPaneFrom([900, 800, 700, 1], lines)).toBe("api:0.1");
    expect(ownPaneFrom([900, 800, 1], lines)).toBeNull();
  });
});

describe("the prompt's answer", () => {
  it("is No for an empty answer, no terminal, or anything but y/yes", () => {
    expect(answerIsYes("")).toBe(false);
    expect(answerIsYes("\n")).toBe(false);
    expect(answerIsYes(null)).toBe(false);
    expect(answerIsYes("n")).toBe(false);
    expect(answerIsYes("yep")).toBe(false);
    expect(answerIsYes("y")).toBe(true);
    expect(answerIsYes(" YES ")).toBe(true);
  });
});

describe("confirmAt", () => {
  const terminal = (isTTY: boolean, answer: string | Error) => {
    const asked: string[] = [];
    return {
      asked,
      isTTY,
      print: () => {},
      ask: async (text: string) => {
        asked.push(text);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
  };
  it("says No without a terminal and never reads input", async () => {
    const t = terminal(false, "y");
    expect(await confirmAt("Go? ", t)).toBe(false);
    expect(t.asked).toEqual([]);
  });
  it("says No to an empty answer or a closed input, Yes only to y/yes", async () => {
    expect(await confirmAt("Go? ", terminal(true, ""))).toBe(false);
    expect(await confirmAt("Go? ", terminal(true, new Error("closed")))).toBe(false);
    expect(await confirmAt("Go? ", terminal(true, "y"))).toBe(true);
  });
});

describe("the worker's result file", () => {
  it("round-trips without the plan, and reads as null while missing or partial", () => {
    const root = mkdtempSync(join(tmpdir(), "worker-result-"));
    try {
      const path = join(root, "result.json");
      expect(readWorkerResult(path)).toBeNull();
      writeFileSync(path, '{"status":"upg');
      expect(readWorkerResult(path)).toBeNull();
      writeWorkerResult(path, { status: "upgraded", message: "ok", restored: ["api"], failed: [] });
      expect(readWorkerResult(path)).toEqual({
        status: "upgraded",
        message: "ok",
        restored: ["api"],
        failed: [],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
