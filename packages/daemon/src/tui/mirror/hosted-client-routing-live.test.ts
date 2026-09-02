import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { defaultNodePtyAdapter } from "../../terminal/NodePtyAdapter.ts";
import type { PtyProcess } from "../../terminal/PtyAdapter.ts";
import {
  APP_HOST_SESSION,
  hostPutAwayBindingArgv,
  hostRootBindingsArgv,
  hostedPutAwayBindingState,
} from "./hosted.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const socketName = `zz-hosted-client-routing-${process.pid}-${randomUUID().slice(0, 8)}`;

type ClientRow = Readonly<{
  name: string;
  pid: number;
  session: string;
  lastSession: string;
}>;

function runTmux(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
}

function inventory(): ClientRow[] {
  let output: string;
  try {
    output = runTmux([
      "list-clients",
      "-F",
      "#{client_name}\t#{client_pid}\t#{session_name}\t#{client_last_session}",
    ]);
  } catch {
    return [];
  }
  if (!output) return [];
  return output.split("\n").map((line) => {
    const [name, pid, session, lastSession] = line.split("\t");
    return { name: name!, pid: Number(pid), session: session!, lastSession: lastSession! };
  });
}

function attach(session: string, cols: number, rows: number): PtyProcess {
  return defaultNodePtyAdapter.spawnSync({
    shell: "tmux",
    args: ["-L", socketName, "-f", "/dev/null", "attach-session", "-t", `=${session}`],
    cwd: process.cwd(),
    cols,
    rows,
    env: { ...process.env, TMUX: "", TERM: "xterm-256color", COLORTERM: "truecolor" },
    name: "xterm-256color",
    encoding: null,
  });
}

function ctrlQ(client: PtyProcess): void {
  client.boundedInput.write(Uint8Array.of(0x11));
}

describe.skipIf(!hasTmux)("hosted exact-client Ctrl-Q routing", () => {
  vi.setConfig({ testTimeout: 30_000, hookTimeout: 10_000 });
  const clients: PtyProcess[] = [];

  afterAll(() => {
    for (const client of clients) {
      try {
        client.kill("SIGKILL");
      } catch {
        // The isolated server kill below is authoritative cleanup.
      }
    }
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
  });

  it("preserves a hidden live viewer, targets only the invoking viewer, and lets tmux reap dead PTYs", async () => {
    runTmux(["new-session", "-d", "-s", APP_HOST_SESSION, "cat"]);
    runTmux(["new-session", "-d", "-s", "return", "cat"]);
    expect(hostedPutAwayBindingState(runTmux(hostRootBindingsArgv()))).toBe("absent");
    runTmux(hostPutAwayBindingArgv());
    expect(hostedPutAwayBindingState(runTmux(hostRootBindingsArgv()))).toBe("owned");
    // Idempotent ensure: an owned binding is observed, not replaced.
    expect(hostedPutAwayBindingState(runTmux(hostRootBindingsArgv()))).toBe("owned");

    const rendererPid = Number(
      runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"]),
    );
    const returning = attach("return", 80, 24);
    const invoking = attach(APP_HOST_SESSION, 132, 41);
    clients.push(returning, invoking);
    await vi.waitFor(() => {
      expect(inventory().map(({ pid }) => pid)).toEqual(
        expect.arrayContaining([returning.pid, invoking.pid]),
      );
    });
    const returningName = inventory().find(({ pid }) => pid === returning.pid)!.name;
    runTmux(["switch-client", "-c", returningName, "-t", `=${APP_HOST_SESSION}`]);
    await vi.waitFor(() => {
      expect(inventory().find(({ pid }) => pid === returning.pid)).toMatchObject({
        session: APP_HOST_SESSION,
        lastSession: "return",
      });
    });

    // A hidden browser/terminal view may stop consuming output while its PTY
    // and wrapper remain live. It is legitimate and must never be reclaimed.
    returning.pause();
    ctrlQ(invoking);
    await vi.waitFor(() => {
      expect(inventory().find(({ pid }) => pid === invoking.pid)).toBeUndefined();
      expect(inventory().find(({ pid }) => pid === returning.pid)).toMatchObject({
        session: APP_HOST_SESSION,
      });
    });
    expect(
      Number(runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"])),
    ).toBe(rendererPid);

    returning.resume();
    ctrlQ(returning);
    await vi.waitFor(() => {
      expect(inventory().find(({ pid }) => pid === returning.pid)).toMatchObject({
        session: "return",
        lastSession: APP_HOST_SESSION,
      });
    });

    const deadPty = attach(APP_HOST_SESSION, 100, 30);
    clients.push(deadPty);
    await vi.waitFor(() => expect(inventory().some(({ pid }) => pid === deadPty.pid)).toBe(true));
    deadPty.kill("SIGTERM");
    await vi.waitFor(() => {
      expect(inventory().some(({ pid }) => pid === deadPty.pid)).toBe(false);
      expect(inventory().find(({ pid }) => pid === returning.pid)).toMatchObject({
        session: "return",
      });
    });
    expect(
      Number(runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"])),
    ).toBe(rendererPid);
  });
});
