import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRegistry } from "./workspace-registry.ts";
import {
  DEFAULT_HOOK_HEALTHCHECK_SCHEDULE,
  TmuxExternalInteractionObserver,
  internalInteractionOperationMarker,
  nextHookHealthcheckDelay,
  ownedHookInstalled,
  parseTmuxInputHookRecords,
  type ExternalTmuxInteractionObserverIo,
} from "./tmux-external-interaction-observer.ts";
import {
  createAuthenticatedInternalReadOperation,
  consumeInternalReadOperation,
  registerInternalReadOperation,
  retireInternalReadOperation,
} from "./tmux-interaction-options.ts";

const DAEMON = "21f2625e-d1a5-4ad2-9068-b1426bcc6651";
const OPERATION = "8be47b5a-43da-4632-9930-e1aba61c8da6";
const FIELD = "|tmux-ide-input-field-v1|";
const EVENT = "|tmux-ide-input-event-v1|";
const SEND = "workspace.pane.send";
const READ = "workspace.pane.read";
const FORGED_INTERNAL_READ = "tmux-ide-internal-read-v2:11111111-1111-4111-8111-111111111111";

const HOOK_NAMES = ["after-send-keys", "after-capture-pane"] as const;

/**
 * Mock `show-hooks` in tmux's real shape: one `name[index] body` line per
 * entry, or the bare name when the array is unset. The health check asks for
 * both arrays in one `;`-separated client, so every hook name in the argument
 * list is answered, in order.
 */
function showHooks(args: readonly string[], hooks: ReadonlyMap<string, string>): string {
  return HOOK_NAMES.filter((name) => args.includes(name))
    .map((name) => hooks.get(name) ?? name)
    .join("\n");
}

function registry(): WorkspaceRegistry {
  return {
    list: () => [
      {
        name: "workspace.project",
        sessionName: "project",
        projectDir: "/project",
      },
    ],
  } as unknown as WorkspaceRegistry;
}

function harness(
  raw: string,
  consumeOperationId: string | null = null,
  internalReadOwnerToken: string | null = null,
): {
  observer: TmuxExternalInteractionObserver;
  calls: readonly (readonly string[])[];
  observed: readonly {
    workspaceName: string;
    semanticPaneId: string;
    operationKind: typeof SEND | typeof READ;
    operationId: string | null;
  }[];
} {
  const calls: (readonly string[])[] = [];
  const observed: {
    workspaceName: string;
    semanticPaneId: string;
    operationKind: typeof SEND | typeof READ;
    operationId: string | null;
  }[] = [];
  let buffer = raw;
  const io: ExternalTmuxInteractionObserverIo = {
    runTmux: async (args) => {
      calls.push([...args]);
      if (args[0] === "show-hooks") {
        return showHooks(
          args,
          new Map([
            [
              "after-send-keys",
              "after-send-keys[3] display-message user-hook\nafter-send-keys[7] run-shell tmux-ide-interaction-v1-stale",
            ],
            [
              "after-capture-pane",
              "after-capture-pane[2] display-message user-capture\nafter-capture-pane[5] run-shell tmux-ide-interaction-v1-stale",
            ],
          ]),
        );
      }
      if (args[0] === "list-buffers") return "tmux-ide-interaction-v1-stale\nclipboard";
      if (args[0] === "set-buffer" && args.includes("-n")) return "";
      if (args[0] === "show-options") return buffer;
      if (args[0] === "set-option" && args[1] === "-gu" && args[2]?.endsWith("-drain")) {
        buffer = "";
        return "";
      }
      if (args[0] === "display-message") return "project\tpane.editor";
      return "";
    },
    waitForSignal: async () => undefined,
    delay: async () => undefined,
  };
  return {
    observer: new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      internalReadOwnerToken,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      io,
      onObserved: (interaction) => {
        observed.push(interaction);
        return interaction.operationId === consumeOperationId && consumeOperationId !== null;
      },
    }),
    calls,
    observed,
  };
}

