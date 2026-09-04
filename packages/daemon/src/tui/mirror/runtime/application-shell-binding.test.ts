import {
  APPLICATION_SHELL_COMMAND_IDS,
  type ApplicationShellProjectionV1,
} from "@tmux-ide/contracts";
import { describe, expect, it, vi } from "vitest";
import { createApplicationGenerationStarter } from "./application-generation-starter.ts";
import type { OpenTuiSessionOwner } from "./open-tui-session-owner.ts";

import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";
import type { OpenTuiProductionWorkspaceClient } from "./open-tui-generation-host.ts";
import {
  applicationShellBindingRenderSignature,
  createApplicationShellBinding,
} from "./application-shell-binding.ts";

function semantic(
  activeMode: "home" | "terminals" = "home",
  workspaceName = "main",
  paletteOpen = false,
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
    paletteOpen,
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
  let currentPhase = phase;
  let currentAuthority: unknown = null;
  const semanticListeners = new Set<(value: ApplicationShellProjectionV1 | null) => void>();
  const lifecycleListeners = new Set<(value: unknown) => void>();
  const authorityListeners = new Set<(value: unknown) => void>();
  const dispatched: ShellDispatch[] = [];
  const client = {
    getSnapshot: () => ({
      phase: currentPhase,
      semantic: current,
      authority: currentAuthority,
    }),
    subscribe: (scope: string, listener: (value: unknown) => void) => {
      if (scope === "semantic")
        semanticListeners.add(
          listener as typeof semanticListeners extends Set<infer T> ? T : never,
        );
      else if (scope === "lifecycle") lifecycleListeners.add(listener);
      else if (scope === "authority") authorityListeners.add(listener);
      return () => {
        semanticListeners.delete(
          listener as typeof semanticListeners extends Set<infer T> ? T : never,
        );
        lifecycleListeners.delete(listener);
        authorityListeners.delete(listener);
      };
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
    publishLifecycle(value: unknown, nextPhase = currentPhase) {
      currentPhase = nextPhase;
      for (const listener of lifecycleListeners) listener(value);
    },
    publishAuthority(value: unknown) {
      currentAuthority = value;
      for (const listener of authorityListeners) listener(value);
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

  it("dispatches palette activation then close as one command-palette transaction", async () => {
    const fake = fakeClient(semantic("home", "main", true));
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    const paletteSource = { kind: "keyboard" as const, surface: "command-palette" as const };

    expect(await binding.activatePaletteSurface("terminals", paletteSource)).toBe(true);
    expect(fake.dispatched.map((command) => command.invocation.id)).toEqual([
      APPLICATION_SHELL_COMMAND_IDS.activateMode,
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      APPLICATION_SHELL_COMMAND_IDS.closePalette,
    ]);
    expect(fake.dispatched.map((command) => command.invocation.source)).toEqual([
      paletteSource,
      paletteSource,
      paletteSource,
    ]);
  });

  it("moves chooser-opened focus to the live terminal pane", async () => {
    const fake = fakeClient(semantic("terminals"));
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    const keyboard = { kind: "keyboard" as const, surface: "application-bar" as const };

    expect(await binding.focusTerminalPane("pane.main", keyboard)).toBe(true);
    expect(fake.dispatched.at(-1)?.invocation).toMatchObject({
      id: APPLICATION_SHELL_COMMAND_IDS.moveFocus,
      args: { target: { kind: "pane", paneId: "pane.main", input: "terminal" } },
      source: keyboard,
    });
  });

  it("does not resurrect a catalog-local palette after semantic authority arrives", async () => {
    const fake = fakeClient(semantic("home", "main", false), "live");
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "connecting", client: null });
    expect(await binding.setPaletteOpen(true, source)).toBe(false);
    expect(binding.getSnapshot()).toMatchObject({ semantic: null, localPaletteOpen: true });

    binding.adoptGeneration({ status: "live", client: fake.client });
    expect(binding.getSnapshot().localPaletteOpen).toBe(false);
    binding.adoptGeneration({ status: "unavailable", client: null });
    expect(binding.getSnapshot()).toMatchObject({ semantic: null, localPaletteOpen: false });
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

  it("a cancelled real generation starter cannot reveal Terminals after delayed attach", async () => {
    const fake = fakeClient(semantic("home"));
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    let resolveOpen!: (opened: boolean) => void;
    const opening = new Promise<boolean>((resolve) => {
      resolveOpen = resolve;
    });
    let admitted = true;
    const notes = vi.fn(),
      focus = vi.fn(),
      surface = vi.fn();
    const owner = {
      open: () => opening,
      snapshot: () => ({ status: "live" }),
    } as unknown as OpenTuiSessionOwner;
    const start = createApplicationGenerationStarter({
      binding,
      sessionOwner: () => owner,
      focusOwner: () => ({ request: focus, adopt: vi.fn(), dispose: vi.fn() }),
      setNote: notes,
      setSurface: surface,
    });
    const pending = start("main", false, "keyboard", false, () => admitted);
    admitted = false; // User explicitly returns Home while attach is pending.
    resolveOpen(true);
    await expect(pending).resolves.toMatchObject({ opened: false, failure: "superseded" });
    expect(fake.dispatched).toEqual([]);
    expect(focus).not.toHaveBeenCalled();
    expect(surface).not.toHaveBeenCalled();
    expect(notes.mock.calls).toEqual([["opening main"]]);
    binding.dispose();
  });

  it("does not activate a cancelled open when late semantic data becomes ready", async () => {
    const fake = fakeClient(null, "loading");
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    let admitted = true;
    const pending = binding.openSession(
      "main",
      source,
      async () => true,
      () => admitted,
    );
    await Promise.resolve();
    admitted = false;
    fake.publishSemantic(semantic("home"));
    await expect(pending).resolves.toEqual({ opened: false, activated: false });
    expect(fake.dispatched).toEqual([]);
    binding.dispose();
  });

  it("cancellation during mode activation suppresses the trailing generic focus command", async () => {
    const fake = fakeClient(semantic("home"));
    const original = fake.client.dispatch.bind(fake.client);
    let settle!: () => void;
    const delayed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    fake.client.dispatch = async (command) => {
      const result = await original(command);
      await delayed;
      return result;
    };
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    let admitted = true;
    const pending = binding.openSession(
      "main",
      source,
      async () => true,
      () => admitted,
    );
    await Promise.resolve();
    await Promise.resolve();
    admitted = false;
    settle();
    await expect(pending).resolves.toEqual({ opened: true, activated: false });
    expect(fake.dispatched.map((command) => command.invocation.id)).toEqual([
      APPLICATION_SHELL_COMMAND_IDS.activateMode,
    ]);
    binding.dispose();
  });

  it("waits for authoritative V3 semantic readiness before opening Terminals", async () => {
    const fake = fakeClient(null, "loading");
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });
    let settled = false;

    const opening = binding
      .openSession("main", source, async () => true)
      .finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.dispatched).toEqual([]);

    fake.publishSemantic(semantic("home"));
    await expect(opening).resolves.toEqual({ opened: true, activated: true });
    expect(fake.dispatched.map((command) => command.invocation.id)).toEqual([
      APPLICATION_SHELL_COMMAND_IDS.activateMode,
      APPLICATION_SHELL_COMMAND_IDS.moveFocus,
    ]);
  });

  it("releases a delayed semantic open when its generation is unbound", async () => {
    const fake = fakeClient(null, "loading");
    const binding = createApplicationShellBinding();
    binding.adoptGeneration({ status: "live", client: fake.client });

    const opening = binding.openSession("main", source, async () => true);
    await Promise.resolve();
    binding.adoptGeneration({ status: "unavailable", client: null });

    await expect(opening).resolves.toEqual({ opened: true, activated: false });
    expect(fake.dispatched).toEqual([]);
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

  it("publishes only exact OpenTUI-visible shell changes across resource bursts", async () => {
    const initial = semantic("terminals");
    const fake = fakeClient(initial);
    const binding = createApplicationShellBinding();
    const publications: unknown[] = [];
    binding.subscribe((value) => publications.push(value));
    binding.adoptGeneration({ status: "live", client: fake.client });
    expect(publications).toHaveLength(1);

    binding.adoptGeneration({ status: "live", client: fake.client });
    fake.publishLifecycle({ phase: "live", shell: { transport: null } });
    fake.publishAuthority(null);
    fake.publishSemantic({
      ...initial,
      project: {
        ...initial.project,
        id: "project.other",
        rootLabel: "different retained root",
        readiness: { state: "blocked", facts: ["retained fact"], warnings: ["retained warning"] },
      },
      workspace: { id: "workspace.other", name: "retained workspace" },
      terminalInventory: {
        activeResourceId: "pane.other",
        resources: [
          {
            id: "pane.other",
            title: "receipt-only title",
            kind: "terminal",
            active: true,
            attachability: { status: "available", semanticPaneId: "pane.other" },
            windowResourceId: "window.other",
          },
        ],
      },
      focus: {
        ...initial.focus,
        windowActivity: "inactive",
        appFocusedPaneId: "pane.other",
        terminalInputPaneId: "pane.other",
        layoutSelectedPaneId: "pane.other",
        palette: {
          ...initial.focus.palette,
          overlayId: "overlay.retained",
          focusReturnTarget: { kind: "pane", paneId: "pane.other", input: "terminal" },
        },
      },
      statusStrip: {
        ...initial.statusStrip,
        state: "recovering",
        safeState: "retained safe state",
        nextAction: "retained next action",
      },
    });
    expect(publications).toHaveLength(1);
    expect(binding.getSnapshot().semantic?.terminalInventory?.activeResourceId).toBe("pane.other");
    const retained = binding.getSnapshot();
    expect(applicationShellBindingRenderSignature({ ...retained, semantic: initial })).toEqual(
      applicationShellBindingRenderSignature(retained),
    );
    expect(
      applicationShellBindingRenderSignature({ ...retained, status: "rebinding" }),
    ).not.toEqual(applicationShellBindingRenderSignature(retained));
    expect(await binding.setPaletteOpen(true, source)).toBe(true);
    expect(fake.dispatched.at(-1)?.invocation.args).toMatchObject({
      focusReturnTarget: { kind: "pane", paneId: "pane.other", input: "terminal" },
    });

    const visible = [
      { ...initial, project: { ...initial.project, name: "renamed project" } },
      {
        ...initial,
        sidebar: {
          ...initial.sidebar,
          sessions: initial.sidebar.sessions.map((session, index) =>
            index === 0 ? { ...session, label: "renamed session" } : session,
          ),
        },
      },
      {
        ...initial,
        primaryNavigation: {
          ...initial.primaryNavigation,
          items: initial.primaryNavigation.items.map((item, index) =>
            index === 0 ? { ...item, attention: !item.attention } : item,
          ),
        },
      },
      {
        ...initial,
        statusStrip: { ...initial.statusStrip, message: "visible status change" },
      },
      { ...initial, focus: { ...initial.focus, zone: "primary-navigation" as const } },
      {
        ...initial,
        focus: { ...initial.focus, palette: { ...initial.focus.palette, open: true } },
      },
    ];
    for (const value of visible) fake.publishSemantic(value);
    expect(publications).toHaveLength(1 + visible.length);
  });

  it("retains ignored overlay payload changes without publishing visible shell work", () => {
    const initial = semantic("terminals", "main", true);
    const fake = fakeClient(initial);
    const binding = createApplicationShellBinding();
    const publications: unknown[] = [];
    binding.subscribe((value) => publications.push(value));
    binding.adoptGeneration({ status: "live", client: fake.client });
    expect(initial.focus.overlays).toHaveLength(1);
    const overlay = initial.focus.overlays[0]!;
    fake.publishSemantic({
      ...initial,
      focus: {
        ...initial.focus,
        overlays: [
          {
            ...overlay,
            id: "overlay.replaced",
            focusReturnTarget: { kind: "zone", zone: "canvas" },
          },
        ],
      },
    });
    expect(publications).toHaveLength(1);
    expect(binding.getSnapshot().semantic?.focus.overlays[0]?.id).toBe("overlay.replaced");
  });

  it("delimits variable render-signature sections without shifted-boundary aliases", () => {
    const initial = semantic("terminals");
    const fake = fakeClient(initial);
    const binding = createApplicationShellBinding();
    const publications: unknown[] = [];
    binding.subscribe((value) => publications.push(value));
    binding.adoptGeneration({ status: "live", client: fake.client });

    const oneAgent = {
      ...initial,
      sidebar: {
        ...initial.sidebar,
        agents: [
          {
            id: "agent.one",
            name: "primary-navigation",
            harness: "home",
            activity: "idle" as const,
            paneId: null,
            attention: false,
          },
        ],
      },
    };
    fake.publishSemantic(oneAgent);
    fake.publishSemantic({ ...oneAgent, sidebar: { ...oneAgent.sidebar, agents: [] } });
    expect(publications).toHaveLength(3);
  });
});
