import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it, vi } from "vitest";

import { APP_HOST_SESSION, hostedCommandLine, hostCreateArgv } from "./hosted.ts";

const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
const hasBun = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
const socketName = `zz-host-death-${process.pid}-${randomUUID().slice(0, 8)}`;
const fixture = fileURLToPath(
  new URL("../../../test-support/hosted-reattach-fixture.tsx", import.meta.url),
);

function runTmux(argv: readonly string[]): string {
  return execFileSync("tmux", ["-L", socketName, "-f", "/dev/null", ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TMUX: "" },
  }).trimEnd();
}

function processIdentity(pid: number): string | null {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "command="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const identity = result.stdout.trim();
  return result.status === 0 && identity ? identity : null;
}

describe.skipIf(!hasTmux || !hasBun)("hosted OpenTUI host death", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

  const root = mkdtempSync(join(tmpdir(), "tmux-ide-host-death-"));
  const tracePath = join(root, "renderer-trace.jsonl");
  const sourceSession = "zz-authoritative-source";
  const sourceMarker = "AUTHORITATIVE-SOURCE-SURVIVES-HOST-DEATH";
  let rendererPid: number | null = null;
  let rendererIdentity: string | null = null;

  afterAll(() => {
    // Defense-in-depth is exact: this test never scans or kills ambient app
    // processes and only reaps the immutable PID identity it created.
    if (rendererPid !== null && rendererIdentity !== null) {
      if (processIdentity(rendererPid) === rendererIdentity) {
        try {
          process.kill(rendererPid, "SIGKILL");
        } catch {
          // It exited after the identity probe.
        }
      }
    }
    spawnSync("tmux", ["-L", socketName, "kill-server"], { stdio: "ignore" });
    rmSync(root, { recursive: true, force: true });
  });

  it("destroys the renderer with its private host while preserving the source session", async () => {
    runTmux([
      "new-session",
      "-d",
      "-s",
      sourceSession,
      `exec sh -c 'printf ${sourceMarker}; sleep 2147483647'`,
    ]);
    const commandLine = hostedCommandLine("bun", ["--conditions=browser", fixture], {
      TMUX_IDE_HOSTED: "1",
      TMUX_IDE_REATTACH_TRACE: tracePath,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    });
    runTmux(hostCreateArgv({ cwd: dirname(fixture), commandLine }));

    await vi.waitFor(
      () => {
        expect(existsSync(tracePath)).toBe(true);
        expect(
          runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_dead}"]),
        ).toBe("0");
      },
      { timeout: 20_000, interval: 100 },
    );
    rendererPid = Number(
      runTmux(["display-message", "-p", "-t", `=${APP_HOST_SESSION}:0.0`, "#{pane_pid}"]),
    );
    rendererIdentity = processIdentity(rendererPid);
    expect(rendererIdentity).not.toBeNull();

    runTmux(["kill-session", "-t", `=${APP_HOST_SESSION}`]);

    await vi.waitFor(() => expect(processIdentity(rendererPid!)).not.toBe(rendererIdentity), {
      timeout: 10_000,
      interval: 50,
    });
    expect(runTmux(["display-message", "-p", "-t", `${sourceSession}:0.0`, "#{pane_dead}"])).toBe(
      "0",
    );
    expect(runTmux(["capture-pane", "-p", "-t", `${sourceSession}:0.0`])).toContain(sourceMarker);
  });
});
