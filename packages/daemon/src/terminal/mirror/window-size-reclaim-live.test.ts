import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";

const available = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

/**
 * #695: a second tmux client on the session (a terminal the user also attached)
 * takes the window under `window-size latest`. The app's own fit must win it
 * back, or what the user runs in the app prints at the other client's width and
 * tmux re-wraps it mid-word when that width goes away.
 */
describe.skipIf(!available)("the app wins the window back from another client (#695)", () => {
  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  function server() {
    const dir = mkdtempSync(join(tmpdir(), "tmi-695-"));
    const socket = join(dir, "t.sock");
    const run = (...args: string[]) =>
      execFileSync("tmux", ["-S", socket, "-f", "/dev/null", ...args], {
        encoding: "utf8",
        env: { ...process.env, TMUX: "" },
      }).trim();
    run("new-session", "-d", "-s", "proof", "-x", "80", "-y", "24", "sh");
    run("set-option", "-t", "proof", "status", "off");
    cleanups.push(() => {
      spawnSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    });
    const size = () =>
      run("display-message", "-p", "-t", "proof", "#{window_width}x#{window_height}");
    return { socket, run, size };
  }

  async function app(socket: string) {
    const service = new MirrorService({
      createIo: (session, handlers) =>
        new MirrorControlChannel({
          session,
          handlers,
          socketPath: socket,
          configFile: "/dev/null",
        }),
    });
    await service.retainSession("proof");
    service.setGeometryParticipation("proof", true);
    cleanups.push(() => service.dispose?.());
    return service;
  }

  /** A plain tmux client in control mode, sized like a terminal window. */
  function terminal(socket: string, cols: number, rows: number): ChildProcess {
    const child = spawn(
      "tmux",
      ["-S", socket, "-f", "/dev/null", "-C", "attach-session", "-t", "proof"],
      {
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, TMUX: "" },
      },
    );
    child.stdout!.resume();
    child.stdin!.write(`refresh-client -C ${cols}x${rows}\n`);
    cleanups.push(() => {
      child.kill();
    });
    return child;
  }

  it("prints at the app's width while a wider terminal is attached, so nothing re-wraps when it leaves", async () => {
    const { socket, run, size } = server();
    const service = await app(socket);
    service.fitViewport("proof", 97, 30);
    await vi.waitFor(() => expect(size()).toBe("97x30"));

    const other = terminal(socket, 160, 40);
    await vi.waitFor(() => expect(size()).toBe("160x40"));

    // The user comes back to the app: focusing it fits again, with the same grid.
    service.fitViewport("proof", 97, 30);
    await new Promise((resolve) => setTimeout(resolve, 500));

    // What runs now sees the app's width.
    run("send-keys", "-t", "proof", "c=$(tput cols); printf '%*s|\\n' $(( c - 1 )) ''", "Enter");
    const bars = () =>
      run("capture-pane", "-p", "-t", "proof")
        .split("\n")
        .filter((row) => /^ +\|$/u.test(row));
    await vi.waitFor(() => expect(bars()).toHaveLength(1));
    other.stdin!.end("detach-client\n");
    await vi.waitFor(() =>
      expect(run("list-clients", "-F", "#{client_width}").split("\n")).toEqual(["97"]),
    );
    const rows = run("capture-pane", "-p", "-t", "proof").split("\n").filter(Boolean);
    const joined = run("capture-pane", "-p", "-J", "-t", "proof").split("\n").filter(Boolean);
    // Rows tmux re-wrapped when the window narrowed back to the app's size.
    expect(rows.length - joined.length).toBe(0);
    expect(bars().map((row) => row.length)).toEqual([97]);
  });

  it("does not fight: the app wins the window only when it fits, never on its own", async () => {
    const { socket, size } = server();
    const service = await app(socket);
    service.fitViewport("proof", 97, 30);
    await vi.waitFor(() => expect(size()).toBe("97x30"));
    // A second app window (another process: one more control client) and a terminal.
    terminal(socket, 120, 35);
    await vi.waitFor(() => expect(size()).toBe("120x35"));
    terminal(socket, 160, 40);
    await vi.waitFor(() => expect(size()).toBe("160x40"));
    const sample = async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) {
        seen.add(size());
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return [...seen];
    };
    // Nobody fits: the window stays with the client that took it last.
    expect(await sample()).toEqual(["160x40"]);
    // The app's fit wins it, once, and it stays.
    service.fitViewport("proof", 97, 30);
    await vi.waitFor(() => expect(size()).toBe("97x30"), { timeout: 1500 });
    expect(await sample()).toEqual(["97x30"]);
  });
});
