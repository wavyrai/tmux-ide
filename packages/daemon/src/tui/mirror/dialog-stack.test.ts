import { describe, expect, it, vi } from "vitest";
import { createDialogStack, dialogKey, type DialogKeyEvent } from "./dialog-stack.ts";
import type { DialogSelectItem, DialogSelectResult } from "./dialog-model.ts";

const key = (name: string, over: Partial<DialogKeyEvent> = {}): DialogKeyEvent => ({
  name,
  ctrl: false,
  meta: false,
  shift: false,
  ...over,
});

const items: DialogSelectItem[] = [
  { id: "a", label: "Alpha" },
  { id: "b", label: "Beta", current: true },
  { id: "c", label: "Gamma" },
];

describe("stack mechanics", () => {
  it("push stacks, pop resolves the one-shot promise, notifying subscribers", async () => {
    const stack = createDialogStack();
    const seen: number[] = [];
    stack.subscribe(() => seen.push(stack.depth()));
    const p = stack.push({ kind: "prompt", title: "Name" });
    expect(stack.depth()).toBe(1);
    stack.pop("thijs");
    await expect(p).resolves.toBe("thijs");
    expect(stack.depth()).toBe(0);
    expect(seen).toEqual([1, 0]);
  });

  it("nests: a push while open renders on top; escape pops ONE level", async () => {
    const stack = createDialogStack();
    const below = stack.push({ kind: "select", title: "Below", items });
    const above = stack.push({ kind: "confirm", title: "Sure?" });
    expect(stack.depth()).toBe(2);
    expect(stack.top()!.spec.title).toBe("Sure?");
    dialogKey(stack, key("escape"));
    await expect(above).resolves.toBe(false); // confirm cancels to false
    expect(stack.depth()).toBe(1);
    expect(stack.top()!.spec.title).toBe("Below");
    dialogKey(stack, key("escape"));
    await expect(below).resolves.toBeNull(); // select cancels to null
  });

  it("replace swaps the top in place, cancelling the old promise", async () => {
    const stack = createDialogStack();
    const old = stack.push({ kind: "prompt", title: "Old" });
    const next = stack.replace({ kind: "prompt", title: "New" });
    await expect(old).resolves.toBeNull();
    expect(stack.depth()).toBe(1);
    expect(stack.top()!.spec.title).toBe("New");
    stack.pop("v");
    await expect(next).resolves.toBe("v");
  });

  it("clear cancels the whole stack", async () => {
    const stack = createDialogStack();
    const a = stack.push({ kind: "select", title: "A", items });
    const b = stack.push({ kind: "confirm", title: "B" });
    stack.clear();
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBe(false);
    expect(stack.depth()).toBe(0);
  });
});

