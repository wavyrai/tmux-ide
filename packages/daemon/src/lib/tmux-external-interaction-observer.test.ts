import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRegistry } from "./workspace-registry.ts";
import {
  DEFAULT_HOOK_HEALTHCHECK_SCHEDULE,
  tmuxInteractionWaitCommand,
  TmuxExternalInteractionObserver,
  internalInteractionOperationMarker,
  nextHookHealthcheckDelay,
  ownedHookInstalled,
  parseTmuxInputHookRecords,
  type ExternalTmuxInteractionObserverIo,
  waitForBlockingTmuxClient,
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

describe("captured interaction targets", () => {
  it("parses bounded captured identity and preserves unresolved legacy metadata", () => {
    expect(
      parseTmuxInputHookRecords(
        `%9${FIELD}${FIELD}${SEND}${FIELD}$1${FIELD}pane.original${EVENT}`,
      )[0]?.capturedTarget,
    ).toEqual({ runtimePaneId: "%9", sessionId: "$1", semanticPaneId: "pane.original" });
    for (const stamp of ["", "bad;command", "a".repeat(129)])
      expect(
        parseTmuxInputHookRecords(`%9${FIELD}${FIELD}${SEND}${FIELD}$1${FIELD}${stamp}${EVENT}`)[0]
          ?.capturedTarget,
      ).toBeUndefined();
  });

  it.each([true, false])(
    "never performs late identity lookup with a captured-target resolver (resolved=%s)",
    async (resolved) => {
      const onObserved = vi.fn(() => false);
      const onUnresolvedObservation = vi.fn();
      const runTmux = vi.fn(async (args: readonly string[]) => {
        if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
        if (args[0] === "show-options")
          return `%9${FIELD}${FIELD}${SEND}${FIELD}$1${FIELD}pane.original${EVENT}`;
        if (args[0] === "display-message") throw new Error("late lookup forbidden");
        return "";
      });
      const observer = new TmuxExternalInteractionObserver({
        daemonInstanceId: DAEMON,
        tmuxAuthority: {
          executablePath: "/unused",
          socketSelector: { kind: "name", name: "unused" },
        },
        io: { runTmux },
        onObserved,
        onUnresolvedObservation,
        resolveCapturedTarget: (target) =>
          resolved
            ? { workspaceName: "workspace.original", semanticPaneId: target.semanticPaneId }
            : null,
      });
      await observer.drain();
      expect(runTmux.mock.calls.some(([args]) => args[0] === "display-message")).toBe(false);
      expect(onObserved).toHaveBeenCalledTimes(resolved ? 1 : 0);
      expect(onUnresolvedObservation).toHaveBeenCalledTimes(resolved ? 0 : 1);
    },
  );
});

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
      if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
      if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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
          if (args.includes("if-shell")) return "tmux-ide-drain-consumed";
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

describe("unread-aware native wait command", () => {
  it("registers a waiter only when retained work is empty, without a shell or yield", () => {
    expect(tmuxInteractionWaitCommand("observer", "observer-ready")).toEqual([
      "if-shell",
      "-F",
      "#{==:#{@observer},}",
      "wait-for 'observer-ready'",
    ]);
  });
  it("rejects command injection through either identifier", () => {
    expect(() => tmuxInteractionWaitCommand("bad;name", "ready")).toThrow();
    expect(() => tmuxInteractionWaitCommand("observer", "bad'channel")).toThrow();
  });
});

describe("prefix consumption acknowledgement", () => {
  it.each(["lost", "unknown", "mismatch"])(
    "does not project a snapshot after %s acknowledgement",
    async (failure) => {
      const observed = vi.fn(() => true);
      const gaps = vi.fn();
      const delay = vi.fn(async () => undefined);
      let attempts = 0;
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
          delay,
          runTmux: async (args) => {
            if (args.includes("if-shell")) {
              attempts += 1;
              if (failure === "lost") throw new Error("response lost after possible mutation");
              return failure === "mismatch" ? "tmux-ide-drain-retry" : "unknown";
            }
            if (args[0] === "show-options") {
              reads += 1;
              return `%9${FIELD}${FIELD}${SEND}${EVENT}`;
            }
            return "";
          },
        },
      });
      expect(await observer.drain()).toBe(false);
      expect(attempts).toBe(1);
      expect(reads).toBe(0);
      expect(observed).not.toHaveBeenCalled();
      expect(gaps).toHaveBeenCalledWith({
        reason: failure === "mismatch" ? "overflow" : "detach-failed",
        recovery: "future-observations-only",
      });
      expect(delay).toHaveBeenCalledTimes(1);
    },
  );
});

