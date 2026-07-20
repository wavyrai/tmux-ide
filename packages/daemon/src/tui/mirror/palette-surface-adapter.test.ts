import { describe, expect, it } from "vitest";
import type { PaletteAction, PaletteRow } from "./palette.ts";
import {
  adaptPaletteRowsToCommands,
  appendPalettePaste,
  dispatchPaletteCommand,
  ensurePaletteSelectionVisible,
  firstEnabledPaletteCommandId,
  PaletteBufferLoadGate,
  paletteActionForCommand,
  paletteCommandId,
  restorePaletteActionLevelFromBuffers,
  stepEnabledPaletteCommandId,
} from "./palette-surface-adapter.ts";
import {
  commandPaletteHitTest,
  projectCommandPalette,
} from "./workspace/command-palette-surface.ts";

const actionRow = (action: PaletteAction, shortcut: string | null = null): PaletteRow => ({
  type: "action",
  action,
  shortcut,
});

const save: PaletteAction = { kind: "save", label: "Save file" };
const home: PaletteAction = { kind: "tab", tab: "home", label: "Switch tab: Home" };
const terminals: PaletteAction = {
  kind: "tab",
  tab: "terminal",
  label: "Switch tab: Terminal",
};
const quit: PaletteAction = { kind: "quit", label: "Quit" };
const writableSaveState = {
  hasBuffer: true,
  hasPath: true,
  readOnlyReason: null,
};

