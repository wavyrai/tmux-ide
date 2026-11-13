import { describe, expect, it, vi } from "vitest";
import { logger } from "./log.ts";
import {
  commandTargetsServer,
  createOrphanedControlClientWatch,
  evictOrphanedControlClients,
  isTmuxIdeControlClientCommand,
  parseProcessTable,
  type OrphanedControlClientIo,
  type ProcessRow,
} from "./orphaned-control-clients.ts";

const SOCKET = "/tmp/tmi-e2e-soak-x/t.sock";
const attach = (socket = `-S ${SOCKET}`) =>
  `/opt/tmux ${socket} -C if-shell -F #{&&:#{==:#{pid},88939},#{==:#{start_time},1794513892}} 'attach' '-t' 'work' '-f' 'ignore-size,pause-after=2,active-pane' display-message -p 'tmux-server-generation-refused'`;
const SERVER = { kind: "path", path: SOCKET } as const;

function io(processes: ProcessRow[]) {
  const alive = new Set(processes.map((row) => row.pid));
  const killed: [number, string][] = [];
  const fake: OrphanedControlClientIo & { killed: typeof killed; alive: typeof alive } = {
    alive,
    killed,
    listProcesses: async () => processes.filter((row) => alive.has(row.pid)),
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      if (signal === "SIGKILL") alive.delete(pid);
    },
    isAlive: (pid) => alive.has(pid),
    delay: async () => undefined,
  };
  return fake;
}

// Soak, 12 Nov, and reproduced on a private server: a daemon stopped for a
// few seconds and then killed left its control client alive under init.
// `tmux kill-server` then never finished and the next daemon answered 503
// for 16 minutes.
describe("control clients left behind by a daemon that died", () => {
  it("reads a process table", () => {
    expect(
      parseProcessTable(`  501     1 /sbin/launchd\n94332     1 ${attach()}\n\ngarbage\n`),
    ).toEqual([
      { pid: 501, ppid: 1, command: "/sbin/launchd" },
      { pid: 94332, ppid: 1, command: attach() },
    ]);
  });

  it("recognises the daemon's own control client by its attach flags", () => {
    expect(isTmuxIdeControlClientCommand(attach())).toBe(true);
    expect(
      isTmuxIdeControlClientCommand(
        "tmux -L x -C attach -t work -f ignore-size,pause-after=2,active-pane",
      ),
    ).toBe(true);
    expect(isTmuxIdeControlClientCommand("tmux -CC attach -t work")).toBe(false);
    // Review E1: another program's control-mode integration attaches with -CC.
    // It is never ours, even with this product's exact flags.
    expect(
      isTmuxIdeControlClientCommand(
        `tmux -S ${SOCKET} -CC attach -t work -f ignore-size,pause-after=2,active-pane`,
      ),
    ).toBe(false);
    expect(isTmuxIdeControlClientCommand(attach().replace(" -C ", " -CC "))).toBe(false);
    expect(isTmuxIdeControlClientCommand("tmux -C attach -t work -f pause-after=2")).toBe(false);
    expect(isTmuxIdeControlClientCommand("tmux attach -t work")).toBe(false);
  });

  it("matches a command to its server by socket path or name, before the -C", () => {
    expect(commandTargetsServer(attach(), SERVER)).toBe(true);
    // macOS spells the same socket two ways.
    expect(commandTargetsServer(attach(`-S /private${SOCKET}`), SERVER)).toBe(true);
    expect(commandTargetsServer(attach(`-S${SOCKET}`), SERVER)).toBe(true);
    expect(commandTargetsServer(attach("-S /tmp/other/t.sock"), SERVER)).toBe(false);
    expect(commandTargetsServer(attach("-L work"), SERVER)).toBe(false);
    expect(commandTargetsServer(attach("-L work"), { kind: "name", name: "work" })).toBe(true);
    expect(commandTargetsServer(attach("-L work2"), { kind: "name", name: "work" })).toBe(false);
    // No selector at all, and a -S that belongs to the attached command.
    expect(commandTargetsServer(attach(""), SERVER)).toBe(false);
    expect(commandTargetsServer(`tmux -C attach -S ${SOCKET}`, SERVER)).toBe(false);
  });

  it("ends an orphaned control client of this server and nothing else", async () => {
    const fake = io([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      // Orphan: its daemon is gone, init adopted it.
      { pid: 94332, ppid: 1, command: attach() },
      // This daemon's own client, and this daemon.
      { pid: 94400, ppid: 4242, command: attach() },
      { pid: 4242, ppid: 1, command: "node cli.js --headless" },
      // An ordinary orphaned client, and another program's orphaned control client.
      { pid: 94500, ppid: 1, command: `tmux -S ${SOCKET} attach -t work` },
      { pid: 94600, ppid: 1, command: `tmux -S ${SOCKET} -CC attach -t work` },
      // Another live daemon's client on the same server.
      { pid: 94700, ppid: 5151, command: attach() },
      { pid: 5151, ppid: 1, command: "node cli.js --headless" },
      // An orphan of tmux-ide on ANOTHER server: not this owner's to end.
      { pid: 94800, ppid: 1, command: attach("-S /tmp/other/t.sock") },
    ]);
    await expect(evictOrphanedControlClients(fake, 4242, SERVER)).resolves.toEqual([94332]);
    expect(fake.killed).toEqual([
      [94332, "SIGTERM"],
      [94332, "SIGKILL"],
    ]);
  });

  it("does not escalate when the client leaves on the first signal", async () => {
    const fake = io([{ pid: 94332, ppid: 1, command: attach() }]);
    fake.kill = (pid, signal) => {
      fake.killed.push([pid, signal]);
      fake.alive.delete(pid);
    };
    await expect(evictOrphanedControlClients(fake, 4242, SERVER)).resolves.toEqual([94332]);
    expect(fake.killed).toEqual([[94332, "SIGTERM"]]);
  });

  it("never ends its own clients when the daemon is pid 1, as in a container", async () => {
    const fake = io([{ pid: 77, ppid: 1, command: attach() }]);
    await expect(evictOrphanedControlClients(fake, 1, SERVER)).resolves.toEqual([]);
    expect(fake.killed).toEqual([]);
  });

  it("treats a client adopted by a service manager as orphaned", async () => {
    const fake = io([
      { pid: 94332, ppid: 800, command: attach() },
      { pid: 800, ppid: 1, command: "/usr/lib/systemd/systemd --user" },
    ]);
    await expect(evictOrphanedControlClients(fake, 4242, SERVER)).resolves.toEqual([94332]);
  });

  // Review E1: the adopter is judged by the NAME of the parent's command, not
  // by a word anywhere in it. The owner's own daemon runs as
  // `cli.js --headless --supervised launchd-user` with live control clients.
  it.each([
    [
      "a live daemon supervised by launchd",
      "node /opt/tmux-ide/bin/cli.js --headless --supervised launchd-user",
    ],
    [
      "a live daemon supervised by systemd",
      "/usr/bin/node cli.js --headless --supervised systemd-user",
    ],
    ["git init", "git init /tmp/repo"],
    ["initdb", "/usr/bin/initdb -D /var/db"],
    ["systemd-run", "systemd-run --user sleep 60"],
    ["a script named after a manager", "/bin/sh /home/u/launchd-wrapper.sh"],
    ["a path that contains a manager's name", "/opt/systemd/bin/supervisor --watch"],
    ["a program given a manager's path as an argument", "/bin/sh -c /sbin/init"],
    ["a program given a manager's name as an argument", "watch systemd"],
  ])("leaves a client alone whose live parent is %s", async (_name, parentCommand) => {
    const fake = io([
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 700, ppid: 1, command: parentCommand },
      { pid: 94332, ppid: 700, command: attach() },
    ]);
    await expect(evictOrphanedControlClients(fake, 4242, SERVER)).resolves.toEqual([]);
    expect(fake.killed).toEqual([]);
  });

  it.each([
    ["/usr/lib/systemd/systemd --user"],
    ["systemd"],
    ["/sbin/launchd"],
    ["/sbin/init splash"],
    ["init"],
  ])("takes %s as a manager that adopted the client", async (parentCommand) => {
    const fake = io([
      { pid: 800, ppid: 1, command: parentCommand },
      { pid: 94332, ppid: 800, command: attach() },
    ]);
    await expect(evictOrphanedControlClients(fake, 4242, SERVER)).resolves.toEqual([94332]);
  });

  it("does nothing, and does not throw, when the process table cannot be read", async () => {
    const failing = io([]);
    (failing as { listProcesses: unknown }).listProcesses = async () => {
      throw new Error("ps failed");
    };
    await expect(evictOrphanedControlClients(failing, 4242, SERVER)).resolves.toEqual([]);
  });
});

