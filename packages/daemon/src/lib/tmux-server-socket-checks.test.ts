import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  tmuxSelectorSocketPath,
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
});
