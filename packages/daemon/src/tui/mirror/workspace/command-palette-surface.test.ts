import { describe, expect, it } from "vitest";
import { terminalDisplayWidth } from "../panel-host.ts";
import {
  commandPaletteHitTest,
  projectCommandPalette,
  type CommandPaletteDescriptor,
  type CommandPaletteProjection,
} from "./command-palette-surface.ts";

const commands: readonly CommandPaletteDescriptor[] = [
  {
    id: "workspace.view.home",
    icon: "home",
    label: "Open Home",
    description: "Show projects and recent workspaces",
    category: "Navigation",
    shortcut: "F1",
    current: true,
  },
  {
    id: "workspace.view.terminals",
    icon: "terminals",
    label: "Open Terminals",
    detail: "Return to the live agent canvas",
    category: "Navigation",
    shortcut: "F2",
    status: "3 agents",
  },
  {
    id: "workspace.file.open",
    icon: "files",
    label: "Open File…",
    description: "Find a file in this workspace",
    category: "Files",
    shortcut: "⌘P",
  },
  {
    id: "workspace.file.save",
    icon: "files",
    label: "Save File",
    detail: "Write the current editor buffer",
    category: "Files",
    shortcut: "⌘S",
    disabledReason: "No file is open",
  },
  {
    id: "workspace.pane.maximize",
    icon: "maximize",
    label: "Maximize Active Pane",
    description: "Focus the active terminal without changing tmux truth",
    category: "Window",
    shortcut: "⌘↵",
  },
];

function overflowCommands(category: string, count: number, start = 0): CommandPaletteDescriptor[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `overflow.${category.toLowerCase()}.${start + index}`,
    icon: "command" as const,
    label: `${category} command ${start + index + 1}`,
    description: `Two-line ${category.toLowerCase()} command ${start + index + 1}`,
    category,
  }));
}

function expectRectInProjection(
  projection: CommandPaletteProjection,
  rect: { x: number; y: number; width: number; height: number },
) {
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.width).toBeGreaterThanOrEqual(0);
  expect(rect.height).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(projection.width);
  expect(rect.y + rect.height).toBeLessThanOrEqual(projection.height);
}