it("backs off persistent consume failures and aborts the backoff on disposal", async () => {
  let attempts = 0;
  const releases: Array<() => void> = [];
  const delays: number[] = [];
  const observer = new TmuxExternalInteractionObserver({
    daemonInstanceId: DAEMON,
    tmuxAuthority: { executablePath: "/unused", socketSelector: { kind: "name", name: "unused" } },
    onObserved: () => {
      throw new Error("must never project uncertain consumption");
    },
    healthcheck: { baseMs: 30_000, maxMs: 30_000 },
    io: {
      runTmux: async (args) => {
        if (args.includes("if-shell")) {
          attempts += 1;
          throw new Error("persistent consumption failure");
        }
        return "";
      },
      waitForSignal: async () => undefined,
      delay: (ms, signal) =>
        new Promise<void>((resolve) => {
          delays.push(ms);
          const done = () => {
            signal.removeEventListener("abort", done);
            resolve();
          };
          releases.push(done);
          if (signal.aborted) done();
          else signal.addEventListener("abort", done, { once: true });
        }),
    },
  });
  await observer.start();
  try {
    await vi.waitFor(() => expect(attempts).toBe(1));
    expect(delays).toEqual([1_000]);
    // Flush repeated microtasks: an unread waiter cannot bypass the barrier.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    expect(attempts).toBe(1);
    releases[0]!();
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(delays).toEqual([1_000, 1_000]);
  } finally {
    await observer.dispose();
  }
  expect(attempts).toBe(2);
});

// #839: observer disposal, and with it every daemon stop, awaits this client.
describe("blocking wait client cancellation", () => {
  it("settles after an abort even when the client ignores SIGTERM", async () => {
    const abort = new AbortController();
    const started = performance.now();
    const waiting = waitForBlockingTmuxClient(
      "/bin/sh",
      ["-c", "trap '' TERM; while :; do sleep 1; done"],
      abort.signal,
      50,
    );
    setTimeout(() => abort.abort(), 100);
    await expect(waiting).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(3_000);
  }, 10_000);

  it("resolves on a signalled wait, rejects a client that fails on its own, and skips a spawn once aborted", async () => {
    const live = new AbortController();
    await expect(
      waitForBlockingTmuxClient("/bin/sh", ["-c", "exit 0"], live.signal),
    ).resolves.toBeUndefined();
    await expect(
      waitForBlockingTmuxClient("/bin/sh", ["-c", "exit 1"], live.signal),
    ).rejects.toThrow();
    await expect(waitForBlockingTmuxClient("/nonexistent/tmux", [], live.signal)).rejects.toThrow();
    const aborted = AbortSignal.abort();
    await expect(
      waitForBlockingTmuxClient("/nonexistent/tmux", [], aborted),
    ).resolves.toBeUndefined();
  }, 10_000);
});

