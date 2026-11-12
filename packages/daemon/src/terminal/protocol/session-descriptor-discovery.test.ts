import { describe, expect, it } from "vitest";

import {
  SESSION_PANE_DESCRIPTOR_FORMAT,
  SessionDescriptorDiscovery,
  decodeTmuxArgument,
  parseSessionPaneDescriptors,
  sameSessionPaneInventory,
} from "./session-descriptor-discovery.ts";

function line(runtimePaneId: string, cwd = "/repo", title = "Shell"): string {
  return `${runtimePaneId}\tpane-one\tshell\tshell\tzsh\t${cwd}\t0\tmain\t@1\t${title}\t$1\t0\tShell\tmission-one\t1\t1\twindow-one\tzz-sim\t1\t1\t`;
}

function controlModeBytes(value: string): string {
  return Buffer.from(value, "utf8").toString("latin1");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SessionDescriptorDiscovery", () => {
  it("uses qa encoding and decodes tabs, newlines, spaces, and backslashes", () => {
    expect(SESSION_PANE_DESCRIPTOR_FORMAT).toContain("#{qa:pane_current_path}");
    expect(decodeTmuxArgument("/repo/a\\tb\\nline\\\\tail\\ path")).toBe(
      "/repo/a\tb\nline\\tail path",
    );
    expect(decodeTmuxArgument('"bad stamp\\tvalue"')).toBe("bad stamp\tvalue");
  });

  it("recovers UTF-8 cwd and title values from tmux control-feed latin1 byte strings", () => {
    const cwd = "/repo/café 😀";
    const title = "Review café 😀";
    const replyLine = controlModeBytes(
      `%21\t"pane-one"\t"lead"\t"agent"\t"codex"\t"${cwd}"\t0\t"mission"\t@1\t"${title}"\t$1\t0\t"Agent"\t"mission-one"\t1\t1\t"window-one"\t"zz-sim"\t1\t1\t`,
    );

    expect(parseSessionPaneDescriptors([replyLine])).toEqual([
      expect.objectContaining({
        runtimePaneId: "%21",
        cwd,
        title,
      }),
    ]);
  });

  it("applies the native inventory value and reply bounds", () => {
    // An overlong title (stock tmux titles panes with kitty graphics APCs) is
    // ignored; the pane itself stays in the inventory.
    expect(parseSessionPaneDescriptors([line("%1", "/repo", "x".repeat(1_025))])).toEqual([
      expect.objectContaining({ runtimePaneId: "%1", title: null }),
    ]);
    expect(parseSessionPaneDescriptors([line("%1", "/x".repeat(2_049))])).toEqual([]);
    expect(parseSessionPaneDescriptors(Array.from({ length: 4_097 }, () => line("%1")))).toEqual(
      [],
    );
    const noncanonical = line("%1").split("\t");
    noncanonical[11] = "1e2";
    expect(parseSessionPaneDescriptors([noncanonical.join("\t")])).toEqual([]);
    expect(parseSessionPaneDescriptors([line("%01")])).toEqual([]);
  });

  it("rejects malformed UTF-8 safely and exposes a discovery diagnostic", async () => {
    const malformed = Buffer.concat([
      Buffer.from("%7\tpane-one\tshell\tshell\tzsh\t/repo/", "ascii"),
      Buffer.from([0xff]),
      Buffer.from(
        "\t0\tmain\t@1\tShell\t$1\t0\tShell\tmission-one\t1\t1\twindow-one\tzz-sim\t1\t1\t",
        "ascii",
      ),
    ]).toString("latin1");
    const statuses: unknown[] = [];
    const discovery = new SessionDescriptorDiscovery({
      query: () => Promise.resolve([malformed]),
      onDescriptors: () => {},
      onStatus: (status) => statuses.push(status),
      maxAttempts: 1,
    });

    expect(() => parseSessionPaneDescriptors([malformed])).not.toThrow();
    expect(parseSessionPaneDescriptors([malformed])).toEqual([]);
    discovery.discover(new Set(["%7"]));
    await flushPromises();
    expect(statuses.at(-1)).toMatchObject({
      status: "failed",
      degraded: true,
      attempt: 1,
      message: expect.stringContaining("malformed UTF-8 record was omitted"),
    });
  });

  it("publishes healthy descriptors from a mixed reply and reports partial degradation", async () => {
    const malformed = Buffer.concat([
      Buffer.from("%8\tpane-two\tshell\tshell\tzsh\t/repo/", "ascii"),
      Buffer.from([0xff]),
      Buffer.from(
        "\t0\tmain\t@1\tBroken\t$1\t0\tShell\tmission-one\t1\t1\twindow-one\tzz-sim\t1\t1\t",
        "ascii",
      ),
    ]).toString("latin1");
    const statuses: unknown[] = [];
    const discoveries: unknown[] = [];
    const scheduled: unknown[] = [];
    const discovery = new SessionDescriptorDiscovery({
      query: () =>
        Promise.resolve([controlModeBytes(line("%7", "/repo/café", "Healthy 😀")), malformed]),
      onDescriptors: (descriptors) => discoveries.push(descriptors),
      onStatus: (status) => statuses.push(status),
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return () => {};
      },
    });

    discovery.discover(new Set(["%7", "%8"]));
    await flushPromises();

    expect(discoveries).toEqual([
      [expect.objectContaining({ runtimePaneId: "%7", cwd: "/repo/café", title: "Healthy 😀" })],
    ]);
    expect(statuses.at(-1)).toMatchObject({
      status: "partial",
      degraded: true,
      attempt: 1,
      retryInMs: null,
      message: expect.stringContaining("published 1 of 2 live panes"),
    });
    expect(scheduled).toEqual([]);
  });

  it("retries with bounded backoff and clears the diagnostic after success", async () => {
    let queryCount = 0;
    const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
    const statuses: unknown[] = [];
    const discoveries: unknown[] = [];
    const discovery = new SessionDescriptorDiscovery({
      query: () => {
        queryCount += 1;
        return queryCount === 1
          ? Promise.reject(new Error("temporary failure"))
          : Promise.resolve([line("%7", "/repo/apps\\ web")]);
      },
      onDescriptors: (descriptors) => discoveries.push(descriptors),
      onStatus: (status) => statuses.push(status),
      maxAttempts: 3,
      baseDelayMs: 10,
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return () => {};
      },
    });

    discovery.discover(new Set(["%7"]));
    await flushPromises();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.delayMs).toBe(10);
    expect(statuses[0]).toMatchObject({ status: "retrying", attempt: 1, retryInMs: 10 });

    scheduled[0]!.callback();
    await flushPromises();
    expect(queryCount).toBe(2);
    expect(statuses.at(-1)).toBeNull();
    expect(discoveries).toEqual([
      [expect.objectContaining({ runtimePaneId: "%7", cwd: "/repo/apps web" })],
    ]);
  });

  it("drops superseded and disposed replies without retries or stale publication", async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    const third = deferred<string[]>();
    const pending = [first, second, third];
    const discoveries: string[][] = [];
    const statuses: unknown[] = [];
    const scheduled: unknown[] = [];
    const discovery = new SessionDescriptorDiscovery({
      query: () => pending.shift()!.promise,
      onDescriptors: (descriptors) =>
        discoveries.push(descriptors.map((descriptor) => descriptor.runtimePaneId)),
      onStatus: (status) => statuses.push(status),
      schedule: (callback, delayMs) => {
        scheduled.push({ callback, delayMs });
        return () => {};
      },
    });

    discovery.discover(new Set(["%1"]));
    discovery.discover(new Set(["%2"]));
    first.resolve([line("%1")]);
    second.resolve([line("%2")]);
    await flushPromises();
    expect(discoveries).toEqual([["%2"]]);

    discovery.discover(new Set(["%3"]));
    discovery.dispose();
    third.reject(new Error("late failure"));
    await flushPromises();
    expect(discoveries).toEqual([["%2"]]);
    expect(scheduled).toEqual([]);
    expect(statuses).toEqual([null]);
  });

  it("stops after the configured attempt bound and exposes terminal failure", async () => {
    const scheduled: Array<() => void> = [];
    const statuses: unknown[] = [];
    const discovery = new SessionDescriptorDiscovery({
      query: () => Promise.reject(new Error("offline")),
      onDescriptors: () => {},
      onStatus: (status) => statuses.push(status),
      maxAttempts: 3,
      baseDelayMs: 1,
      schedule: (callback) => {
        scheduled.push(callback);
        return () => {};
      },
    });

    discovery.discover(new Set(["%9"]));
    await flushPromises();
    scheduled[0]!();
    await flushPromises();
    scheduled[1]!();
    await flushPromises();
    expect(statuses.slice(0, 2)).toEqual([
      expect.objectContaining({ status: "retrying", attempt: 1, retryInMs: 1 }),
      expect.objectContaining({ status: "retrying", attempt: 2, retryInMs: 2 }),
    ]);
    expect(statuses.at(-1)).toMatchObject({ status: "failed", attempt: 3, retryInMs: null });
    expect(scheduled).toHaveLength(2);
  });
});

