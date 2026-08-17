import {
  APPLICATION_SHELL_COMMAND_IDS,
  type ApplicationShellProjectionV1,
} from "@tmux-ide/contracts";
import { describe, expect, it } from "bun:test";

import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";
import { createApplicationShellBinding } from "./application-shell-binding.ts";

function semantic(
  activeMode: "home" | "terminals" = "home",
  workspaceName = "main",
): ApplicationShellProjectionV1 {
  return projectOpenTuiApplicationShell({
    projectName: "tmux-ide",
    rootLabel: "/workspace/tmux-ide",
    workspaceName,
    activeMode,
    dockMode: "collapsed",
    activeDockTool: "missions",
    focusZone: activeMode === "home" ? "primary-navigation" : "terminal",
    focusedPaneId: "pane.main",
    terminalInputPaneId: "pane.main",
    paletteOpen: false,
    sessions: [{ name: "main", status: "working" }],
    activeSession: "main",
    agents: [],
  });
}

function fakeClient(initial: ApplicationShellProjectionV1 | null, phase = "live") {
  type ShellDispatch = {
    readonly kind: "application-shell";
    readonly invocation: { readonly id: string; readonly args: unknown };
  };
  let current = initial;
  const semanticListeners = new Set<(value: ApplicationShellProjectionV1 | null) => void>();
  const dispatched: ShellDispatch[] = [];
  const client = {
    getSnapshot: () => ({
      phase,
      semantic: current,
      authority: null,
    }),
    subscribe: (scope: string, listener: (value: unknown) => void) => {
      if (scope === "semantic")
        semanticListeners.add(
          listener as typeof semanticListeners extends Set<infer T> ? T : never,
        );
      return () =>
        semanticListeners.delete(
          listener as typeof semanticListeners extends Set<infer T> ? T : never,
        );
    },
    dispatch: async (command: unknown) => {
      dispatched.push(command as ShellDispatch);
      return { kind: "application-shell", operationId: null };
    },
  } as unknown as OpenTuiProductionWorkspaceClient;
  return {
    client,
    dispatched,
    publishSemantic(value: ApplicationShellProjectionV1 | null) {
      current = value;
      for (const listener of semanticListeners) listener(value);
    },
  };
}

const source = { kind: "mouse" as const, surface: "application-bar" as const };

describe("application shell binding", () => {
  it("dispatches the canonical activate-then-focus surface transaction in order", async () => {
    const fake = fakeClient(semantic());
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });

    expect(await binding.openSurface("terminals", source)).toBe(true);
    expect(fake.dispatched.map((command) => command.invocation.id)).toEqual([
      APPLICATION_SHELL_COMMAND_IDS.activateMode,
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
    ]);
  });

  it("opens Terminals canonically even when the requested session is already current", async () => {
    const fake = fakeClient(semantic("home"));
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    const opened: string[] = [];

    const result = await binding.openSession("main", source, async (sessionName) => {
      opened.push(sessionName);
      return true;
    });

    expect(result).toEqual({ opened: true, activated: true });
    expect(opened).toEqual(["main"]);
    expect(
      fake.dispatched.map((command) => [command.invocation.id, command.invocation.args]),
    ).toEqual([
      [APPLICATION_SHELL_COMMAND_IDS.activateMode, { mode: "terminals" }],
      [APPLICATION_SHELL_COMMAND_IDS.moveFocus, { target: { kind: "zone", zone: "canvas" } }],
    ]);
  });

  it("retains one coherent semantic generation through rebinding and clears unsafe states", () => {
    const first = fakeClient(semantic("terminals", "first"));
    const second = fakeClient(null, "loading");
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: first.client });

    first.publishSemantic(null);
    binding.adoptGeneration({ status: "rebinding", client: first.client });
    expect(binding.getSnapshot().semantic?.workspace.name).toBe("first");
    expect(binding.getSnapshot().status).toBe("rebinding");

    binding.adoptGeneration({ status: "live", client: second.client });
    expect(binding.getSnapshot().semantic?.workspace.name).toBe("first");
    expect(binding.getSnapshot().status).toBe("loading");
    second.publishSemantic(semantic("terminals", "second"));
    expect(binding.getSnapshot().semantic?.workspace.name).toBe("second");
    first.publishSemantic(semantic("home", "stale"));
    expect(binding.getSnapshot().semantic?.workspace.name).toBe("second");

    binding.adoptGeneration({ status: "unavailable", client: null });
    expect(binding.getSnapshot().semantic).toBeNull();
  });
});
