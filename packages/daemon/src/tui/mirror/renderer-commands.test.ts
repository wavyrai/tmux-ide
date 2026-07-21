import { describe, expect, it, vi } from "vitest";
import {
  APPLICATION_SHELL_COMMAND_DEFINITIONS,
  APPLICATION_SHELL_COMMAND_IDS,
  COMMAND_PROTOCOL_VERSION,
  applicationShellCommandInvocation,
  type CommandInvocation,
} from "@tmux-ide/contracts";
import { z } from "zod";
import { CommandRegistry } from "../../lib/command-registry.ts";
import {
  RENDERER_COMMAND_BYPASS_CHANNELS,
  RENDERER_COMMAND_DEFINITIONS,
  RENDERER_COMMAND_IDS,
  createRendererCommandExecutor,
  createRendererCommandRegistry,
  rendererCommandInvocation,
  rendererInvocationForCanvas,
  rendererInvocationForDock,
  rendererInvocationForGlobal,
  rendererInvocationForLifecycle,
  rendererInvocationForView,
  rendererRegistersReservedWindowModeCommand,
  type RendererCommandContext,
  type RendererCommandEffects,
} from "./renderer-commands.ts";

const effects = (): RendererCommandEffects => ({
  openPalette: vi.fn(),
  runLifecycle: vi.fn(),
  cycleCompositeFocus: vi.fn(),
  activateShortcut: vi.fn(),
  activateView: vi.fn(),
  activateCanvas: vi.fn(),
  activateDock: vi.fn(),
  openHome: vi.fn(),
  toggleEditor: vi.fn(),
});

const available: RendererCommandContext = {
  compositeFocusAvailable: true,
  editorAvailable: true,
};

