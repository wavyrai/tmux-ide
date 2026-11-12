import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  processIsNotTmuxServer,
  tmuxSelectorSocketPath,
  tmuxServerProcessReplaced,
  tmuxServerSocketPresent,
  unixSocketRefusesConnections,
} from "./tmux-server-registration.ts";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(() => resolve(null)))),
  );
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function listening(): Promise<string> {
  const directory = mkdtempSync("/tmp/tmux-ide-test-socket-");
  directories.push(directory);
  const path = join(directory, "s.sock");
  const server = createServer((socket) => socket.destroy());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return path;
}

describe("cheap checks on a tmux server socket (no subprocess)", () => {
  it("finds a named socket where the daemon's scrubbed tmux clients look, never in TMUX_TMPDIR", () => {
    expect(tmuxSelectorSocketPath({ kind: "path", path: "/x/y.sock" })).toBe("/x/y.sock");
    expect(tmuxSelectorSocketPath({ kind: "name", name: "work" })).toBe(
      `/tmp/tmux-${String(process.getuid?.() ?? 0)}/work`,
    );
  });

  it("says whether a socket file exists", async () => {
    const path = await listening();
    expect(tmuxServerSocketPresent({ kind: "path", path })).toBe(true);
    expect(tmuxServerSocketPresent({ kind: "path", path: `${path}.missing` })).toBe(false);
    expect(tmuxServerSocketPresent({ kind: "path", path: join(path, "below-a-file") })).toBe(false);
    const regular = join(directories[0]!, "regular");
    writeFileSync(regular, "");
    expect(tmuxServerSocketPresent({ kind: "path", path: regular })).toBe(false);
  });

  it("tells a listening socket from one nobody listens on", async () => {
    const path = await listening();
    expect(await unixSocketRefusesConnections(path)).toBe(false);
    expect(await unixSocketRefusesConnections(`${path}.missing`)).toBe(true);
    const regular = join(directories[0]!, "regular");
    writeFileSync(regular, "");
    expect(await unixSocketRefusesConnections(regular)).toBe(true);
    // The listener goes away but leaves its socket file: refused.
    const stale = await listening();
    const holder = servers.pop()!;
    // Closing unlinks the file in Node, so keep a hard reference by recreating it as a plain file.
    await new Promise((resolve) => holder.close(() => resolve(null)));
    writeFileSync(stale, "");
    expect(await unixSocketRefusesConnections(stale)).toBe(true);
  });

  // Review C1: a refusal is what a stalled live server looks like too, so the owner's fate is
  // decided by who has the server's pid, never by a refused connection.
  describe("is the server's pid still that tmux server?", () => {
    const now = 1_794_500_000;
    it("says another process has the pid when the command is not tmux", () => {
      expect(processIsNotTmuxServer("   02:13 /usr/bin/node", String(now - 133), now)).toBe(true);
      expect(processIsNotTmuxServer("12-07:10:40 sleep", String(now - 1_062_640), now)).toBe(true);
    });
    it("says another process has the pid when it started at another time", () => {
      // A tmux, but one that started an hour after the server we knew.
      expect(processIsNotTmuxServer("   02:13 tmux", String(now - 3_733), now)).toBe(true);
    });
    it("recognises the same server, in any spelling of its command", () => {
      for (const command of [
        "tmux",
        "tmux: server",
        "/opt/homebrew/bin/tmux",
        "/Users/a b/tmux-ide/native/tmux/darwin-arm64/tmux",
      ])
        expect(processIsNotTmuxServer(`12-07:10:40 ${command}`, String(now - 1_062_640), now)).toBe(
          false,
        );
      // A few seconds between the process start and the server's own clock reading are normal.
      expect(processIsNotTmuxServer("   02:13 tmux", String(now - 133 + 4), now)).toBe(false);
      expect(processIsNotTmuxServer("01:02:13 tmux", String(now - 3_733), now)).toBe(false);
    });
    it("decides nothing from output it cannot read", () => {
      for (const line of ["", "garbage", "tmux", "02:13"])
        expect(processIsNotTmuxServer(line, String(now), now)).toBe(false);
      expect(processIsNotTmuxServer("   02:13 tmux", "not-a-number", now)).toBe(false);
    });
    it("asks ps about a real process and never throws", async () => {
      // This test process is alive and is not tmux.
      expect(await tmuxServerProcessReplaced({ pid: String(process.pid), startTime: "1" })).toBe(
        true,
      );
      expect(await tmuxServerProcessReplaced({ pid: "0", startTime: "1" })).toBe(false);
      expect(await tmuxServerProcessReplaced({ pid: "abc", startTime: "1" })).toBe(false);
      // A pid nobody has: ps fails, nothing is decided (liveness is a separate check).
      expect(await tmuxServerProcessReplaced({ pid: "4194301", startTime: "1" })).toBe(false);
    });
  });
});