function statefulHookHarness(): {
  observer: TmuxExternalInteractionObserver;
  calls: readonly (readonly string[])[];
  removeHooks(): void;
} {
  const calls: (readonly string[])[] = [];
  const hooks = new Map<string, string>();
  const io: ExternalTmuxInteractionObserverIo = {
    runTmux: async (args) => {
      calls.push([...args]);
      if (args[0] === "show-hooks") return showHooks(args, hooks);
      if (args[0] === "list-buffers") return "";
      if (args[0] === "set-hook" && args[1] === "-ag") {
        hooks.set(args[2]!, `${args[2]}[0] ${args[3]}`);
      }
      if (args[0] === "set-hook" && args[1] === "-gu") {
        const name = args[2]!.replace(/\[[0-9]+\]$/u, "");
        hooks.delete(name);
      }
      return "";
    },
    waitForSignal: async () => undefined,
    delay: async () => undefined,
  };
  return {
    observer: new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      io,
      onObserved: () => false,
    }),
    calls,
    removeHooks: () => hooks.clear(),
  };
}

describe("tmux external interaction observer", () => {
  it("exposes one bounded synchronous internal-read emission for NOHOOKS recovery", () => {
    const { observer } = harness("");
    const marker = registerInternalReadOperation("%9");
    const emission = observer.internalReadHookEmission("%9", marker);
    expect(emission.bufferName).toBe(`tmux-ide-interaction-v3-${DAEMON}`);
    expect(emission.signalChannel).toBe(`${emission.bufferName}-ready`);
    expect(emission.record).toBe(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`);
    expect(Object.isFrozen(emission)).toBe(true);
    expect(() => observer.internalReadHookEmission("foreign", marker)).toThrow(TypeError);
    retireInternalReadOperation(marker, "%9");
  });

  it("parses only closed runtime metadata and never accepts payload-shaped fields", () => {
    expect(
      parseTmuxInputHookRecords(
        `%9${FIELD}${FIELD}${SEND}${EVENT}%10${FIELD}marker${FIELD}${READ}${EVENT}bad${FIELD}secret${FIELD}extra${EVENT}`,
      ),
    ).toEqual([
      { runtimePaneId: "%9", operationMarker: null, operationKind: SEND },
      { runtimePaneId: "%10", operationMarker: "marker", operationKind: READ },
    ]);
  });

  it("preserves user hooks while replacing stale product hooks", async () => {
    const { observer, calls } = harness("");
    await observer.install();

    expect(calls).toContainEqual(["set-hook", "-gu", "after-send-keys[7]"]);
    expect(calls).toContainEqual(["set-hook", "-gu", "after-capture-pane[5]"]);
    expect(calls).not.toContainEqual(["set-hook", "-gu", "after-send-keys[3]"]);
    const installs = calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag");
    expect(installs).toHaveLength(2);
    expect(installs[0]?.[3]).toContain("#{@tmux_ide_send_operation}");
    expect(installs[1]?.[3]).toContain("#{@tmux_ide_read_operation}");
    expect(installs[1]?.[3]).toContain("set-option -pu '@tmux_ide_read_operation'");
    expect(installs[1]?.[3]).toContain("'@tmux_ide_read_operation'");
    expect(installs.every((install) => install[3]?.includes("run-shell -b -C"))).toBe(true);
    expect(installs.every((install) => !install[3]?.includes("/usr/bin/tmux"))).toBe(true);
    expect(installs.every((install) => install[3]?.includes("#{pane_id}"))).toBe(true);
    expect(installs.every((install) => !install[3]?.includes("pane_input"))).toBe(true);
  });

  it("self-heals both hooks after an external tmux config reload removes them", async () => {
    const { observer, calls, removeHooks } = statefulHookHarness();
    await observer.install();
    const firstInstalls = calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag");
    expect(firstInstalls).toHaveLength(2);

    await observer.reconcileHooks({ allowInactive: true });
    expect(calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag")).toHaveLength(2);

    removeHooks();
    await observer.reconcileHooks({ allowInactive: true });
    expect(calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag")).toHaveLength(4);
  });

  it("projects external observations and propagates whether the live executor consumed one", async () => {
    const own = internalInteractionOperationMarker(DAEMON, OPERATION);
    const { observer, observed } = harness(
      `%9${FIELD}${FIELD}${SEND}${EVENT}%9${FIELD}${own}${FIELD}${SEND}${EVENT}%9${FIELD}another-daemon:${OPERATION}${FIELD}${READ}${EVENT}`,
      OPERATION,
    );
    expect(await observer.drain()).toBe(true);

    expect(observed).toEqual([
      {
        workspaceName: "workspace.project",
        semanticPaneId: "pane.editor",
        operationKind: SEND,
        operationId: null,
      },
      {
        workspaceName: "workspace.project",
        semanticPaneId: "pane.editor",
        operationKind: SEND,
        operationId: OPERATION,
      },
      {
        workspaceName: "workspace.project",
        semanticPaneId: "pane.editor",
        operationKind: READ,
        operationId: null,
      },
    ]);
  });

  it("does not trust a forgeable internal-looking read marker", async () => {
    const { observer, observed } = harness(
      `%9${FIELD}${FORGED_INTERNAL_READ}${FIELD}${READ}${EVENT}%9${FIELD}${FIELD}${READ}${EVENT}`,
    );
    expect(await observer.drain()).toBe(false);
    expect(observed).toEqual([
      {
        workspaceName: "workspace.project",
        semanticPaneId: "pane.editor",
        operationKind: READ,
        operationId: null,
      },
      {
        workspaceName: "workspace.project",
        semanticPaneId: "pane.editor",
        operationKind: READ,
        operationId: null,
      },
    ]);
  });

  it("consumes a registered internal read exactly once for its exact pane", async () => {
    const marker = registerInternalReadOperation("%9");
    const first = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`);
    expect(await first.observer.drain()).toBe(true);
    expect(first.observed).toEqual([]);

    const replay = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`);
    expect(await replay.observer.drain()).toBe(false);
    expect(replay.observed).toHaveLength(1);
  });

  it("retires only the exact failed read while preserving a newer pane proof", () => {
    const retired = registerInternalReadOperation("%9");
    const current = registerInternalReadOperation("%9");
    expect(retireInternalReadOperation(retired, "%9")).toBe(true);
    expect(consumeInternalReadOperation(retired, "%9", READ)).toBe(false);
    expect(retireInternalReadOperation(current, "%8")).toBe(false);
    expect(consumeInternalReadOperation(current, "%9", READ)).toBe(true);
  });

  it("suppresses a cross-process product read only with daemon-owner proof", async () => {
    const token = "owner-token-with-enough-entropy-for-the-test";
    const marker = createAuthenticatedInternalReadOperation("%9", {
      daemonInstanceId: DAEMON,
      ownerToken: token,
    });
    const trusted = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`, null, token);
    expect(await trusted.observer.drain()).toBe(true);
    expect(trusted.observed).toEqual([]);

    const untrusted = harness(
      `%9${FIELD}${marker}${FIELD}${READ}${EVENT}`,
      null,
      "different-owner-token",
    );
    expect(await untrusted.observer.drain()).toBe(false);
    expect(untrusted.observed).toHaveLength(1);
  });

  it("externalizes a registered marker used for the wrong pane or operation kind", async () => {
    const wrongPane = registerInternalReadOperation("%8");
    const pane = harness(`%9${FIELD}${wrongPane}${FIELD}${READ}${EVENT}`);
    expect(await pane.observer.drain()).toBe(false);
    expect(pane.observed).toHaveLength(1);

    const wrongKind = registerInternalReadOperation("%9");
    const kind = harness(`%9${FIELD}${wrongKind}${FIELD}${SEND}${EVENT}`);
    expect(await kind.observer.drain()).toBe(false);
    expect(kind.observed).toHaveLength(1);
  });

  it("externalizes a stale internal-read registration", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));
      const marker = registerInternalReadOperation("%9");
      vi.setSystemTime(new Date("2026-08-11T10:00:11.000Z"));
      const stale = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`);
      expect(await stale.observer.drain()).toBe(false);
      expect(stale.observed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes healthcheck and drain work without interval-style backlog", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstCall = true;
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const diagnostics: unknown[] = [];
    let now = 100;
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      io: {
        runTmux: async (args) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          calls.push(String(args[0]));
          if (firstCall) {
            firstCall = false;
            await first;
          }
          active -= 1;
          if (args[0] === "show-hooks") {
            return HOOK_NAMES.map(
              (name) => `${name}[0] run-shell tmux-ide-interaction-v3-${DAEMON}`,
            ).join("\n");
          }
          if (args[0] === "show-options") return "";
          return "";
        },
        waitForSignal: async () => undefined,
        delay: async () => undefined,
      },
      diagnostics: {
        nowMicros: () => now++,
        createTraceId: () => "11111111-1111-4111-8111-111111111111",
        publish: (event) => diagnostics.push(event),
        queueMicrotask: (callback) => callback(),
      },
      onObserved: () => false,
    });

    const healthcheck = observer.reconcileHooks({ allowInactive: true });
    const duplicateHealthcheck = observer.reconcileHooks({ allowInactive: true });
    const drain = observer.drain();
    releaseFirst();
    await Promise.all([healthcheck, duplicateHealthcheck, drain]);

    expect(maximumActive).toBe(1);
    // One combined client verifies both hook arrays.
    expect(calls.filter((operation) => operation === "show-hooks")).toHaveLength(1);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operation: "healthcheck", phase: "begin", activeOperations: 1 }),
        expect.objectContaining({ operation: "healthcheck", phase: "end", succeeded: true }),
        expect.objectContaining({ operation: "drain", phase: "begin", activeOperations: 1 }),
        expect.objectContaining({ operation: "drain", phase: "end", succeeded: true }),
      ]),
    );
  });

  it("keeps async observer authority live when diagnostics throw", async () => {
    const { observer, observed } = harness(`%9${FIELD}${FIELD}${SEND}${EVENT}`);
    observer.setDiagnostics({
      nowMicros: () => 1,
      createTraceId: () => "11111111-1111-4111-8111-111111111111",
      publish: () => {
        throw new Error("diagnostic failure");
      },
    });
    expect(await observer.drain()).toBe(false);
    expect(observed).toHaveLength(1);
  });

  it("retires a partially installed hook when async startup fails", async () => {
    const hooks = new Map<string, string>();
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      io: {
        runTmux: async (args) => {
          if (args[0] === "show-hooks") return showHooks(args, hooks);
          if (args[0] === "list-buffers") return "";
          if (args[0] === "set-hook" && args[1] === "-ag") {
            if (args[2] === "after-capture-pane") throw new Error("install failed");
            hooks.set(args[2]!, `${args[2]}[0] ${args[3]}`);
          }
          if (args[0] === "set-hook" && args[1] === "-gu") {
            hooks.delete(args[2]!.replace(/\[[0-9]+\]$/u, ""));
          }
          return "";
        },
        waitForSignal: async () => undefined,
        delay: async () => undefined,
      },
      onObserved: () => false,
    });

    await expect(observer.start()).rejects.toThrow("install failed");
    expect(hooks.size).toBe(0);
    await observer.dispose();
  });

  it("starts without a tmux server and installs hooks when the server appears", async () => {
    let serverAvailable = false;
    const hooks = new Map<string, string>();
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      io: {
        runTmux: async (args) => {
          if (!serverAvailable) {
            throw Object.assign(new Error("error connecting to tmux socket"), {
              stderr: "no server running on /private/tmp/tmux/default",
            });
          }
          if (args[0] === "show-hooks") return showHooks(args, hooks);
          if (args[0] === "list-buffers") return "";
          if (args[0] === "set-hook" && args[1] === "-ag") {
            hooks.set(args[2]!, `${args[2]}[0] ${args[3]}`);
          }
          if (args[0] === "set-hook" && args[1] === "-gu") {
            hooks.delete(args[2]!.replace(/\[[0-9]+\]$/u, ""));
          }
          return "";
        },
        waitForSignal: async (_channel, signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        delay: async (_milliseconds, signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      },
      onObserved: () => false,
    });

    await expect(observer.start()).resolves.toBeUndefined();
    serverAvailable = true;
    await observer.reconcileHooks();
    expect(hooks.get("after-send-keys")).toContain(`tmux-ide-interaction-v3-${DAEMON}`);
    expect(hooks.get("after-capture-pane")).toContain(`tmux-ide-interaction-v3-${DAEMON}`);
    await observer.dispose();
  });

  it("aborts a pending async install before disposal and never starts late work", async () => {
    const calls: string[] = [];
    let installEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      installEntered = resolve;
    });
    let first = true;
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      io: {
        runTmux: async (args, signal) => {
          calls.push(String(args[0]));
          if (first && signal) {
            first = false;
            installEntered();
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          return "";
        },
        waitForSignal: async () => undefined,
        delay: async () => undefined,
      },
      onObserved: () => false,
    });

    const starting = observer.start();
    await entered;
    await observer.dispose();
    await expect(starting).rejects.toThrow(/aborted|disposed during startup/u);
    const settledCalls = calls.length;
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(settledCalls);
    await observer.reconcileHooks();
    expect(calls).toHaveLength(settledCalls);
  });
  it("retries a detached read once without silently dropping a recoverable receipt", async () => {
    const observed = vi.fn(() => true);
    const gaps = vi.fn();
    let reads = 0;
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/unused",
        socketSelector: { kind: "name", name: "unused" },
      },
      registry: registry(),
      onObserved: observed,
      onGap: gaps,
      io: {
        runTmux: async (args) => {
          if (args[0] === "show-options") {
            if (++reads === 1) throw new Error("transient read failure");
            return `%9${FIELD}${FIELD}${SEND}${EVENT}`;
          }
          if (args[0] === "display-message") return "project\tpane.editor";
          return "";
        },
      },
    });
    expect(await observer.drain()).toBe(true);
    expect(reads).toBe(2);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(gaps).not.toHaveBeenCalled();
  });

  it("bounds failed reads/deletes to one reusable slot and reports missing observations", async () => {
    const observed = vi.fn(() => true);
    const gaps = vi.fn();
    const reads: string[] = [];
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/unused",
        socketSelector: { kind: "name", name: "unused" },
      },
      registry: registry(),
      onObserved: observed,
      onGap: gaps,
      io: {
        runTmux: async (args) => {
          if (args[0] === "show-options") {
            reads.push(args[2]!);
            throw new Error("stdout maxBuffer exceeded: content must not be logged");
          }
          if (args[1] === "-gu") throw new Error("delete failed");
          return "";
        },
      },
    });
    expect(await observer.drain()).toBe(false);
    expect(await observer.drain()).toBe(false);
    expect(reads).toHaveLength(4);
    expect(new Set(reads).size).toBe(1);
    expect(observed).not.toHaveBeenCalled();
    expect(gaps.mock.calls).toEqual(
      Array.from({ length: 2 }, () => [
        { reason: "read-failed", recovery: "future-observations-only" },
      ]),
    );
  });

  it("frames a truncated record separately and never projects a gap as success", async () => {
    const { observer, observed } = harness(
      `%9${FIELD}${FIELD}${SEND}${EVENT}%10${FIELD}partial` +
        `${EVENT}gap${EVENT}%11${FIELD}${FIELD}${READ}${EVENT}`,
    );
    expect(await observer.drain()).toBe(false);
    expect(observed.map((event) => event.operationKind)).toEqual([SEND, READ]);
  });

  it("reports a failed detach without reading an old detached slot", async () => {
    const observed = vi.fn(() => true);
    const gaps = vi.fn();
    const calls: string[] = [];
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/unused",
        socketSelector: { kind: "name", name: "unused" },
      },
      onObserved: observed,
      onGap: gaps,
      io: {
        runTmux: async (args) => {
          calls.push(args[0]!);
          throw new Error("detach failed");
        },
      },
    });
    expect(await observer.drain()).toBe(false);
    expect(calls).toEqual(["set-option"]);
    expect(observed).not.toHaveBeenCalled();
    expect(gaps).toHaveBeenCalledWith({
      reason: "detach-failed",
      recovery: "future-observations-only",
    });
  });
  it("contains timer reconciliation rejections and still disposes its waiter", async () => {
    vi.useFakeTimers();
    const gaps = vi.fn();
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/unused",
        socketSelector: { kind: "name", name: "unused" },
      },
      onObserved: () => false,
      onGap: gaps,
      io: {
        runTmux: async () => "",
        waitForSignal: async (_channel, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      },
    });
    try {
      await observer.start();
      vi.spyOn(observer, "reconcileHooks").mockRejectedValue(
        new Error("unexpected repair failure"),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(gaps).toHaveBeenCalledWith({
        reason: "hook-repair-failed",
        recovery: "future-observations-only",
      });
    } finally {
      await observer.dispose();
      vi.useRealTimers();
    }
  });

  it("aborts an in-flight detached read without retrying after disposal", async () => {
    let entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let reads = 0;
    const gaps = vi.fn();
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/unused",
        socketSelector: { kind: "name", name: "unused" },
      },
      onObserved: () => false,
      onGap: gaps,
      io: {
        runTmux: async (args, signal) => {
          if (args[0] !== "show-options") return "";
          reads += 1;
          entered();
          return new Promise<string>((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          );
        },
        waitForSignal: async (_channel, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      },
    });
    await observer.start();
    const drain = observer.drain();
    await reading;
    await observer.dispose();
    expect(await drain).toBe(false);
    expect(reads).toBe(1);
    expect(gaps).not.toHaveBeenCalled();
  });

  it("doubles the healthy health-check cadence up to the cap and resets it otherwise", () => {
    const schedule = { baseMs: 1_000, maxMs: 30_000 };
    expect(nextHookHealthcheckDelay(1_000, "healthy", schedule)).toBe(2_000);
    expect(nextHookHealthcheckDelay(2_000, "healthy", schedule)).toBe(4_000);
    expect(nextHookHealthcheckDelay(16_000, "healthy", schedule)).toBe(30_000);
    expect(nextHookHealthcheckDelay(30_000, "healthy", schedule)).toBe(30_000);
    expect(nextHookHealthcheckDelay(30_000, "repaired", schedule)).toBe(1_000);
    expect(nextHookHealthcheckDelay(30_000, "failed", schedule)).toBe(1_000);
    // Degenerate inputs never produce a zero, negative, or unbounded wait.
    expect(nextHookHealthcheckDelay(Number.NaN, "healthy", schedule)).toBe(2_000);
    expect(nextHookHealthcheckDelay(-5, "healthy", schedule)).toBe(2_000);
    expect(nextHookHealthcheckDelay(5, "healthy", { baseMs: 0, maxMs: 0 })).toBe(1);
    expect(DEFAULT_HOOK_HEALTHCHECK_SCHEDULE).toEqual({ baseMs: 1_000, maxMs: 30_000 });
  });

  it("verifies each hook array by its own lines in combined show-hooks output", () => {
    const owned = `tmux-ide-interaction-v3-${DAEMON}`;
    const combined = [
      `after-send-keys[0] run-shell ${owned}`,
      "after-capture-pane[0] display-message user-capture",
    ].join("\n");
    expect(ownedHookInstalled(combined, "after-send-keys", owned)).toBe(true);
    // The owned marker on the other array must not vouch for this one.
    expect(ownedHookInstalled(combined, "after-capture-pane", owned)).toBe(false);
    expect(
      ownedHookInstalled("after-send-keys\nafter-capture-pane", "after-send-keys", owned),
    ).toBe(false);
    expect(ownedHookInstalled("", "after-send-keys", owned)).toBe(false);
  });

  it("backs off scheduled health checks while hooks stay healthy and resets on repair", async () => {
    vi.useFakeTimers();
    const hooks = new Map<string, string>();
    const calls: string[] = [];
    const gaps = vi.fn();
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      healthcheck: { baseMs: 1_000, maxMs: 4_000 },
      onObserved: () => false,
      onGap: gaps,
      io: {
        runTmux: async (args) => {
          calls.push(String(args[0]));
          if (args[0] === "show-hooks") return showHooks(args, hooks);
          if (args[0] === "list-buffers") return "";
          if (args[0] === "set-hook" && args[1] === "-ag") {
            hooks.set(args[2]!, `${args[2]}[0] ${args[3]}`);
          }
          if (args[0] === "set-hook" && args[1] === "-gu") {
            hooks.delete(args[2]!.replace(/\[[0-9]+\]$/u, ""));
          }
          return "";
        },
        waitForSignal: async (_channel, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        delay: async () => undefined,
      },
    });
    const healthchecks = () => calls.filter((operation) => operation === "show-hooks").length;
    try {
      await observer.start();
      const afterInstall = healthchecks();
      expect(observer.healthcheckDelayMs).toBe(1_000);

      // Checks fire at 1 s, 3 s, 7 s, 11 s, 15 s: 1 + 2 + 4 + 4 + 4 (capped).
      await vi.advanceTimersByTimeAsync(1_000);
      expect(healthchecks()).toBe(afterInstall + 1);
      expect(observer.healthcheckDelayMs).toBe(2_000);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(healthchecks()).toBe(afterInstall + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(healthchecks()).toBe(afterInstall + 2);
      expect(observer.healthcheckDelayMs).toBe(4_000);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(healthchecks()).toBe(afterInstall + 3);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(healthchecks()).toBe(afterInstall + 4);
      expect(observer.healthcheckDelayMs).toBe(4_000);
      // Twenty seconds at the cap cost five checks, not twenty.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(healthchecks()).toBe(afterInstall + 9);
      expect(gaps).not.toHaveBeenCalled();

      // An external reload removes the hooks: the next check repairs them,
      // reports the unobservable window, and returns to the base cadence.
      hooks.clear();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(hooks.get("after-send-keys")).toContain(`tmux-ide-interaction-v3-${DAEMON}`);
      expect(hooks.get("after-capture-pane")).toContain(`tmux-ide-interaction-v3-${DAEMON}`);
      expect(gaps).toHaveBeenCalledTimes(1);
      expect(gaps).toHaveBeenCalledWith({
        reason: "hooks-replaced",
        recovery: "future-observations-only",
      });
      expect(observer.healthcheckDelayMs).toBe(1_000);
      const afterRepair = healthchecks();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(healthchecks()).toBe(afterRepair + 1);
      expect(observer.healthcheckDelayMs).toBe(2_000);
    } finally {
      await observer.dispose();
      vi.useRealTimers();
    }
  });

  it("returns to the base health-check cadence when the signal waiter fails", async () => {
    vi.useFakeTimers();
    const hooks = new Map<string, string>();
    let failWaiter = false;
    let waiterFailures = 0;
    let releaseWaiter: (() => void) | null = null;
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: DAEMON,
      tmuxAuthority: {
        executablePath: "/usr/bin/tmux",
        socketSelector: { kind: "name", name: "default" },
      },
      registry: registry(),
      healthcheck: { baseMs: 1_000, maxMs: 8_000 },
      onObserved: () => false,
      io: {
        runTmux: async (args) => {
          if (args[0] === "show-hooks") return showHooks(args, hooks);
          if (args[0] === "list-buffers") return "";
          if (args[0] === "set-hook" && args[1] === "-ag") {
            hooks.set(args[2]!, `${args[2]}[0] ${args[3]}`);
          }
          if (args[0] === "set-hook" && args[1] === "-gu") {
            hooks.delete(args[2]!.replace(/\[[0-9]+\]$/u, ""));
          }
          return "";
        },
        waitForSignal: (_channel, signal) =>
          new Promise<void>((resolve, reject) => {
            if (signal.aborted) return resolve();
            if (failWaiter) {
              waiterFailures += 1;
              reject(new Error("wait-for exited"));
              return;
            }
            releaseWaiter = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          }),
        delay: async (_milliseconds, signal) =>
          new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          }),
      },
    });
    try {
      await observer.start();
      await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000);
      expect(observer.healthcheckDelayMs).toBe(8_000);

      // One event drains normally; the waiter that follows dies (server
      // restart, channel replaced). The loop reinstalls after its retry delay
      // and the next health check is due at the base cadence, not in 8 s.
      failWaiter = true;
      releaseWaiter!();
      await vi.advanceTimersByTimeAsync(0);
      expect(waiterFailures).toBe(1);
      expect(observer.healthcheckDelayMs).toBe(1_000);
    } finally {
      await observer.dispose();
      vi.useRealTimers();
    }
  });
});
