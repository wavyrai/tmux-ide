import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { remoteTmuxIdeArgsCommand } from "../lib/remote-tmux-command.ts";
import { forwardedUpgradeArgs } from "./cli.ts";
import { parseWorkerState, targetSocket } from "./io.ts";

const uid = process.getuid?.() ?? 0;

describe("targetSocket", () => {
  it("prefers --socket-path, then --socket-name, then the shell's server, then the default", () => {
    const env = { TMUX_TMPDIR: "/t", TMUX: "/inside/sock,123,0" };
    expect(targetSocket({ socketPath: "/x/s", socketName: "n" }, env)).toBe("/x/s");
    expect(targetSocket({ socketName: "work" }, env)).toBe(`/t/tmux-${uid}/work`);
    expect(targetSocket({}, env)).toBe("/inside/sock");
    expect(targetSocket({}, { TMUX_TMPDIR: "/t" })).toBe(`/t/tmux-${uid}/default`);
    expect(targetSocket({}, {})).toBe(`/tmp/tmux-${uid}/default`);
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
