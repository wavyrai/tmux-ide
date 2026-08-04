/**
 * MirrorControlChannel LIVE verification: the channel survives having its tmux
 * session killed out from under it.
 *
 * The regression this pins (m44): `dispose()` writes `detach-client` into the
 * control client's stdin, and a client whose session was killed has already
 * exited. A pipe error on a child stream is delivered ASYNCHRONOUSLY as an
 * 'error' event on the socket, so the `try/catch` around `write()` cannot catch
 * it — with no 'error' listener Node turned it into an uncaught exception and
 * killed the whole daemon process. The desktop smoke gate saw exactly this:
 * the daemon child died mid-run and its HTTP port stopped listening
 * (ECONNREFUSED) the moment a mirrored session was killed.
 *
 * The test installs its own `uncaughtException` listener so the failure is an
 * assertion rather than a dead worker.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `zz-m44-chan-${process.pid}-${randomUUID().slice(0, 8)}`;
/** A session that outlives the one under test, so killing it never takes the
 *  server (and the socket) down with it. */
const keepalive = "zz-chan-keepalive";
const session = "zz-chan-doomed";

function runTmux(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
}

describe.skipIf(!hasTmux)("MirrorControlChannel live: session death", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

  afterAll(() => {
    spawnSync("tmux", ["-L", socketName, "kill-server"], {
      stdio: "ignore",
      env: { ...process.env, TMUX: "" },
    });
    // kill-server does not always unlink the socket file on macOS.
    try {
      rmSync(
        join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socketName),
      );
    } catch {
      // best effort
    }
  });

  /** Capture uncaught exceptions for the duration of `body` instead of letting
   *  one kill the worker, so the regression is an assertion and not a crash. */
  async function withUncaughtCapture(body: () => Promise<void>): Promise<Error[]> {
    const uncaught: Error[] = [];
    const onUncaught = (error: Error): void => {
      uncaught.push(error);
    };
    process.on("uncaughtException", onUncaught);
    try {
      await body();
      // Stream errors land a turn after the write that provoked them.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } finally {
      process.off("uncaughtException", onUncaught);
    }
    return uncaught;
  }

  function openChannel(target: string, exits: (string | null)[]): MirrorControlChannel {
    return new MirrorControlChannel({
      session: target,
      socketName,
      configFile: "/dev/null",
      handlers: {
        onOutput: () => {},
        onNotify: () => {},
        onExit: (reason) => exits.push(reason),
      },
    });
  }

  it("survives its session being killed, and disposes clean", async () => {
    runTmux(["new-session", "-d", "-s", keepalive, "sh"]);
    runTmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24", "sh"]);

    const exits: (string | null)[] = [];
    const channel = openChannel(session, exits);
    const uncaught = await withUncaughtCapture(async () => {
      await channel.start();
      // Prove the channel is genuinely live before the kill.
      await expect(channel.request(`list-panes -t "${session}" -F "#{pane_id}"`)).resolves.toEqual([
        expect.stringMatching(/^%[0-9]+$/u),
      ]);

      // Dispose WITHOUT waiting for the client's exit — the ordering
      // MirrorService.release() produces when a subscriber departs a session
      // that tmux is tearing down underneath it. Both remaining write paths
      // (fire-and-forget input, and disposal's `detach-client`) aim at a pipe
      // that is closing.
      runTmux(["kill-session", "-t", `=${session}`]);
      channel.send("send-keys -t %0 -H 61");
      await expect(channel.dispose()).resolves.toBeUndefined();
      // Pending work settles as failure rather than hanging.
      await expect(channel.request("list-sessions")).rejects.toThrow();
    });

    expect(uncaught).toEqual([]);
    expect(exits.length).toBeGreaterThan(0);
    // The server survived: only the doomed session is gone.
    expect(runTmux(["list-sessions", "-F", "#{session_name}"]).split("\n")).toEqual([keepalive]);
  });

  it("treats a pipe error on any channel stream as inert", async () => {
    const target = "zz-chan-pipe";
    runTmux(["new-session", "-d", "-s", target, "sh"]);

    const exits: (string | null)[] = [];
    const channel = openChannel(target, exits);
    const uncaught = await withUncaughtCapture(async () => {
      await channel.start();
      // Whether a broken pipe surfaces as EPIPE (process gone, socket still
      // open) or ERR_STREAM_DESTROYED depends on kernel timing the test cannot
      // pin, so drive the invariant directly: an 'error' on a channel stream
      // must never reach the process. Without a listener each of these is an
      // uncaught exception that kills the daemon.
      const proc = (channel as unknown as { proc: { stdin: NodeJS.EventEmitter } }).proc;
      const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      proc.stdin.emit("error", epipe);
      await channel.dispose();
    });

    expect(uncaught).toEqual([]);
    runTmux(["kill-session", "-t", `=${target}`]);
  });
});
