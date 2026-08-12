import { describe, expect, it, vi } from "vitest";

import type { DialogKeyEvent } from "../../dialog-stack.ts";
import { createDialogFeatureSession } from "./session.ts";

const key = (name: string, overrides: Partial<DialogKeyEvent> = {}): DialogKeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...overrides,
});

const host = (onOpenChange?: (open: boolean) => void) => ({
  viewport: () => ({ width: 100, height: 36, dialogWidth: 60 }),
  ...(onOpenChange ? { onOpenChange } : {}),
});

describe("per-application dialog feature session", () => {
  it("isolates stacks, reactive ownership, and notifications by application", async () => {
    const leftChanges: boolean[] = [];
    const rightChanges: boolean[] = [];
    const left = createDialogFeatureSession(host((open) => leftChanges.push(open)));
    const right = createDialogFeatureSession(host((open) => rightChanges.push(open)));

    const leftResult = left.prompt({ title: "Left" });
    expect(left.open()).toBe(true);
    expect(right.open()).toBe(false);
    expect(left.snapshot()).toMatchObject({ phase: "open", spec: { title: "Left" } });
    expect(right.snapshot()).toEqual({ phase: "closed" });

    expect(left.handleKey(key("l"))).toBe(true);
    expect(left.handleKey(key("return"))).toBe(true);
    await expect(leftResult).resolves.toBe("l");
    expect(leftChanges).toEqual([true, false]);
    expect(rightChanges).toEqual([]);

    left.dispose();
    right.dispose();
  });

  it("drives select, prompt, and confirm through the typed session API", async () => {
    const session = createDialogFeatureSession(host());
    const selected = session.select({
      title: "Pick",
      items: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta", current: true },
      ],
    });
    expect(session.snapshot()).toMatchObject({
      phase: "open",
      state: { sel: 1 },
      visibleItems: [{ id: "a" }, { id: "b" }],
    });
    session.handleKey(key("return"));
    await expect(selected).resolves.toMatchObject({ item: { id: "b" } });

    const prompted = session.prompt({
      title: "Name",
      validate: (value) => (value === "ok" ? null : "not ok"),
    });
    session.handleKey(key("x"));
    session.handleKey(key("return"));
    expect(session.snapshot()).toMatchObject({ phase: "open", state: { error: "not ok" } });
    session.handleKey(key("backspace"));
    session.handleKey(key("o"));
    session.handleKey(key("k"));
    session.handleKey(key("return"));
    await expect(prompted).resolves.toBe("ok");

    const confirmed = session.confirm({ title: "Delete?", defaultNo: true });
    expect(session.snapshot()).toMatchObject({ phase: "open", state: { sel: 1 } });
    session.handleKey(key("y"));
    await expect(confirmed).resolves.toBe(true);
    session.dispose();
  });

  it("uses the rendered geometry as the pointer authority", async () => {
    const session = createDialogFeatureSession(host());
    const result = session.select({
      title: "Pick",
      items: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
        { id: "c", label: "Gamma" },
      ],
    });
    const first = session.snapshot();
    expect(first.phase).toBe("open");
    if (first.phase !== "open") throw new Error("dialog did not open");
    const rowX = first.geometry.left + 2;
    const secondRowY = first.geometry.top + first.geometry.headerRows + 1;

    expect(session.handlePointer({ kind: "move", x: rowX, y: secondRowY })).toBe(true);
    expect(session.snapshot()).toMatchObject({ phase: "open", state: { sel: 1 } });
    expect(session.handlePointer({ kind: "down", x: rowX, y: secondRowY })).toBe(true);
    await expect(result).resolves.toMatchObject({ item: { id: "b" } });

    const cancelled = session.confirm({ title: "Outside?" });
    const confirm = session.snapshot();
    expect(confirm.phase).toBe("open");
    if (confirm.phase !== "open") throw new Error("confirm did not open");
    session.handlePointer({
      kind: "down",
      x: confirm.geometry.left + confirm.geometry.width + 2,
      y: confirm.geometry.top,
    });
    await expect(cancelled).resolves.toBe(false);
    expect(session.handlePointer({ kind: "down", x: 0, y: 0 })).toBe(false);
    session.dispose();
  });

  it("consumes every key and pointer while open, including inert input", async () => {
    const session = createDialogFeatureSession(host());
    const pending = session.confirm({ title: "Confirm" });
    expect(session.handleKey(key("f12"))).toBe(true);
    expect(session.handlePointer({ kind: "up", x: 0, y: 0 })).toBe(true);
    expect(session.handlePointer({ kind: "scroll", x: 0, y: 0, scrollDirection: "up" })).toBe(true);
    expect(session.handleKey(key("escape"))).toBe(true);
    await expect(pending).resolves.toBe(false);
    expect(session.handleKey(key("x"))).toBe(false);
    session.dispose();
  });

  it("cancels nested one-shots before retiring the owner and ignores every late input", async () => {
    const openChanges: boolean[] = [];
    const onMove = vi.fn();
    const session = createDialogFeatureSession(host((open) => openChanges.push(open)));
    const below = session.select({
      title: "Below",
      items: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      onMove,
    });
    const above = session.confirm({ title: "Above" });
    session.dispose();
    session.dispose();

    await expect(below).resolves.toBeNull();
    await expect(above).resolves.toBe(false);
    expect(openChanges).toEqual([true, false]);
    expect(session.disposed()).toBe(true);
    expect(session.open()).toBe(false);
    expect(session.snapshot()).toEqual({ phase: "closed" });
    expect(session.handleKey(key("down"))).toBe(false);
    expect(session.handlePointer({ kind: "move", x: 50, y: 10 })).toBe(false);
    expect(session.dismiss()).toBe(false);
    expect(session.setBusy(true)).toBe(false);
    expect(onMove).not.toHaveBeenCalled();

    await expect(session.select({ title: "Late", items: [] })).resolves.toBeNull();
    await expect(session.prompt({ title: "Late" })).resolves.toBeNull();
    await expect(session.confirm({ title: "Late" })).resolves.toBe(false);
  });

  it("keeps viewport geometry reactive without remounting or another stack", () => {
    let width = 100;
    const session = createDialogFeatureSession({
      viewport: () => ({ width, height: 30, dialogWidth: 60 }),
    });
    void session.prompt({ title: "Resize" });
    const before = session.snapshot();
    expect(before).toMatchObject({ phase: "open", geometry: { left: 20, width: 60 } });
    width = 50;
    const after = session.snapshot();
    expect(after).toMatchObject({ phase: "open", geometry: { left: 0, width: 50 } });
    session.dispose();
  });
});