// Two tmux-ide daemons on one tmux server (an upgrade overlap, a development
// instance, a test daemon) must not take each other's hooks away.
describe("interaction hooks of several daemons on one tmux server", () => {
  const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const C = "cccccccc-3333-4333-8333-cccccccccccc";

  /** Just enough of a tmux server: global hook arrays, paste buffers, options. */
  function sharedServer() {
    const hooks = new Map<string, Map<number, string>>(HOOK_NAMES.map((name) => [name, new Map()]));
    const buffers = new Map<string, string>();
    const options = new Map<string, string>();
    let failListBuffers = false;
    const runTmux = async (args: readonly string[]): Promise<string> => {
      if (args[0] === "show-hooks")
        return HOOK_NAMES.filter((name) => args.includes(name))
          .map((name) => {
            const array = hooks.get(name)!;
            return array.size === 0
              ? name
              : [...array].map(([index, body]) => `${name}[${index}] ${body}`).join("\n");
          })
          .join("\n");
      if (args[0] === "set-hook" && args[1] === "-ag") {
        const array = hooks.get(args[2]!)!;
        array.set(Math.max(-1, ...array.keys()) + 1, args[3]!);
        return "";
      }
      if (args[0] === "set-hook" && args[1] === "-gu") {
        const match = /^(.+)\[(\d+)\]$/u.exec(args[2]!)!;
        hooks.get(match[1]!)!.delete(Number(match[2]));
        return "";
      }
      if (args[0] === "list-buffers") {
        if (failListBuffers) throw new Error("server busy");
        return [...buffers.keys()].join("\n");
      }
      if (args[0] === "set-buffer") {
        buffers.set(args[2]!, args[3]!);
        return "";
      }
      if (args[0] === "show-buffer") {
        const value = buffers.get(args[2]!);
        if (value === undefined) throw new Error("no buffer");
        return value;
      }
      if (args[0] === "delete-buffer") {
        buffers.delete(args[2]!);
        return "";
      }
      if (args[0] === "set-option" && args[1] === "-gu") {
        options.delete(args[2]!);
        return "";
      }
      return "";
    };
    const owners = () =>
      [
        ...new Set(
          [...hooks.values()]
            .flatMap((array) => [...array.values()])
            .map((body) => /tmux-ide-interaction-v3-([0-9a-f-]{36})/u.exec(body)?.[1] ?? "legacy"),
        ),
      ].sort();
    return {
      hooks,
      buffers,
      options,
      runTmux,
      owners,
      failListBuffers: (fail: boolean) => (failListBuffers = fail),
    };
  }

  function daemon(
    server: ReturnType<typeof sharedServer>,
    id: string,
    pid: number,
    alive: ReadonlySet<number>,
  ) {
    const gaps: string[] = [];
    const observer = new TmuxExternalInteractionObserver({
      daemonInstanceId: id,
      tmuxAuthority: {
        executablePath: process.execPath,
        socketSelector: { kind: "name", name: "shared" },
      },
      registry: registry(),
      onObserved: () => false,
      onGap: (gap) => gaps.push(gap.reason),
      ownerProcess: { pid, isAlive: (candidate) => alive.has(candidate) },
      io: {
        runTmux: server.runTmux,
        waitForSignal: (_channel, signal) =>
          new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
        delay: async () => undefined,
      },
    });
    return { observer, gaps };
  }

  it("a second daemon's install leaves the first daemon's hooks, buffer and options alone", async () => {
    const server = sharedServer();
    const alive = new Set([100, 200]);
    const a = daemon(server, A, 100, alive);
    const b = daemon(server, B, 200, alive);
    await a.observer.install();
    server.options.set(`@tmux-ide-interaction-v3-${A}`, "pending records of A");
    await b.observer.install();
    expect(server.owners()).toEqual([A, B]);
    expect([...server.buffers.keys()].sort()).toEqual([
      `tmux-ide-interaction-v3-${A}`,
      `tmux-ide-interaction-v3-${B}`,
    ]);
    expect(server.options.has(`@tmux-ide-interaction-v3-${A}`)).toBe(true);
    // Neither health check finds anything to repair, however often they alternate.
    for (let round = 0; round < 5; round += 1) {
      await a.observer.reconcileHooks({ allowInactive: true });
      await b.observer.reconcileHooks({ allowInactive: true });
    }
    expect(a.gaps).toEqual([]);
    expect(b.gaps).toEqual([]);
    expect(server.owners()).toEqual([A, B]);
  });

  it("a daemon that leaves removes only its own hooks", async () => {
    const server = sharedServer();
    const alive = new Set([100, 200]);
    const a = daemon(server, A, 100, alive);
    const b = daemon(server, B, 200, alive);
    await a.observer.start();
    await b.observer.start();
    await b.observer.dispose();
    expect(server.owners()).toEqual([A]);
    expect([...server.buffers.keys()]).toEqual([`tmux-ide-interaction-v3-${A}`]);
    await a.observer.reconcileHooks();
    expect(a.gaps).toEqual([]);
    await a.observer.dispose();
    expect(server.owners()).toEqual([]);
    expect(server.buffers.size).toBe(0);
  });

  it("still clears what a dead daemon left behind, and legacy hooks", async () => {
    const server = sharedServer();
    const alive = new Set([100, 200]);
    const crashed = daemon(server, A, 100, alive);
    await crashed.observer.install(); // then its process dies without disposing
    alive.delete(100);
    server.hooks.get("after-send-keys")!.set(40, "run-shell tmux-ide-interaction-v1-stale");
    // A hook whose owner left no marker buffer at all.
    server.hooks.get("after-capture-pane")!.set(41, `run-shell tmux-ide-interaction-v3-${C}-ready`);
    server.options.set(`@tmux-ide-interaction-v3-${A}`, "orphaned");
    const b = daemon(server, B, 200, alive);
    await b.observer.install();
    expect(server.owners()).toEqual([B]);
    expect([...server.buffers.keys()]).toEqual([`tmux-ide-interaction-v3-${B}`]);
    expect(server.options.has(`@tmux-ide-interaction-v3-${A}`)).toBe(false);
  });

  it("tells its own process's live observers from ones it already disposed", async () => {
    const server = sharedServer();
    const alive = new Set([100]);
    // One daemon process, two owner generations in a row plus one still running.
    const first = daemon(server, A, 100, alive);
    const second = daemon(server, B, 100, alive);
    await first.observer.start();
    await second.observer.start();
    expect(server.owners()).toEqual([A, B]);
    // A generation of this process whose teardown never removed its hooks.
    await first.observer.dispose();
    server.hooks.get("after-send-keys")!.set(50, `run-shell tmux-ide-interaction-v3-${A}-ready`);
    server.buffers.set(`tmux-ide-interaction-v3-${A}`, "retention-owner pid=100");
    const third = daemon(server, C, 100, alive);
    await third.observer.install();
    expect(server.owners()).toEqual([B, C]);
    await second.observer.dispose();
    await third.observer.dispose();
  });

  it("touches nothing foreign when it cannot tell who is alive", async () => {
    const server = sharedServer();
    const alive = new Set([100, 200]);
    const a = daemon(server, A, 100, alive);
    await a.observer.install();
    server.hooks.get("after-send-keys")!.set(40, "run-shell tmux-ide-interaction-v1-stale");
    server.failListBuffers(true);
    const b = daemon(server, B, 200, alive);
    await b.observer.install();
    expect(server.owners()).toEqual([A, B, "legacy"]);
  });

  it("writes its process id into its marker, the only thing another daemon can check", async () => {
    const server = sharedServer();
    const a = daemon(server, A, 4242, new Set([4242]));
    await a.observer.install();
    expect(server.buffers.get(`tmux-ide-interaction-v3-${A}`)).toBe("retention-owner pid=4242");
  });
});
