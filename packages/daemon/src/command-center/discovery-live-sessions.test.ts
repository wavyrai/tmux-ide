import { describe, expect, it } from "vitest";

import { classifyTmuxError } from "@tmux-ide/tmux-bridge";

import { discoverLiveSessionSummaries, readLiveSessionSummaries } from "./discovery.ts";

/** A tmux client that failed the way `execFileSync` reports it. */
function failing(stderr: string | null) {
  return () => {
    throw Object.assign(new Error("Command failed: tmux"), stderr === null ? {} : { stderr });
  };
}

describe("live tmux session summaries", () => {
  it("keeps ordinary sessions independent from durable workspace intent", () => {
    expect(
      discoverLiveSessionSummaries(() =>
        [
          "41\t$0\t100\tordinary",
          "41\t$0\t100\tordinary",
          "41\t$0\t100\tordinary",
          "41\t$1\t101\tsecond",
          "41\t$2\t102\t_tmux-ide-chrome",
          "41\t$4\t104\t_tmux-ide-dev-keeper",
          "41\t$3\t103\tzz-scratch",
          "41\t$3\t103\tzz-scratch",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({ sessionName: "ordinary", paneCount: 3 }),
      expect.objectContaining({ sessionName: "second", paneCount: 1 }),
    ]);
  });

  it("keeps an identity across rename and replaces it across recreation", () => {
    const read = (row: string) => discoverLiveSessionSummaries(() => row)[0]!.liveSessionId;
    expect(read("41\t$0\t100\tbefore")).toBe(read("41\t$0\t100\tafter"));
    expect(read("41\t$0\t100\tbefore")).not.toBe(read("41\t$1\t101\tbefore"));
    expect(read("41\t$0\t100\tbefore")).not.toBe(read("42\t$0\t100\tbefore"));
  });

  it("keeps legacy names visible while hiding new internal development keepers", () => {
    expect(
      discoverLiveSessionSummaries(
        () => "41\t$1\t100\ttmux-ide-dev-keeper\n41\t$2\t101\t_tmux-ide-dev-keeper",
      ).map((session) => session.sessionName),
    ).toEqual(["tmux-ide-dev-keeper"]);
  });
});

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