describe("the watch one owner keeps on its server", () => {
  it("passes once at ownership and logs what it ended", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const fake = io([{ pid: 94332, ppid: 1, command: attach() }]);
      const watch = createOrphanedControlClientWatch({
        selector: SERVER,
        serverId: "tmux-server.a",
        io: fake,
      });
      await watch.onOwnership();
      expect(warn.mock.calls).toEqual([
        [
          "tmux-server-owners",
          "ended control clients a dead daemon left attached",
          { serverId: "tmux-server.a", pids: [94332] },
        ],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("on a troubled server: one pass per 10 s, one line per minute, never a rejection", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      let clock = 1_000_000;
      const fake = io([]);
      const list = vi.spyOn(fake, "listProcesses");
      const watch = createOrphanedControlClientWatch({
        selector: SERVER,
        serverId: null,
        io: fake,
        now: () => clock,
      });
      await watch.onTrouble("no-sessions");
      await watch.onTrouble("no-sessions");
      expect(list).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls).toEqual([
        ["tmux-server-owners", "tmux server answers with no sessions", { endedControlClients: 0 }],
      ]);
      clock += 10_000;
      await watch.onTrouble("unanswered");
      expect(list).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(1);
      clock += 60_000;
      list.mockRejectedValueOnce(new Error("ps failed"));
      await expect(watch.onTrouble("unanswered")).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[1]).toEqual([
        "tmux-server-owners",
        "tmux server does not answer its catalog",
        { endedControlClients: 0 },
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
