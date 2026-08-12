import { describe, expect, it, vi } from "vitest";

import type { WorkspaceRegistry } from "./workspace-registry.ts";
import {
  TmuxExternalInteractionObserver,
  internalInteractionOperationMarker,
  parseTmuxInputHookRecords,
  type ExternalTmuxInteractionObserverIo,
} from "./tmux-external-interaction-observer.ts";
import {
  createAuthenticatedInternalReadOperation,
  registerInternalReadOperation,
} from "./tmux-interaction-options.ts";

const DAEMON = "21f2625e-d1a5-4ad2-9068-b1426bcc6651";
const OPERATION = "8be47b5a-43da-4632-9930-e1aba61c8da6";
const FIELD = "|tmux-ide-input-field-v1|";
const EVENT = "|tmux-ide-input-event-v1|";
const SEND = "workspace.pane.send";
const READ = "workspace.pane.read";
const FORGED_INTERNAL_READ = "tmux-ide-internal-read-v2:11111111-1111-4111-8111-111111111111";

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
    runTmux: (args) => {
      calls.push([...args]);
      if (args[0] === "show-hooks") {
        return args[2] === "after-capture-pane"
          ? "after-capture-pane[2] display-message user-capture\nafter-capture-pane[5] run-shell tmux-ide-interaction-v1-stale"
          : "after-send-keys[3] display-message user-hook\nafter-send-keys[7] run-shell tmux-ide-interaction-v1-stale";
      }
      if (args[0] === "list-buffers") return "tmux-ide-interaction-v1-stale\nclipboard";
      if (args[0] === "set-buffer" && args.includes("-n")) return "";
      if (args[0] === "show-buffer") return buffer;
      if (args[0] === "delete-buffer") {
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
    runTmux: (args) => {
      calls.push([...args]);
      if (args[0] === "show-hooks") return hooks.get(args[2]!) ?? String(args[2]);
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

  it("preserves user hooks while replacing stale product hooks", () => {
    const { observer, calls } = harness("");
    observer.install();

    expect(calls).toContainEqual(["set-hook", "-gu", "after-send-keys[7]"]);
    expect(calls).toContainEqual(["set-hook", "-gu", "after-capture-pane[5]"]);
    expect(calls).not.toContainEqual(["set-hook", "-gu", "after-send-keys[3]"]);
    const installs = calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag");
    expect(installs).toHaveLength(2);
    expect(installs[0]?.[3]).toContain("#{q:@tmux_ide_send_operation}");
    expect(installs[1]?.[3]).toContain("#{q:@tmux_ide_read_operation}");
    expect(installs[1]?.[3]).toContain("set-option -pu '@tmux_ide_read_operation'");
    expect(installs[1]?.[3]).toContain("'@tmux_ide_read_operation'");
    expect(installs.every((install) => install[3]?.includes("run-shell -b -C"))).toBe(true);
    expect(installs.every((install) => !install[3]?.includes("/usr/bin/tmux"))).toBe(true);
    expect(installs.every((install) => install[3]?.includes("#{pane_id}"))).toBe(true);
    expect(installs.every((install) => !install[3]?.includes("pane_input"))).toBe(true);
  });

  it("self-heals both hooks after an external tmux config reload removes them", () => {
    const { observer, calls, removeHooks } = statefulHookHarness();
    observer.install();
    const firstInstalls = calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag");
    expect(firstInstalls).toHaveLength(2);

    observer.reconcileHooks();
    expect(calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag")).toHaveLength(2);

    removeHooks();
    observer.reconcileHooks();
    expect(calls.filter((args) => args[0] === "set-hook" && args[1] === "-ag")).toHaveLength(4);
  });

  it("projects external observations and propagates whether the live executor consumed one", () => {
    const own = internalInteractionOperationMarker(DAEMON, OPERATION);
    const { observer, observed } = harness(
      `%9${FIELD}${FIELD}${SEND}${EVENT}%9${FIELD}${own}${FIELD}${SEND}${EVENT}%9${FIELD}another-daemon:${OPERATION}${FIELD}${READ}${EVENT}`,
      OPERATION,
    );
    expect(observer.drain()).toBe(true);

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

  it("does not trust a forgeable internal-looking read marker", () => {
    const { observer, observed } = harness(
      `%9${FIELD}${FORGED_INTERNAL_READ}${FIELD}${READ}${EVENT}%9${FIELD}${FIELD}${READ}${EVENT}`,
    );
    expect(observer.drain()).toBe(false);
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

  it("consumes a registered internal read exactly once for its exact pane", () => {
    const marker = registerInternalReadOperation("%9");
    const first = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`);
    expect(first.observer.drain()).toBe(true);
    expect(first.observed).toEqual([]);

    const replay = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`);
    expect(replay.observer.drain()).toBe(false);
    expect(replay.observed).toHaveLength(1);
  });

  it("suppresses a cross-process product read only with daemon-owner proof", () => {
    const token = "owner-token-with-enough-entropy-for-the-test";
    const marker = createAuthenticatedInternalReadOperation("%9", {
      daemonInstanceId: DAEMON,
      ownerToken: token,
    });
    const trusted = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`, null, token);
    expect(trusted.observer.drain()).toBe(true);
    expect(trusted.observed).toEqual([]);

    const untrusted = harness(
      `%9${FIELD}${marker}${FIELD}${READ}${EVENT}`,
      null,
      "different-owner-token",
    );
    expect(untrusted.observer.drain()).toBe(false);
    expect(untrusted.observed).toHaveLength(1);
  });

  it("externalizes a registered marker used for the wrong pane or operation kind", () => {
    const wrongPane = registerInternalReadOperation("%8");
    const pane = harness(`%9${FIELD}${wrongPane}${FIELD}${READ}${EVENT}`);
    expect(pane.observer.drain()).toBe(false);
    expect(pane.observed).toHaveLength(1);

    const wrongKind = registerInternalReadOperation("%9");
    const kind = harness(`%9${FIELD}${wrongKind}${FIELD}${SEND}${EVENT}`);
    expect(kind.observer.drain()).toBe(false);
    expect(kind.observed).toHaveLength(1);
  });

  it("externalizes a stale internal-read registration", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-11T10:00:00.000Z"));
      const marker = registerInternalReadOperation("%9");
      vi.setSystemTime(new Date("2026-08-11T10:00:11.000Z"));
      const stale = harness(`%9${FIELD}${marker}${FIELD}${READ}${EVENT}`);
      expect(stale.observer.drain()).toBe(false);
      expect(stale.observed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
