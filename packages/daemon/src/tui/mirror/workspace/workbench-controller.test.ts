import { describe, expect, it } from "vitest";
import {
  workbenchCanvasPanelForShortcut,
  workbenchCanvasShortcutForPanel,
  resolveWorkbenchPasteTarget,
  workbenchDockTabForShortcut,
} from "./workbench-controller.ts";

describe("workbench root controller boundary", () => {
  it.each([
    ["f1", "home"],
    ["f2", "terminals"],
  ] as const)("maps %s to the canonical %s canvas", (name, panel) => {
    expect(workbenchCanvasPanelForShortcut({ name })).toBe(panel);
  });

  it("keeps modified and dock keys out of the canvas shortcut map", () => {
    expect(workbenchCanvasPanelForShortcut({ name: "f1", shift: true })).toBeNull();
    expect(workbenchCanvasPanelForShortcut({ name: "f2", ctrl: true })).toBeNull();
    expect(workbenchCanvasPanelForShortcut({ name: "f3" })).toBeNull();
  });

  it("projects canonical top-shell labels independently of configured view order", () => {
    expect(workbenchCanvasShortcutForPanel("home")).toEqual({ key: "f1", label: "F1" });
    expect(workbenchCanvasShortcutForPanel("terminals")).toEqual({ key: "f2", label: "F2" });
  });

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