it("reads explicit name provenance without confusing it with a pane identity", () => {
  const result = parseSessionPaneDescriptors([`${line("%3")}\tmanual`]);
  expect(result[0]).toMatchObject({ runtimePaneId: "%3", name: "Shell", nameSource: "manual" });
  expect(parseSessionPaneDescriptors([`${line("%3")}\tuntrusted`])[0]?.nameSource).toBeNull();
});

it("carries live browser icon metadata without changing pane identity", () => {
  const icon = "ff00807f".repeat(256);
  const record = `${line("%3")}\tmanual\t${process.pid}:${icon}`;
  expect(parseSessionPaneDescriptors([record])[0]).toMatchObject({
    runtimePaneId: "%3",
    browserIcon: icon,
  });
  expect(parseSessionPaneDescriptors([`${line("%3")}\tmanual\tbad`])[0]).toMatchObject({
    runtimePaneId: "%3",
    browserIcon: null,
  });
});

it("carries a live reader's file name and path, and drops a dead or malformed one", () => {
  const option = JSON.stringify({ version: 1, pid: process.pid, path: "/repo/docs/notes.md" });
  // tmux `qa` escapes the option as one argument.
  const quoted = `"${option.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  expect(SESSION_PANE_DESCRIPTOR_FORMAT.endsWith("\t#{qa:@tmux_ide_reader}\t#{pane_pid}")).toBe(
    true,
  );
  const record = (raw: string, panePid: string | number = process.pid) =>
    `${line("%3")}\tmanual\t\t${raw}\t${panePid}`;
  expect(parseSessionPaneDescriptors([record(quoted)])[0]).toMatchObject({
    runtimePaneId: "%3",
    reader: { name: "notes.md", path: "/repo/docs/notes.md", pid: process.pid },
  });
  const dead = JSON.stringify({ version: 1, pid: 2 ** 31 - 2, path: "/repo/notes.md" });
  for (const raw of ["", "bad", dead])
    expect(parseSessionPaneDescriptors([record(raw, 2 ** 31 - 2)])[0]).toMatchObject({
      runtimePaneId: "%3",
      reader: null,
    });
});

it("drops a reader option that another process set on the pane (#353 round 2)", () => {
  const option = JSON.stringify({ version: 1, pid: process.pid, path: "/repo/docs/notes.md" });
  const quoted = `"${option.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  for (const panePid of [process.pid + 1, "", "abc"])
    expect(
      parseSessionPaneDescriptors([`${line("%3")}\tmanual\t\t${quoted}\t${panePid}`])[0],
    ).toMatchObject({ runtimePaneId: "%3", reader: null });
});

