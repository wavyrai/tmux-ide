import { describe, expect, it } from "vitest";

import {
  SESSION_PANE_DESCRIPTOR_FORMAT,
  SessionDescriptorDiscovery,
  decodeTmuxArgument,
  parseSessionPaneDescriptors,
} from "./session-descriptor-discovery.ts";

function line(runtimePaneId: string, cwd = "/repo", title = "Shell"): string {
  return `${runtimePaneId}\tpane-one\tshell\tshell\tzsh\t${cwd}\t0\tmain\t@1\t${title}`;
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

  it("recovers UTF-8 cwd and title values from ControlModeClient latin1 byte strings", () => {
    const cwd = "/repo/café 😀";
    const title = "Review café 😀";
    const replyLine = controlModeBytes(
      `%21\t"pane-one"\t"lead"\t"agent"\t"codex"\t"${cwd}"\t0\t"mission"\t@1\t"${title}"`,
    );

    expect(parseSessionPaneDescriptors([replyLine])).toEqual([
      expect.objectContaining({
        runtimePaneId: "%21",
        cwd,
        title,
      }),
    ]);
  });

  it("rejects malformed UTF-8 safely and exposes a discovery diagnostic", async () => {
    const malformed = Buffer.concat([
      Buffer.from("%7\tpane-one\tshell\tshell\tzsh\t/repo/", "ascii"),
      Buffer.from([0xff]),
      Buffer.from("\t0\tmain\t@1\tShell", "ascii"),
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
      Buffer.from("\t0\tmain\t@1\tBroken", "ascii"),
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
          : Promise.resolve([line("%7", "/repo/apps\\tweb")]);
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
      [expect.objectContaining({ runtimePaneId: "%7", cwd: "/repo/apps\tweb" })],
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
