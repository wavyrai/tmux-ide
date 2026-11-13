import { describe, expect, it } from "vitest";

import { classifyTmuxError } from "@tmux-ide/tmux-bridge";

import { discoverLiveSessionSummaries, readLiveSessionSummaries } from "./discovery.ts";

/** A tmux client that failed the way `execFileSync` reports it. */
function failing(stderr: string | null) {
  return () => {
    throw Object.assign(new Error("Command failed: tmux"), stderr === null ? {} : { stderr });
  };
}

describe("live session discovery when tmux cannot answer (#753)", () => {
  it("lists the sessions tmux reports", () => {
    const run = () => "4242\t$1\t1700000000\talpha\n4242\t$1\t1700000000\talpha";
    expect(readLiveSessionSummaries(run)).toMatchObject([{ sessionName: "alpha", paneCount: 2 }]);
  });

  it.each([
    "no server running on /private/tmp/tmux-501/default",
    "error connecting to /private/tmp/tmux-501/default (No such file or directory)",
  ])("a server that is not running has no sessions: %s", (stderr) => {
    expect(readLiveSessionSummaries(failing(stderr))).toEqual([]);
  });

  it.each([
    "error connecting to /private/tmp/t.sock (Permission denied)",
    "error connecting to /private/tmp/t.sock (Operation not permitted)",
    "open terminal failed: not a terminal",
    "",
    // A timeout or a refused spawn has no tmux message at all.
    null,
  ])("a server that cannot be asked is unavailable, not empty: %s", (stderr) => {
    expect(readLiveSessionSummaries(failing(stderr))).toBeNull();
  });

  it("reads the failure a tmux runner wraps as its cause", () => {
    const wrapped = (stderr: string) => () => {
      throw classifyTmuxError(Object.assign(new Error("Command failed"), { stderr }));
    };
    expect(readLiveSessionSummaries(wrapped("no server running on /tmp/t.sock\n"))).toEqual([]);
    expect(
      readLiveSessionSummaries(wrapped("error connecting to /tmp/t.sock (Permission denied)\n")),
    ).toBeNull();
  });

  it("a socket that is gone before the client starts has no sessions", () => {
    const gone = () => {
      throw Object.assign(new Error("ENOENT: no such file or directory, lstat '/tmp/t.sock'"), {
        code: "ENOENT",
        syscall: "lstat",
      });
    };
    expect(readLiveSessionSummaries(gone)).toEqual([]);
    // A tmux binary that is missing is not an empty server.
    const noBinary = () => {
      throw Object.assign(new Error("spawnSync tmux ENOENT"), {
        code: "ENOENT",
        syscall: "spawnSync tmux",
      });
    };
    expect(readLiveSessionSummaries(noBinary)).toBeNull();
  });

  it("keeps the empty answer for callers that only list", () => {
    expect(
      discoverLiveSessionSummaries(failing("error connecting to /x (Permission denied)")),
    ).toEqual([]);
  });
});