it("drops a reader whose file name has a C1 control character, keeping the pane", () => {
  const option = JSON.stringify({ version: 1, pid: process.pid, path: "/repo/no\u0085tes.md" });
  const quoted = `"${option.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  expect(
    // Control mode delivers UTF-8 bytes; the C1 character is two of them.
    parseSessionPaneDescriptors([
      controlModeBytes(`${line("%3")}\tmanual\t\t${quoted}\t${process.pid}`),
    ])[0],
  ).toMatchObject({ runtimePaneId: "%3", reader: null });
});

describe("sameSessionPaneInventory (#730)", () => {
  const fields = SESSION_PANE_DESCRIPTOR_FORMAT.split("\t");
  const row = (change: Record<number, string> = {}) =>
    fields.map((_, index) => change[index] ?? `v${index}`).join("\t");

  it("ignores a pane's command, title and the window name tmux derives from the command", () => {
    expect(fields[4]).toBe("#{qa:pane_current_command}");
    expect(fields[7]).toBe("#{qa:window_name}");
    expect(fields[9]).toBe("#{qa:pane_title}");
    expect(
      sameSessionPaneInventory(
        [row({ 4: "zsh", 7: "zsh", 9: "~/repo" }), row()],
        [row({ 4: "seq", 7: "seq", 9: "seq 1 100000" }), row()],
      ),
    ).toBe(true);
  });

  it("still sees every other field change, and a changed pane count or order", () => {
    for (let index = 0; index < fields.length; index += 1) {
      if (index === 4 || index === 7 || index === 9) continue;
      expect(sameSessionPaneInventory([row()], [row({ [index]: "changed" })]), fields[index]).toBe(
        false,
      );
    }
    expect(sameSessionPaneInventory([row()], [row(), row()])).toBe(false);
    expect(sameSessionPaneInventory([row({ 0: "%1" }), row({ 0: "%2" })], [
      row({ 0: "%2" }),
      row({ 0: "%1" }),
    ])).toBe(false);
    expect(sameSessionPaneInventory([], [])).toBe(true);
  });
});