describe("command palette surface projection", () => {
  it.each([
    [80, 24, "compact"],
    [120, 40, "standard"],
    [200, 60, "wide"],
  ] as const)("adapts to %sx%s as %s", (width, height, variant) => {
    const projection = projectCommandPalette({
      width,
      height,
      query: "",
      commands,
      selectedCommandId: "workspace.view.terminals",
    });

    expect(projection.variant).toBe(variant);
    expectRectInProjection(projection, projection.overlay);
    expectRectInProjection(projection, projection.header);
    expectRectInProjection(projection, projection.query);
    expectRectInProjection(projection, projection.divider);
    expectRectInProjection(projection, projection.list);
    expectRectInProjection(projection, projection.footer);
    expect(projection.rowIds).toEqual(projection.rows.map((row) => row.id));

    for (const row of projection.rows) {
      expectRectInProjection(projection, row.rect);
      expect(row.rect.x).toBeGreaterThanOrEqual(projection.list.x);
      expect(row.rect.x + row.rect.width).toBeLessThanOrEqual(
        projection.list.x + projection.list.width,
      );
      expect(row.rect.y).toBeGreaterThanOrEqual(projection.list.y);
      expect(row.rect.y + row.rect.height).toBeLessThanOrEqual(
        projection.list.y + projection.list.height,
      );
      expect(terminalDisplayWidth(row.labelSpan.text)).toBeLessThanOrEqual(row.labelSpan.width);
    }
  });

  it("projects semantic icons, detail, grouping, trailing metadata, disabled reasons, and state", () => {
    const projection = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands,
      selectedCommandId: "workspace.view.terminals",
    });
    expect(
      projection.rows.filter((row) => row.kind === "group").map((row) => row.category),
    ).toEqual(["Navigation", "Files", "Window"]);

    const current = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === "workspace.view.home",
    );
    expect(current).toMatchObject({
      kind: "command",
      iconId: "home",
      icon: "⌂",
      current: true,
      selected: false,
      shortcut: "F1",
    });
    if (current?.kind === "command") {
      expect(current.markerSpan.text).toBe("✓");
      expect(current.detailSpan?.text).toContain("projects");
      expect(current.trailingSpan?.text).toBe("F1");
    }

    const selected = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === "workspace.view.terminals",
    );
    expect(selected).toMatchObject({
      kind: "command",
      selected: true,
      status: "3 agents",
      shortcut: "F2",
    });
    if (selected?.kind === "command") {
      expect(selected.markerSpan.text).toBe("›");
      expect(selected.trailingSpan?.text).toContain("3 agents");
      expect(selected.trailingSpan?.text).toContain("F2");
    }

    const disabled = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === "workspace.file.save",
    );
    expect(disabled).toMatchObject({
      kind: "command",
      disabled: true,
      disabledReason: "No file is open",
      detail: "No file is open",
    });

    const compact = projectCommandPalette({
      width: 80,
      height: 24,
      query: "",
      commands,
    });
    const compactDisabled = compact.rows.find(
      (row) => row.kind === "command" && row.commandId === "workspace.file.save",
    );
    if (compactDisabled?.kind === "command") {
      expect(compactDisabled.markerSpan.text).toBe("×");
      expect(compactDisabled.labelSpan.text).toContain("No file is open");
    }
  });

  it("keeps presentation groups separate from semantic command categories", () => {
    const projection = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: [
        { ...commands[0]!, group: "Recent" },
        { ...commands[2]!, group: "Suggested" },
      ],
    });
    expect(
      projection.rows.filter((row) => row.kind === "group").map((row) => row.category),
    ).toEqual(["Recent", "Suggested"]);
    expect(
      projection.rows
        .filter((row) => row.kind === "command")
        .map((row) => (row.kind === "command" ? row.category : "")),
    ).toEqual(["Navigation", "Files"]);
  });

  it("keeps semantic row ids stable across fresh descriptors and transient selection", () => {
    const first = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands,
      selectedCommandId: commands[0]!.id,
    });
    const freshCommands = commands.map((command) => ({ ...command }));
    const second = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: freshCommands,
      selectedCommandId: commands[2]!.id,
    });
    expect(second.rowIds).toEqual(first.rowIds);
    expect(new Set(second.rowIds).size).toBe(second.rowIds.length);

    const duplicate = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands: [...commands, { ...commands[0]!, label: "Duplicate" }],
    });
    expect(duplicate.commandCount).toBe(commands.length);
    expect(new Set(duplicate.rowIds).size).toBe(duplicate.rowIds.length);
  });

  it.each([
    [120, 28, "standard", 9],
    [200, 44, "wide", 13],
  ] as const)(
    "only publishes full two-line rows at the %sx%s %s overflow boundary",
    (width, height, variant, visibleCommands) => {
      const projection = projectCommandPalette({
        width,
        height,
        query: "",
        commands: overflowCommands("Overflow", visibleCommands + 3),
      });
      const commandRows = projection.rows.filter((row) => row.kind === "command");

      expect(projection.variant).toBe(variant);
      expect(commandRows).toHaveLength(visibleCommands);
      expect(commandRows.every((row) => row.rect.height === 2)).toBe(true);
      expect(projection.rows.at(-1)?.kind).toBe("command");
      expect(projection.visibleEnd - projection.visibleStart).toBe(projection.rows.length);
      expect(projection.hasMoreAfter).toBe(true);
      expect(projection.rows.at(-1)!.rect.y + projection.rows.at(-1)!.rect.height).toBe(
        projection.list.y + projection.list.height - 1,
      );
    },
  );

  it("reserves a category header and its first command atomically", () => {
    const firstCategory = overflowCommands("Alpha", 9);
    const nextCategory = overflowCommands("Beta", 1, 9);
    const firstPage = projectCommandPalette({
      width: 120,
      height: 28,
      query: "",
      commands: [...firstCategory, ...nextCategory],
    });

    expect(firstPage.rows.map((row) => row.id)).toEqual([
      "group:Alpha",
      ...firstCategory.map((command) => `command:${command.id}`),
    ]);
    expect(firstPage.rowIds).not.toContain("group:Beta");
    expect(firstPage.visibleEnd).toBe(firstPage.rows.length);
    expect(firstPage.hasMoreAfter).toBe(true);

    const nextPage = projectCommandPalette({
      width: 120,
      height: 28,
      query: "",
      commands: [...firstCategory, ...nextCategory],
      scrollTop: firstPage.visibleEnd,
    });
    expect(nextPage.rowIds).toEqual(["group:Beta", `command:${nextCategory[0]!.id}`]);
  });

  it("keeps scrollTop page continuity and final visible-row hit geometry exact", () => {
    const allCommands = overflowCommands("Overflow", 10);
    const firstPage = projectCommandPalette({
      width: 120,
      height: 28,
      query: "",
      commands: allCommands,
    });
    const secondPage = projectCommandPalette({
      width: 120,
      height: 28,
      query: "",
      commands: allCommands,
      scrollTop: firstPage.visibleEnd,
    });
    const expectedIds = [
      "group:Overflow",
      ...allCommands.map((command) => `command:${command.id}`),
    ];

    expect(firstPage.visibleEnd).toBe(secondPage.visibleStart);
    expect([...firstPage.rowIds, ...secondPage.rowIds]).toEqual(expectedIds);
    expect(new Set([...firstPage.rowIds, ...secondPage.rowIds]).size).toBe(expectedIds.length);

    const last = firstPage.rows.at(-1)!;
    expect(last.kind).toBe("command");
    if (last.kind === "command") {
      expect(
        commandPaletteHitTest(
          firstPage,
          last.rect.x + last.rect.width - 1,
          last.rect.y + last.rect.height - 1,
        ),
      ).toEqual({ kind: "command", commandId: last.commandId, disabled: false });
    }
    expect(
      commandPaletteHitTest(
        firstPage,
        firstPage.list.x,
        firstPage.list.y + firstPage.list.height - 1,
      ),
    ).toEqual({ kind: "palette" });
  });

  it.each([
    [0, 0],
    [1, 1],
    [4, 3],
    [12, 6],
    [28, 10],
  ] as const)("stays inside a narrow %sx%s viewport", (width, height) => {
    const projection = projectCommandPalette({
      width,
      height,
      query: "term",
      commands,
      selectedCommandId: commands[0]!.id,
    });
    expectRectInProjection(projection, projection.overlay);
    for (const row of projection.rows) expectRectInProjection(projection, row.rect);
    expect(projection.rowIds.every((id) => id.length > 0)).toBe(true);
  });

  it("models loading, empty, no-match, and error/retry states with stable ids", () => {
    const loading = projectCommandPalette({
      width: 80,
      height: 24,
      query: "",
      commands: [],
      phase: "loading",
    });
    expect(loading.rows).toMatchObject([{ id: "state:loading", state: "loading" }]);

    const empty = projectCommandPalette({ width: 80, height: 24, query: "", commands: [] });
    expect(empty.rows).toMatchObject([{ id: "state:empty", state: "empty" }]);

    const noMatch = projectCommandPalette({
      width: 80,
      height: 24,
      query: "does-not-exist",
      commands: [],
    });
    expect(noMatch.rows).toMatchObject([{ id: "state:no-match", state: "no-match" }]);

    const error = projectCommandPalette({
      width: 80,
      height: 24,
      query: "",
      commands: [],
      phase: "error",
      errorMessage: "Daemon command discovery timed out",
      retryCommandId: "commands.reload",
      selectedCommandId: "commands.reload",
    });
    expect(error.rows).toMatchObject([
      { id: "state:error", state: "error", detail: "Daemon command discovery timed out" },
      { id: "state:retry:commands.reload", state: "retry", actionable: true, selected: true },
    ]);
  });

  it("exposes exact root-owned query, command, disabled, retry, and outside hit seams", () => {
    const projection = projectCommandPalette({
      width: 120,
      height: 40,
      query: "",
      commands,
      selectedCommandId: commands[1]!.id,
    });
    expect(commandPaletteHitTest(projection, projection.query.x, projection.query.y)).toEqual({
      kind: "query",
    });
    const command = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === "workspace.view.terminals",
    );
    const disabled = projection.rows.find(
      (row) => row.kind === "command" && row.commandId === "workspace.file.save",
    );
    expect(commandPaletteHitTest(projection, command!.rect.x, command!.rect.y)).toEqual({
      kind: "command",
      commandId: "workspace.view.terminals",
      disabled: false,
    });
    expect(commandPaletteHitTest(projection, disabled!.rect.x, disabled!.rect.y)).toEqual({
      kind: "command",
      commandId: "workspace.file.save",
      disabled: true,
    });
    expect(commandPaletteHitTest(projection, -1, -1)).toBeNull();

    const error = projectCommandPalette({
      width: 80,
      height: 24,
      query: "",
      commands: [],
      phase: "error",
      retryCommandId: "commands.reload",
    });
    const retry = error.rows.find((row) => row.kind === "state" && row.state === "retry")!;
    expect(commandPaletteHitTest(error, retry.rect.x, retry.rect.y)).toEqual({
      kind: "retry",
      commandId: "commands.reload",
    });
  });
});