describe("renderer command boundary", () => {
  it("keeps the root lifecycle/global adapters stable", () => {
    expect(rendererInvocationForGlobal({ kind: "open-palette" })).toMatchObject({
      id: "app.palette.open",
      source: { kind: "keyboard" },
      args: {},
    });
    expect(rendererInvocationForGlobal({ kind: "select-hosted-view", key: "f2" })).toMatchObject({
      id: "workspace.shortcut.activate",
      args: { key: "f2" },
    });
    expect(rendererInvocationForLifecycle({ kind: "hosted-detach", source: "keyboard" })).toEqual({
      version: 1,
      id: "app.quit",
      source: { kind: "keyboard", surface: "application" },
      args: { kind: "hosted-detach", source: "keyboard" },
    });
    expect(
      rendererInvocationForLifecycle({ kind: "destroy-renderer", source: "palette" }),
    ).toMatchObject({
      id: "app.quit",
      source: { kind: "palette" },
      args: { kind: "destroy-renderer", source: "palette" },
    });
  });

  it("adapts canvas, dock, and configured view activations", () => {
    expect(rendererInvocationForCanvas("home", { kind: "keyboard" })).toMatchObject({
      id: "workspace.canvas.activate",
      args: { panel: "home" },
    });
    expect(rendererInvocationForDock("missions", { kind: "keyboard" })).toMatchObject({
      id: "workspace.dock.activate",
      args: { tab: "missions" },
    });
    expect(rendererInvocationForView("my-view", { kind: "palette" })).toMatchObject({
      id: "workspace.view.activate",
      args: { viewId: "my-view" },
    });
  });

  it("composes the live renderer and canonical shell catalogs without id or input collisions", () => {
    const rendererIds = new Set(
      RENDERER_COMMAND_DEFINITIONS.map(({ descriptor }) => descriptor.id),
    );
    const shellIds = APPLICATION_SHELL_COMMAND_DEFINITIONS.map(({ descriptor }) => descriptor.id);
    expect(shellIds.filter((id) => rendererIds.has(id))).toEqual([]);

    const registry = new CommandRegistry<RendererCommandContext>([
      ...RENDERER_COMMAND_DEFINITIONS,
      ...APPLICATION_SHELL_COMMAND_DEFINITIONS,
    ]);
    expect(registry.descriptors()).toHaveLength(
      RENDERER_COMMAND_DEFINITIONS.length + APPLICATION_SHELL_COMMAND_DEFINITIONS.length,
    );

    const source = { kind: "program", surface: "compatibility-test" } as const;
    expect(
      registry.resolve(
        rendererCommandInvocation(RENDERER_COMMAND_IDS.openPalette, {}, source),
        available,
      ),
    ).toMatchObject({ ok: true, command: { input: {} } });
    expect(
      registry.resolve(
        rendererCommandInvocation(RENDERER_COMMAND_IDS.activateDock, { tab: "missions" }, source),
        available,
      ),
    ).toMatchObject({ ok: true, command: { input: { tab: "missions" } } });
    expect(
      registry.resolve(
        applicationShellCommandInvocation(
          APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
          { tool: "missions" },
          source,
        ),
        available,
      ),
    ).toMatchObject({ ok: true, command: { input: { tool: "missions" } } });
    expect(
      registry.resolve(
        {
          version: COMMAND_PROTOCOL_VERSION,
          id: APPLICATION_SHELL_COMMAND_IDS.activateDockTool,
          source,
          args: { tab: "missions" },
        },
        available,
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid-input" } });
  });

  it("executes every converted effect through one injected seam", () => {
    const calls = effects();
    const executor = createRendererCommandExecutor({ context: () => available, effects: calls });
    executor.execute(rendererInvocationForGlobal({ kind: "open-palette" }));
    executor.execute(rendererInvocationForGlobal({ kind: "cycle-composite-focus" }));
    executor.execute(rendererInvocationForGlobal({ kind: "go-home" }));
    executor.execute(rendererInvocationForGlobal({ kind: "toggle-editor" }));
    executor.execute(rendererInvocationForCanvas("terminals", { kind: "mouse" }));
    executor.execute(rendererInvocationForDock("changes", { kind: "keyboard" }));
    executor.execute(rendererInvocationForView("focus", { kind: "palette" }));

    expect(calls.openPalette).toHaveBeenCalledTimes(1);
    expect(calls.cycleCompositeFocus).toHaveBeenCalledTimes(1);
    expect(calls.openHome).toHaveBeenCalledTimes(1);
    expect(calls.toggleEditor).toHaveBeenCalledTimes(1);
    expect(calls.activateCanvas).toHaveBeenCalledWith("terminals");
    expect(calls.activateDock).toHaveBeenCalledWith("changes");
    expect(calls.activateView).toHaveBeenCalledWith("focus");
  });

  it("preserves hosted keyboard detach and palette destroy lifecycle commands", () => {
    const calls = effects();
    const executor = createRendererCommandExecutor({ context: () => available, effects: calls });
    executor.execute(rendererInvocationForLifecycle({ kind: "hosted-detach", source: "keyboard" }));
    executor.execute(
      rendererInvocationForLifecycle({ kind: "destroy-renderer", source: "palette" }),
    );
    expect(calls.runLifecycle).toHaveBeenNthCalledWith(1, {
      kind: "hosted-detach",
      source: "keyboard",
    });
    expect(calls.runLifecycle).toHaveBeenNthCalledWith(2, {
      kind: "destroy-renderer",
      source: "palette",
    });
  });

  it("keeps unavailable commands from reaching effects", () => {
    const calls = effects();
    const rejected = vi.fn();
    const executor = createRendererCommandExecutor({
      context: () => ({ compositeFocusAvailable: false, editorAvailable: false }),
      effects: calls,
      onRejected: rejected,
    });
    expect(executor.execute(rendererInvocationForGlobal({ kind: "toggle-editor" }))).toMatchObject({
      ok: false,
      error: { code: "unavailable", message: "no file is open" },
    });
    expect(calls.toggleEditor).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("ignores an injected custom registry and rejects its unknown renderer ids", () => {
    const calls = effects();
    const rejected = vi.fn();
    const maliciousRegistry = new CommandRegistry<RendererCommandContext>([
      {
        descriptor: {
          version: COMMAND_PROTOCOL_VERSION,
          id: "app.malicious",
          owner: "renderer",
          label: "Run arbitrary effect",
          category: "application",
          schemas: { input: "app.malicious.input.v1" },
          dangerous: false,
          confirmation: "none",
        },
        inputSchema: z.object({}).strict(),
      },
    ]);
    const executorInput = {
      registry: maliciousRegistry,
      context: () => available,
      effects: calls,
      onRejected: rejected,
    };
    const executor = createRendererCommandExecutor(executorInput);
    const invocation: CommandInvocation = {
      version: COMMAND_PROTOCOL_VERSION,
      id: "app.malicious",
      source: { kind: "program" },
      args: {},
    };

    expect(executor.execute(invocation)).toMatchObject({
      ok: false,
      error: { code: "unknown-command", commandId: "app.malicious" },
    });
    expect(rejected).toHaveBeenCalledTimes(1);
    for (const effect of Object.values(calls)) expect(effect).not.toHaveBeenCalled();
  });

  it("ignores injected schema drift and validates effects with canonical schemas", () => {
    const calls = effects();
    const driftedRegistry = new CommandRegistry<RendererCommandContext>([
      {
        descriptor: {
          version: COMMAND_PROTOCOL_VERSION,
          id: RENDERER_COMMAND_IDS.quit,
          owner: "renderer",
          label: "Drifted quit",
          category: "application",
          schemas: { input: "app.quit.drifted.input.v1" },
          dangerous: false,
          confirmation: "none",
        },
        inputSchema: z.object({ kind: z.string(), source: z.string() }).strict(),
      },
    ]);
    const executorInput = {
      registry: driftedRegistry,
      context: () => available,
      effects: calls,
    };
    const executor = createRendererCommandExecutor(executorInput);
    const invalidLifecycle: CommandInvocation = {
      version: COMMAND_PROTOCOL_VERSION,
      id: RENDERER_COMMAND_IDS.quit,
      source: { kind: "program" },
      args: { kind: "hosted-detach", source: "palette" },
    };

    expect(executor.execute(invalidLifecycle)).toMatchObject({
      ok: false,
      error: { code: "invalid-input", commandId: RENDERER_COMMAND_IDS.quit },
    });
    expect(calls.runLifecycle).not.toHaveBeenCalled();
  });

  it("keeps raw Ctrl-C, paste, PTY output, and resize outside the catalog", () => {
    expect(RENDERER_COMMAND_BYPASS_CHANNELS).toEqual(["ctrl-c", "paste", "pty-output", "resize"]);
    const ids = createRendererCommandRegistry()
      .descriptors()
      .map((item) => item.id);
    for (const channel of RENDERER_COMMAND_BYPASS_CHANNELS) {
      expect(ids.some((id) => id.includes(channel))).toBe(false);
    }
  });

  it("does not register or execute the reserved Card12 window-mode ids", () => {
    expect(rendererRegistersReservedWindowModeCommand()).toBe(false);
  });

  it("keeps every definition data-only and serializable", () => {
    for (const definition of RENDERER_COMMAND_DEFINITIONS) {
      expect(JSON.parse(JSON.stringify(definition.descriptor))).toEqual(definition.descriptor);
      expect(definition).not.toHaveProperty("handler");
      expect(definition).not.toHaveProperty("execute");
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.descriptor)).toBe(true);
      expect(Object.isFrozen(definition.descriptor.schemas)).toBe(true);
    }
    expect(Object.isFrozen(RENDERER_COMMAND_DEFINITIONS)).toBe(true);
    const registry = createRendererCommandRegistry();
    expect(
      registry.resolve(
        rendererCommandInvocation(RENDERER_COMMAND_IDS.openPalette, {}, { kind: "keyboard" }),
        available,
      ),
    ).toMatchObject({ ok: true });
  });
});
