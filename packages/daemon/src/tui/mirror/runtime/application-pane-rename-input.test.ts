import { describe, expect, it } from "vitest";

import {
  APPLICATION_PANE_NAME_MAX_LENGTH,
  applicationPaneRenameKeyAction,
  applicationPaneRenamePaste,
} from "./application-pane-rename-input.ts";

describe("application pane rename input", () => {
  const key = (name: string, shift = false) => ({ name, shift, ctrl: false, meta: false });

  it("edits, submits, and cancels without leaking keys to the terminal", () => {
    expect(applicationPaneRenameKeyAction(key("x"), "Pane")).toEqual({
      kind: "update",
      value: "Panex",
    });
    expect(applicationPaneRenameKeyAction(key("backspace"), "Pane")).toEqual({
      kind: "update",
      value: "Pan",
    });
    expect(
      applicationPaneRenameKeyAction({ name: "u", shift: false, ctrl: true, meta: false }, "Pane"),
    ).toEqual({ kind: "update", value: "" });
    expect(applicationPaneRenameKeyAction(key("enter"), "Pane")).toEqual({ kind: "submit" });
    expect(applicationPaneRenameKeyAction(key("escape"), "Pane")).toEqual({ kind: "cancel" });
  });

  it("sanitizes paste and enforces the pane-name bound", () => {
    const result = applicationPaneRenamePaste(
      "x".repeat(APPLICATION_PANE_NAME_MAX_LENGTH - 2),
      Buffer.from("ab\nignored"),
    );
    expect(result).toBe(`${"x".repeat(APPLICATION_PANE_NAME_MAX_LENGTH - 2)}ab`);
    expect(result).toHaveLength(APPLICATION_PANE_NAME_MAX_LENGTH);
  });
});
