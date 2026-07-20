import { describe, expect, it } from "vitest";
import {
  resolveWorkbenchPasteTarget,
  workbenchDockTabForShortcut,
} from "./workbench-controller.ts";

describe("workbench root controller boundary", () => {
  it.each([
    ["f3", "files"],
    ["f4", "changes"],
    ["f6", "missions"],
    ["f9", "activity"],
  ] as const)("maps %s to the %s native dock tab", (name, tab) => {
    expect(workbenchDockTabForShortcut({ name })).toBe(tab);
  });

  it("does not steal modified or unrelated shortcuts", () => {
    expect(workbenchDockTabForShortcut({ name: "f3", shift: true })).toBeNull();
    expect(workbenchDockTabForShortcut({ name: "f6", ctrl: true })).toBeNull();
    expect(workbenchDockTabForShortcut({ name: "f5" })).toBeNull();
  });

  it("allows paste only into the canvas terminal or writable Files editor", () => {
    expect(
      resolveWorkbenchPasteTarget({
        focusZone: "canvas",
        focusedPanel: "terminals",
        filesEditorFocused: false,
        filesEditorWritable: false,
        terminalAvailable: true,
      }),
    ).toBe("terminal");
    expect(
      resolveWorkbenchPasteTarget({
        focusZone: "dock-body",
        focusedPanel: "files",
        filesEditorFocused: true,
        filesEditorWritable: true,
        terminalAvailable: true,
      }),
    ).toBe("files-editor");
    expect(
      resolveWorkbenchPasteTarget({
        focusZone: "canvas",
        focusedPanel: "files",
        filesEditorFocused: true,
        filesEditorWritable: true,
        terminalAvailable: true,
      }),
    ).toBe("files-editor");
    for (const focusedPanel of ["diff", "missions", "activity"] as const) {
      expect(
        resolveWorkbenchPasteTarget({
          focusZone: "dock-body",
          focusedPanel,
          filesEditorFocused: true,
          filesEditorWritable: true,
          terminalAvailable: true,
        }),
      ).toBe("consume");
    }
    expect(
      resolveWorkbenchPasteTarget({
        focusZone: "dock-tabs",
        focusedPanel: "files",
        filesEditorFocused: true,
        filesEditorWritable: true,
        terminalAvailable: true,
      }),
    ).toBe("consume");
    expect(
      resolveWorkbenchPasteTarget({
        focusZone: "canvas",
        focusedPanel: "diff",
        filesEditorFocused: false,
        filesEditorWritable: false,
        terminalAvailable: true,
      }),
    ).toBe("consume");
  });
});
