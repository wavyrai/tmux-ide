import { describe, expect, it, vi } from "vitest";
import { logger } from "./log.ts";
import {
  evictOrphanedControlClients,
  evictOrphanedControlClientsOnOwnership,
  isTmuxIdeControlClientCommand,
  type OrphanedControlClientIo,
} from "./orphaned-control-clients.ts";

const ATTACH =
  "/opt/tmux -S /tmp/t.sock -C if-shell -F #{&&:#{==:#{pid},88939},#{==:#{start_time},1794513892}} 'attach' '-t' 'work' '-f' 'ignore-size,pause-after=2,active-pane' display-message -p 'tmux-server-generation-refused'";

function io(
  clients: string,
  processes: Record<number, { ppid: number; command: string }>,
): OrphanedControlClientIo & { killed: [number, string][]; alive: Set<number> } {
  const alive = new Set(Object.keys(processes).map(Number));
  const killed: [number, string][] = [];
  return {
    alive,
    killed,
    listClients: async () => clients,
    describe: async (pid) => (alive.has(pid) ? (processes[pid] ?? null) : null),
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      if (signal === "SIGKILL") alive.delete(pid);
    },
    isAlive: (pid) => alive.has(pid),
    delay: async () => undefined,
  };
}

// Soak, 12 Nov: a daemon killed with SIGKILL left its control client attached.
// A later `tmux kill-server` could not finish while that client stayed, the
// socket kept a server with no sessions, and the next daemon answered 503
// for 16 minutes.
describe("control clients left behind by a daemon that died", () => {
  it("recognises the daemon's own control client by its attach flags", () => {
    expect(isTmuxIdeControlClientCommand(ATTACH)).toBe(true);
    expect(
      isTmuxIdeControlClientCommand(
        "tmux -L x -C attach -t work -f ignore-size,pause-after=2,active-pane",
      ),
    ).toBe(true);
    // Another program's control client, and an ordinary client.
    expect(isTmuxIdeControlClientCommand("tmux -CC attach -t work")).toBe(false);
    expect(isTmuxIdeControlClientCommand("tmux -C attach -t work -f pause-after=2")).toBe(false);
    expect(isTmuxIdeControlClientCommand("tmux attach -t work")).toBe(false);
  });

  it("ends an orphaned control client of tmux-ide and nothing else", async () => {
    const fake = io("94332\t1\n94400\t1\n94500\t0\n94600\t1\n94700\t1\nnot-a-row\n", {
      // Orphan: its daemon is gone, init adopted it.
      94332: { ppid: 1, command: ATTACH },
      // This daemon's own client.
      94400: { ppid: 4242, command: ATTACH },
      // An ordinary client that happens to be orphaned.
      94500: { ppid: 1, command: "tmux attach -t work" },
      // Another program's orphaned control client.
      94600: { ppid: 1, command: "tmux -CC attach -t work" },
      // Another live daemon's client.
      94700: { ppid: 5151, command: ATTACH },
      4242: { ppid: 1, command: "node cli.js --headless" },
      5151: { ppid: 1, command: "node cli.js --headless" },
    });
    await expect(evictOrphanedControlClients(fake, 4242)).resolves.toEqual([94332]);
    expect(fake.killed).toEqual([
      [94332, "SIGTERM"],
      [94332, "SIGKILL"],
    ]);
  });

  it("does not escalate when the client leaves on the first signal", async () => {
    const fake = io("94332\t1\n", { 94332: { ppid: 1, command: ATTACH } });
    fake.kill = (pid, signal) => {
      fake.killed.push([pid, signal]);
      fake.alive.delete(pid);
    };
    await expect(evictOrphanedControlClients(fake, 4242)).resolves.toEqual([94332]);
    expect(fake.killed).toEqual([[94332, "SIGTERM"]]);
  });

  it("never ends its own clients when the daemon is pid 1, as in a container", async () => {
    const fake = io("77\t1\n", { 77: { ppid: 1, command: ATTACH } });
    await expect(evictOrphanedControlClients(fake, 1)).resolves.toEqual([]);
    expect(fake.killed).toEqual([]);
  });

  it("leaves a client that tmux does not list as control mode", async () => {
    const fake = io("94332\t0\n", { 94332: { ppid: 1, command: ATTACH } });
    await expect(evictOrphanedControlClients(fake, 4242)).resolves.toEqual([]);
    expect(fake.killed).toEqual([]);
  });

  it("treats a client adopted by a service manager as orphaned", async () => {
    const fake = io("94332\t1\n", {
      94332: { ppid: 800, command: ATTACH },
      800: { ppid: 1, command: "/usr/lib/systemd/systemd --user" },
    });
    await expect(evictOrphanedControlClients(fake, 4242)).resolves.toEqual([94332]);
  });

  it("asks the owner's server once, logs what it ended, and never rejects", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const fake = io("94332\t1\n", { 94332: { ppid: 1, command: ATTACH } });
      const runTmux = vi.fn(async () => "94332\t1\n");
      await evictOrphanedControlClientsOnOwnership(runTmux, "tmux-server.a", (listClients) => ({
        ...fake,
        listClients,
        kill: fake.kill,
      }));
      expect(runTmux).toHaveBeenCalledExactlyOnceWith([
        "list-clients",
        "-F",
        "#{client_pid}\t#{client_control_mode}",
      ]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "tmux-server-owners",
        "ended control clients a dead daemon left attached",
        { serverId: "tmux-server.a", pids: [94332] },
      );
      warn.mockClear();
      // Nothing to end: no line. A failing tmux: no rejection.
      await evictOrphanedControlClientsOnOwnership(
        async () => "",
        null,
        () => io("", {}),
      );
      await expect(
        evictOrphanedControlClientsOnOwnership(
          async () => {
            throw new Error("no server");
          },
          null,
          (listClients) => ({ ...io("", {}), listClients }),
        ),
      ).resolves.toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("does nothing, and does not throw, when the list or a lookup fails", async () => {
    const failing = io("", {});
    failing.listClients = vi.fn(async () => {
      throw new Error("no server");
    });
    await expect(evictOrphanedControlClients(failing, 4242)).resolves.toEqual([]);
    const vanished = io("94332\t1\n", {});
    await expect(evictOrphanedControlClients(vanished, 4242)).resolves.toEqual([]);
    expect(vanished.killed).toEqual([]);
  });
});