describe("select behavior", () => {
  it("opens on the current item and enter resolves it", async () => {
    const stack = createDialogStack();
    const p = stack.push({ kind: "select", title: "Pick", items });
    expect(stack.top()!.state.sel).toBe(1); // the ● row
    dialogKey(stack, key("return"));
    const r = (await p) as DialogSelectResult;
    expect(r.item.id).toBe("b");
  });

  it("fires onMove on every selection change (keyboard AND mouse), never on open", () => {
    const onMove = vi.fn();
    const stack = createDialogStack();
    void stack.push({ kind: "select", title: "Pick", items, onMove });
    expect(onMove).not.toHaveBeenCalled();
    dialogKey(stack, key("down")); // 1 → 2
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: "c" }));
    stack.setSel(0); // the router's motion path
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
    stack.setSel(0); // same index — no re-fire
    expect(onMove).toHaveBeenCalledTimes(2);
  });

  it("typing filters (resetting sel/top), backspace restores", async () => {
    const stack = createDialogStack();
    const p = stack.push({ kind: "select", title: "Pick", items });
    dialogKey(stack, key("g"));
    expect(stack.top()!.state.query).toBe("g");
    expect(stack.filtered().map((i) => i.id)).toEqual(["c"]); // Gamma
    expect(stack.top()!.state.sel).toBe(0);
    dialogKey(stack, key("return"));
    const r = (await p) as DialogSelectResult;
    expect(r.item.id).toBe("c");
  });

  it("filterable: false ignores typing (read-only viewers)", () => {
    const stack = createDialogStack();
    void stack.push({ kind: "select", title: "Keys", items, filterable: false });
    dialogKey(stack, key("g"));
    expect(stack.top()!.state.query).toBe("");
  });

  it("a danger row arms to press-again-to-confirm; a second enter resolves; moving disarms", async () => {
    const danger: DialogSelectItem[] = [
      { id: "keep", label: "Keep" },
      { id: "reset", label: "Reset", danger: true },
    ];
    const stack = createDialogStack();
    const p = stack.push({ kind: "select", title: "Pick", items: danger });
    stack.setSel(1);
    dialogKey(stack, key("return"));
    expect(stack.depth()).toBe(1); // armed, not resolved
    expect(stack.top()!.state.armed).toBe(1);
    dialogKey(stack, key("up")); // moving disarms
    expect(stack.top()!.state.armed).toBeNull();
    stack.setSel(1);
    dialogKey(stack, key("return"));
    dialogKey(stack, key("return"));
    const r = (await p) as DialogSelectResult;
    expect(r.item.id).toBe("reset");
  });

  it("a click activate on a danger row arms exactly like enter", () => {
    const stack = createDialogStack();
    void stack.push({
      kind: "select",
      title: "Pick",
      items: [{ id: "x", label: "X", danger: true }],
    });
    stack.activate(0);
    expect(stack.depth()).toBe(1);
    expect(stack.top()!.state.armed).toBe(0);
  });

  it("per-row ctrl actions resolve with the action key", async () => {
    const stack = createDialogStack();
    const p = stack.push({
      kind: "select",
      title: "Pick",
      items,
      actions: [{ key: "d", label: "delete" }],
    });
    dialogKey(stack, key("d", { ctrl: true }));
    const r = (await p) as DialogSelectResult;
    expect(r).toEqual({ item: expect.objectContaining({ id: "b" }), action: "d" });
  });

  it("keyboard selection follows past the window (top moves), wheel scrolls top alone", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` }));
    const stack = createDialogStack();
    void stack.push({ kind: "select", title: "Pick", items: many });
    for (let i = 0; i < 12; i++) dialogKey(stack, key("down"));
    expect(stack.top()!.state.sel).toBe(12);
    expect(stack.top()!.state.top).toBe(3); // followed to keep row visible
    stack.scrollBy(10);
    expect(stack.top()!.state.top).toBe(5); // clamped to count - pageRows
    expect(stack.top()!.state.sel).toBe(12); // wheel does not move the selection
  });
});

describe("prompt behavior", () => {
  it("validates on enter: error shows (stays open), a valid value resolves", async () => {
    const stack = createDialogStack();
    const p = stack.push({
      kind: "prompt",
      title: "Time",
      validate: (v) => (v === "ok" ? null : "not ok"),
    });
    dialogKey(stack, key("x"));
    dialogKey(stack, key("return"));
    expect(stack.top()!.state.error).toBe("not ok");
    expect(stack.depth()).toBe(1);
    dialogKey(stack, key("backspace"));
    expect(stack.top()!.state.error).toBeNull(); // editing clears the error
    dialogKey(stack, key("o"));
    dialogKey(stack, key("k"));
    dialogKey(stack, key("return"));
    await expect(p).resolves.toBe("ok");
  });

  it("initial pre-fills; shift uppercases; busy ignores edits", () => {
    const stack = createDialogStack();
    void stack.push({ kind: "prompt", title: "T", initial: "ab" });
    dialogKey(stack, key("c", { shift: true }));
    expect(stack.top()!.state.input).toBe("abC");
    stack.setBusy(true);
    dialogKey(stack, key("d"));
    expect(stack.top()!.state.input).toBe("abC");
  });
});

describe("confirm behavior", () => {
  it("arrows/enter and the y/n shortcuts; defaultNo starts on the safe row", async () => {
    const stack = createDialogStack();
    const p1 = stack.push({ kind: "confirm", title: "A", defaultNo: true });
    expect(stack.top()!.state.sel).toBe(1);
    dialogKey(stack, key("up"));
    dialogKey(stack, key("return"));
    await expect(p1).resolves.toBe(true);
    const p2 = stack.push({ kind: "confirm", title: "B" });
    dialogKey(stack, key("n"));
    await expect(p2).resolves.toBe(false);
    const p3 = stack.push({ kind: "confirm", title: "C" });
    stack.choose(0); // the router's click path
    await expect(p3).resolves.toBe(true);
  });
});