describe("live command palette adapter", () => {
  it("preserves ranked groups while projecting semantic command metadata", () => {
    const entries = adaptPaletteRowsToCommands(
      [
        { type: "header", label: "recent" },
        actionRow(terminals, "F2"),
        { type: "header", label: "suggested" },
        actionRow(save, "⌘S"),
        { type: "header", label: "commands" },
        actionRow(home, "F1"),
        actionRow(quit, "⌘Q"),
      ],
      {
        currentTab: "terminal",
        saveState: { hasBuffer: false, hasPath: false, readOnlyReason: null },
      },
    );

    expect(entries.map((entry) => entry.action)).toEqual([terminals, save, home, quit]);
    expect(entries.map((entry) => entry.descriptor.group)).toEqual([
      "recent",
      "suggested",
      "commands",
      "commands",
    ]);
    expect(entries[0]!.descriptor).toMatchObject({
      category: "Navigation",
      icon: "terminals",
      current: true,
      shortcut: "F2",
    });
    expect(entries[1]!.descriptor).toMatchObject({
      category: "Files",
      disabledReason: "No file is open",
    });
    expect(entries[3]!.descriptor).toMatchObject({ category: "Application", icon: "close" });

    const projection = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: entries.map((entry) => entry.descriptor),
      selectedCommandId: entries[0]!.id,
    });
    expect(
      projection.rows.filter((row) => row.kind === "group").map((row) => row.category),
    ).toEqual(["recent", "suggested", "commands"]);
    const saveRow = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === paletteCommandId(save),
    );
    expect(saveRow).toMatchObject({ kind: "command", category: "Files", disabled: true });
  });

  it("keeps dynamic files and runtime panes uniquely addressable", () => {
    const firstFile: PaletteAction = { kind: "go-file", path: "src/a.ts", label: "a" };
    const secondFile: PaletteAction = { kind: "go-file", path: "src/b.ts", label: "b" };
    const firstPane: PaletteAction = {
      kind: "jump-agent",
      session: "demo",
      paneId: "%1",
      windowIndex: 0,
      label: "first",
    };
    const secondPane: PaletteAction = { ...firstPane, paneId: "%2", label: "second" };
    const ids = [firstFile, secondFile, firstPane, secondPane].map(paletteCommandId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("navigates across groups, skips disabled commands, and never executes one", () => {
    const entries = adaptPaletteRowsToCommands(
      [
        { type: "header", label: "recent" },
        actionRow(save),
        actionRow(terminals),
        { type: "header", label: "commands" },
        actionRow(home),
        actionRow(quit),
      ],
      { saveState: { hasBuffer: false, hasPath: false, readOnlyReason: null } },
    );
    const selected = firstEnabledPaletteCommandId(entries);
    expect(selected).toBe(paletteCommandId(terminals));
    expect(stepEnabledPaletteCommandId(entries, selected, 1)).toBe(paletteCommandId(home));
    expect(stepEnabledPaletteCommandId(entries, paletteCommandId(home), -1)).toBe(selected);
    expect(paletteActionForCommand(entries, paletteCommandId(save))).toBeNull();
    expect(paletteActionForCommand(entries, paletteCommandId(quit))).toBe(quit);

    const executed: PaletteAction[] = [];
    expect(
      dispatchPaletteCommand(entries, paletteCommandId(save), (action) => executed.push(action)),
    ).toBe(false);
    expect(executed).toEqual([]);
    expect(
      dispatchPaletteCommand(entries, paletteCommandId(quit), (action) => executed.push(action)),
    ).toBe(true);
    expect(executed).toEqual([quit]);
  });

  it.each([
    [
      "missing buffer",
      { hasBuffer: false, hasPath: true, readOnlyReason: null },
      "No file is open",
    ],
    ["missing path", { hasBuffer: true, hasPath: false, readOnlyReason: null }, "No file is open"],
    [
      "read-only file",
      { hasBuffer: true, hasPath: true, readOnlyReason: "binary" },
      "File is read-only",
    ],
    ["writable editor", writableSaveState, null],
  ] as const)("maps the %s Save executor preconditions exactly", (_label, saveState, reason) => {
    const entries = adaptPaletteRowsToCommands([actionRow(save), actionRow(quit)], { saveState });
    const saveEntry = entries[0]!;

    expect(saveEntry.descriptor.disabledReason).toBe(reason);
    expect(paletteActionForCommand(entries, saveEntry.id)).toBe(reason ? null : save);
  });

  it("keeps keyboard selection visible after grouped overflow", () => {
    const actions = Array.from(
      { length: 24 },
      (_, index): PaletteAction => ({
        kind: "open-file",
        path: `src/file-${index}.ts`,
        label: `Open file ${index}`,
      }),
    );
    const entries = adaptPaletteRowsToCommands(
      actions.map((action) => actionRow(action)),
      {
        fallbackGroup: "Results",
      },
    );
    const target = entries.at(-1)!.id;
    const projection = projectCommandPalette({
      width: 80,
      height: 24,
      query: "file",
      commands: entries.map((entry) => entry.descriptor),
      selectedCommandId: target,
      scrollTop: 0,
    });
    expect(projection.rows.some((row) => row.kind === "command" && row.commandId === target)).toBe(
      false,
    );
    const scrollTop = ensurePaletteSelectionVisible(projection, entries, target);
    const scrolled = projectCommandPalette({
      width: 80,
      height: 24,
      query: "file",
      commands: entries.map((entry) => entry.descriptor),
      selectedCommandId: target,
      scrollTop,
    });
    expect(scrolled.rows.some((row) => row.kind === "command" && row.commandId === target)).toBe(
      true,
    );
  });

  it("returns from paste buffers with the parent selected and visible", () => {
    const actions: PaletteAction[] = [
      ...Array.from(
        { length: 10 },
        (_, index): PaletteAction => ({
          kind: "go-file",
          path: `src/before-${index}.ts`,
          label: `Before ${index}`,
        }),
      ),
      { kind: "paste-buffer", label: "Paste buffer…" },
      quit,
    ];
    const entries = adaptPaletteRowsToCommands(
      actions.map((action) => actionRow(action)),
      { fallbackGroup: "Commands", saveState: writableSaveState },
    );
    const parentId = entries.find((entry) => entry.action.kind === "paste-buffer")!.id;
    const atTop = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: entries.map((entry) => entry.descriptor),
      selectedCommandId: parentId,
      scrollTop: 0,
    });
    expect(atTop.rows.some((row) => row.kind === "command" && row.commandId === parentId)).toBe(
      false,
    );

    const restore = restorePaletteActionLevelFromBuffers(atTop, entries);
    const restored = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: entries.map((entry) => entry.descriptor),
      selectedCommandId: restore.selectedCommandId,
      scrollTop: restore.scrollTop,
    });

    expect(restore.selectedCommandId).toBe(parentId);
    expect(restored.rows).toContainEqual(
      expect.objectContaining({ kind: "command", commandId: parentId, selected: true }),
    );
  });

  it("rejects stale, closed, reopened, and overlapping buffer loads", () => {
    const gate = new PaletteBufferLoadGate();
    const committed: string[] = [];
    const slow = gate.begin();
    const fast = gate.begin();

    expect(gate.commit(slow, () => committed.push("slow"))).toBe(false);
    expect(gate.commit(fast, () => committed.push("fast"))).toBe(true);
    expect(committed).toEqual(["fast"]);

    const closed = gate.begin();
    gate.invalidate();
    expect(gate.commit(closed, () => committed.push("closed"))).toBe(false);

    const beforeReopen = gate.begin();
    gate.invalidate();
    const afterReopen = gate.begin();
    expect(gate.commit(beforeReopen, () => committed.push("before-reopen"))).toBe(false);
    expect(gate.commit(afterReopen, () => committed.push("after-reopen"))).toBe(true);
    expect(committed).toEqual(["fast", "after-reopen"]);
  });

  it("routes command, disabled, retry, and outside pointer hits semantically", () => {
    const entries = adaptPaletteRowsToCommands([actionRow(save), actionRow(quit)], {
      saveState: { hasBuffer: false, hasPath: false, readOnlyReason: null },
    });
    const projection = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: entries.map((entry) => entry.descriptor),
    });
    const disabled = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === paletteCommandId(save),
    );
    const executable = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === paletteCommandId(quit),
    );
    expect(disabled?.kind).toBe("command");
    expect(executable?.kind).toBe("command");
    if (disabled?.kind === "command" && executable?.kind === "command") {
      expect(commandPaletteHitTest(projection, disabled.rect.x, disabled.rect.y)).toEqual({
        kind: "command",
        commandId: paletteCommandId(save),
        disabled: true,
      });
      expect(commandPaletteHitTest(projection, executable.rect.x, executable.rect.y)).toEqual({
        kind: "command",
        commandId: paletteCommandId(quit),
        disabled: false,
      });
    }
    expect(commandPaletteHitTest(projection, 0, 0)).toBeNull();

    const error = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: [],
      phase: "error",
      retryCommandId: "palette.retry",
    });
    const retry = error.rows.find((row) => row.kind === "state" && row.state === "retry");
    expect(retry?.kind).toBe("state");
    if (retry?.kind === "state") {
      expect(commandPaletteHitTest(error, retry.rect.x, retry.rect.y)).toEqual({
        kind: "retry",
        commandId: "palette.retry",
      });
    }
  });

  it("turns bracketed paste into a safe single-line query", () => {
    expect(appendPalettePaste("open ", "src/one.ts\n\u001b[31mnext")).toBe(
      "open src/one.ts [31mnext",
    );
  });
});
