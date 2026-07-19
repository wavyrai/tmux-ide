import { describe, expect, it } from "vitest";
import {
  OPENTUI_KEYMAP_DECISION,
  TuiCleanupRegistry,
  createTuiLifecycleExecutor,
  executeCtrlCCommand,
  resolveCtrlCCommand,
  resolveInputLayer,
  resolveQuitLifecycleCommand,
  type TuiInputContext,
  type TuiKeyEvent,
} from "./input-lifecycle.ts";

const key = (overrides: Partial<TuiKeyEvent> = {}): TuiKeyEvent => ({
  name: "x",
  ctrl: false,
  meta: false,
  shift: false,
  ...overrides,
});

const context = (overrides: Partial<TuiInputContext> = {}): TuiInputContext => ({
  dialogOpen: false,
  menuOpen: false,
  paletteOpen: false,
  searchOpen: false,
  mode: "mirror",
  activePanelInert: false,
  missionMode: "board",
  editorFocus: "list",
  editorFilterOpen: false,
  diffFilterOpen: false,
  homePromptOpen: false,
  configuredShortcutKeys: ["f1", "f2"],
  compositeCycleAvailable: true,
  ...overrides,
});

describe("input lifecycle boundary", () => {
  it("records why @opentui/keymap is not adopted for this root listener", () => {
    expect(OPENTUI_KEYMAP_DECISION).toMatchObject({
      package: "@opentui/keymap",
      evaluatedVersion: "0.4.3",
      adopted: false,
    });
    expect(OPENTUI_KEYMAP_DECISION.reason).toContain("arbitrary editor/query/pane text");
  });

  it.each([
    [
      "ctrl-q beats dialog",
      context({ dialogOpen: true }),
      key({ name: "q", ctrl: true }),
      "lifecycle",
    ],
    ["dialog beats menu", context({ dialogOpen: true, menuOpen: true }), key(), "dialog"],
    ["menu beats palette", context({ menuOpen: true, paletteOpen: true }), key(), "menu"],
    ["palette beats search", context({ paletteOpen: true, searchOpen: true }), key(), "palette"],
    ["search beats surface", context({ searchOpen: true, mode: "editor" }), key(), "search"],
    [
      "ctrl-tab is global when composite can cycle",
      context(),
      key({ name: "tab", ctrl: true }),
      "global",
    ],
    ["f5 is global palette", context(), key({ name: "f5" }), "global"],
    ["ctrl-p is global palette", context(), key({ name: "p", ctrl: true }), "global"],
    ["configured hosted shortcut is global", context(), key({ name: "f2" }), "global"],
    [
      "ctrl-g is global home",
      context({ activePanelInert: true }),
      key({ name: "g", ctrl: true }),
      "global",
    ],
    [
      "missions detail owns missions detail",
      context({ mode: "missions", missionMode: "detail" }),
      key(),
      "missions-detail",
    ],
    [
      "missions board/history owns missions list modes",
      context({ mode: "missions", missionMode: "history" }),
      key(),
      "missions-board-history",
    ],
    [
      "inert beats underlying editor",
      context({ activePanelInert: true, mode: "editor" }),
      key(),
      "inert",
    ],
    [
      "editor filter owns list query",
      context({ mode: "editor", editorFocus: "list", editorFilterOpen: true }),
      key(),
      "editor-filter",
    ],
    [
      "editor list owns file list",
      context({ mode: "editor", editorFocus: "list" }),
      key(),
      "editor-list",
    ],
    [
      "editor input owns editable buffer",
      context({ mode: "editor", editorFocus: "editor" }),
      key(),
      "editor-input",
    ],
    [
      "diff filter owns diff query",
      context({ mode: "diff", diffFilterOpen: true }),
      key(),
      "diff-filter",
    ],
    ["diff owns diff mode", context({ mode: "diff" }), key(), "diff"],
    [
      "home prompt owns home input",
      context({ mode: "home", homePromptOpen: true }),
      key(),
      "home-prompt",
    ],
    ["home owns home mode", context({ mode: "home" }), key(), "home"],
    ["terminal is final fallback", context(), key(), "terminal"],
  ])("%s", (_name, ctx, evt, expected) => {
    expect(resolveInputLayer(ctx, evt, { hosted: false }).kind).toBe(expected);
  });

  it("does not consume unconfigured function keys or impossible ctrl-tab globally", () => {
    expect(
      resolveInputLayer(context({ configuredShortcutKeys: ["f1"] }), key({ name: "f2" }), {
        hosted: false,
      }).kind,
    ).toBe("terminal");
    expect(
      resolveInputLayer(
        context({ compositeCycleAvailable: false }),
        key({ name: "tab", ctrl: true }),
        {
          hosted: false,
        },
      ).kind,
    ).toBe("terminal");
  });

  it("resolves concrete global commands", () => {
    expect(
      resolveInputLayer(context(), key({ name: "tab", ctrl: true }), { hosted: false }),
    ).toEqual({
      kind: "global",
      command: { kind: "cycle-composite-focus" },
    });
    expect(resolveInputLayer(context(), key({ name: "f5" }), { hosted: false })).toEqual({
      kind: "global",
      command: { kind: "open-palette" },
    });
    expect(resolveInputLayer(context(), key({ name: "f2" }), { hosted: false })).toEqual({
      kind: "global",
      command: { kind: "select-hosted-view", key: "f2" },
    });
    expect(resolveInputLayer(context(), key({ name: "g", ctrl: true }), { hosted: false })).toEqual(
      {
        kind: "global",
        command: { kind: "go-home" },
      },
    );
    expect(
      resolveInputLayer(context({ mode: "diff" }), key({ name: "e", ctrl: true }), {
        hosted: false,
      }),
    ).toEqual({
      kind: "global",
      command: { kind: "toggle-editor" },
    });
  });

  it("suppresses super-modified keys except command-palette open when overlays are absent", () => {
    expect(
      resolveInputLayer(context(), key({ name: "k", super: true }), { hosted: false }),
    ).toEqual({ kind: "kitty-super-palette" });
    expect(
      resolveInputLayer(context({ paletteOpen: true }), key({ name: "k", super: true }), {
        hosted: false,
      }),
    ).toEqual({ kind: "kitty-super-suppressed" });
    expect(
      resolveInputLayer(context(), key({ name: "x", super: true }), { hosted: false }),
    ).toEqual({ kind: "kitty-super-suppressed" });
  });

  it("makes ctrl-c terminal copy-vs-forward explicit and never a quit command", () => {
    expect(
      resolveCtrlCCommand({ layer: "terminal", mirrorAvailable: true, hasTerminalSelection: true }),
    ).toEqual({ kind: "copy-terminal-selection" });
    expect(
      resolveCtrlCCommand({
        layer: "terminal",
        mirrorAvailable: true,
        hasTerminalSelection: false,
      }),
    ).toEqual({ kind: "forward-terminal-ctrl-c" });
    expect(resolveCtrlCCommand({ layer: "editor", hasEditorSelection: true })).toEqual({
      kind: "copy-editor-selection",
    });
    expect(resolveCtrlCCommand({ layer: "editor", hasEditorSelection: false })).toEqual({
      kind: "consume",
    });
    expect(resolveCtrlCCommand({ layer: "overlay" })).toEqual({ kind: "consume" });
  });

  it("executes ctrl-c copy/forward through the injected boundary", () => {
    const calls: string[] = [];
    const executor = {
      copyEditorSelection: () => calls.push("copy-editor"),
      copyTerminalSelection: () => calls.push("copy-terminal"),
      forwardTerminalCtrlC: () => calls.push("send:C-c"),
    };

    executeCtrlCCommand({ kind: "copy-terminal-selection" }, executor);
    executeCtrlCCommand({ kind: "forward-terminal-ctrl-c" }, executor);
    executeCtrlCCommand({ kind: "consume" }, executor);

    expect(calls).toEqual(["copy-terminal", "send:C-c"]);
  });

  it("resolves ctrl-q and palette quit lifecycle semantics without direct process exit", () => {
    expect(resolveQuitLifecycleCommand({ hosted: false }, "keyboard")).toEqual({
      kind: "destroy-renderer",
      source: "keyboard",
    });
    expect(resolveQuitLifecycleCommand({ hosted: true }, "keyboard")).toEqual({
      kind: "hosted-detach",
      source: "keyboard",
    });
    expect(resolveQuitLifecycleCommand({ hosted: true }, "palette")).toEqual({
      kind: "destroy-renderer",
      source: "palette",
    });
  });

  it("runs lifecycle cleanup once, continues after throws, and reports failures deterministically", () => {
    const calls: string[] = [];
    const registry = new TuiCleanupRegistry();
    const failure = new Error("timer cleanup failed");
    registry.set("watcher", () => calls.push("watcher"));
    registry.set("timers", () => {
      calls.push("timers");
      throw failure;
    });
    registry.set("mirror", () => calls.push("mirror"));
    registry.set("editor-buffer", () => calls.push("editor-buffer"));

    const result = registry.runAll();

    expect(result.names).toEqual(["watcher", "timers", "mirror", "editor-buffer"]);
    expect(result.failures).toEqual([{ name: "timers", error: failure }]);
    expect(registry.runAll()).toEqual({ names: [], failures: [] });
    expect(calls).toEqual(["watcher", "timers", "mirror", "editor-buffer"]);
  });

  it("executes non-hosted renderer destroy only once", () => {
    const calls: string[] = [];
    const executor = createTuiLifecycleExecutor({
      destroyRenderer: () => calls.push("destroy"),
      switchClientBack: () => calls.push("switch"),
      detachClient: () => calls.push("detach"),
    });

    executor.run({ kind: "destroy-renderer", source: "keyboard" });
    executor.run({ kind: "destroy-renderer", source: "keyboard" });

    expect(calls).toEqual(["destroy"]);
  });

  it("executes hosted detach once and falls back to one detach on switch failure", () => {
    const calls: string[] = [];
    const executor = createTuiLifecycleExecutor({
      destroyRenderer: () => calls.push("destroy"),
      switchClientBack: (callback) => {
        calls.push("switch");
        callback(new Error("no last client"));
      },
      detachClient: () => calls.push("detach"),
    });

    executor.run({ kind: "hosted-detach", source: "keyboard" });
    executor.run({ kind: "hosted-detach", source: "keyboard" });

    expect(calls).toEqual(["switch", "detach"]);
  });

  it("executes hosted palette quit as destroy once", () => {
    const calls: string[] = [];
    const executor = createTuiLifecycleExecutor({
      destroyRenderer: () => calls.push("destroy"),
      switchClientBack: () => calls.push("switch"),
      detachClient: () => calls.push("detach"),
    });

    executor.run(resolveQuitLifecycleCommand({ hosted: true }, "palette"));
    executor.run(resolveQuitLifecycleCommand({ hosted: true }, "palette"));

    expect(calls).toEqual(["destroy"]);
  });
});
