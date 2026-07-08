import { describe, expect, it } from "vitest";
import {
  DIALOG_W,
  DIALOG_ROWS,
  DIALOG_CONFIRM_SUFFIX,
  clampDialogTop,
  confirmFooter,
  confirmOptions,
  dialogContains,
  dialogHeaderRows,
  dialogHeight,
  dialogInnerW,
  dialogMarker,
  dialogPos,
  dialogRowAt,
  dialogRowText,
  filterDialogItems,
  followTop,
  initialSelIndex,
  promptFooter,
  selectFooter,
  wrapText,
  type DialogGeom,
  type DialogSelectSpec,
} from "./dialog-model.ts";

const items = [
  { id: "a", label: "Sky blue" },
  { id: "b", label: "Soft green", current: true },
  { id: "c", label: "Coral" },
];

const select = (over: Partial<DialogSelectSpec> = {}): DialogSelectSpec => ({
  kind: "select",
  title: "Pick",
  items,
  ...over,
});

describe("dialogPos", () => {
  it("centers horizontally and sits at a sixth of the height, min 1", () => {
    expect(dialogPos(100, 60, DIALOG_W)).toEqual({ left: 20, top: 10 });
    expect(dialogPos(40, 4, DIALOG_W)).toEqual({ left: 0, top: 1 });
  });
});

describe("dialogHeaderRows", () => {
  it("select: border + title + filter + rule; 3 when not filterable", () => {
    expect(dialogHeaderRows(select())).toBe(4);
    expect(dialogHeaderRows(select({ filterable: false }))).toBe(3);
  });
  it("prompt: border + title + rule", () => {
    expect(dialogHeaderRows({ kind: "prompt", title: "T" })).toBe(3);
  });
  it("confirm: 3 plus one row per wrapped body line", () => {
    expect(dialogHeaderRows({ kind: "confirm", title: "T" })).toBe(3);
    expect(dialogHeaderRows({ kind: "confirm", title: "T", body: "short" })).toBe(4);
    const long = "word ".repeat(30).trim();
    expect(dialogHeaderRows({ kind: "confirm", title: "T", body: long })).toBe(
      3 + wrapText(long, dialogInnerW(DIALOG_W)).length,
    );
  });
});

describe("row hit-testing (the router law: same math as the render)", () => {
  const g: DialogGeom = {
    left: 20,
    top: 10,
    width: 60,
    headerRows: 4,
    visibleRows: 3,
    footerRows: 1,
  };
  it("hits only real rows inside the interior", () => {
    expect(dialogRowAt(g, 25, 14)).toBe(0);
    expect(dialogRowAt(g, 25, 16)).toBe(2);
    expect(dialogRowAt(g, 25, 17)).toBe(-1); // footer, not a row
    expect(dialogRowAt(g, 25, 13)).toBe(-1); // rule row
    expect(dialogRowAt(g, 20, 14)).toBe(-1); // left border
    expect(dialogRowAt(g, 79, 14)).toBe(-1); // right border
  });
  it("containment covers the whole box incl. borders, nothing more", () => {
    expect(dialogHeight(g)).toBe(4 + 3 + 1 + 1);
    expect(dialogContains(g, 20, 10)).toBe(true);
    expect(dialogContains(g, 79, 18)).toBe(true);
    expect(dialogContains(g, 19, 10)).toBe(false);
    expect(dialogContains(g, 20, 19)).toBe(false);
  });
  it("an empty list still reserves one placeholder row in the height", () => {
    expect(dialogHeight({ ...g, visibleRows: 0 })).toBe(4 + 1 + 1 + 1);
    expect(dialogRowAt({ ...g, visibleRows: 0 }, 25, 14)).toBe(-1);
  });
});

describe("filtering / selection", () => {
  it("empty query returns all items in order; fuzzy narrows", () => {
    expect(filterDialogItems("", items).map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(filterDialogItems("cor", items).map((i) => i.id)).toEqual(["c"]);
    expect(filterDialogItems("zzz", items)).toEqual([]);
  });
  it("initial selection lands on the current item, or initialSel, else 0", () => {
    expect(initialSelIndex(select())).toBe(1);
    expect(initialSelIndex(select({ initialSel: 2 }))).toBe(2);
    expect(initialSelIndex(select({ items: [items[0]!, items[2]!] }))).toBe(0);
    expect(initialSelIndex(select({ initialSel: 99 }))).toBe(1); // invalid → current
  });
  it("followTop keeps the selection visible with minimal movement", () => {
    expect(followTop(0, 0, DIALOG_ROWS)).toBe(0);
    expect(followTop(DIALOG_ROWS, 0, DIALOG_ROWS)).toBe(1);
    expect(followTop(3, 5, DIALOG_ROWS)).toBe(3);
    expect(followTop(7, 5, DIALOG_ROWS)).toBe(5);
  });
  it("clampDialogTop mirrors the palette clamp", () => {
    expect(clampDialogTop(5, 20, 10)).toBe(5);
    expect(clampDialogTop(15, 20, 10)).toBe(10);
    expect(clampDialogTop(-2, 20, 10)).toBe(0);
    expect(clampDialogTop(3, 5, 10)).toBe(0);
  });
});

describe("row text", () => {
  it("marks the current value with ● regardless of selection", () => {
    expect(dialogMarker({ current: true }, false)).toBe("● ");
    expect(dialogMarker({ current: true }, true)).toBe("● ");
    expect(dialogMarker({}, true)).toBe("› ");
    expect(dialogMarker({}, false)).toBe("  ");
  });
  it("right-aligns the detail inside the interior width", () => {
    const text = dialogRowText(
      { id: "x", label: "Coral", detail: "colour203" },
      { selected: true, armed: false, innerW: 30 },
    );
    expect(text.length).toBe(30);
    expect(text.startsWith("› Coral")).toBe(true);
    expect(text.endsWith("colour203")).toBe(true);
  });
  it("an armed destructive row swaps the detail for the plain re-ask", () => {
    const text = dialogRowText(
      { id: "r", label: "Reset", danger: true, detail: "everything" },
      { selected: true, armed: true, innerW: 56 },
    );
    expect(text).toContain(`Reset${DIALOG_CONFIRM_SUFFIX}`);
    expect(text).not.toContain("everything");
  });
  it("truncates overlong labels before the detail", () => {
    const text = dialogRowText(
      { id: "x", label: "L".repeat(50), detail: "on" },
      { selected: false, armed: false, innerW: 20 },
    );
    expect(text.length).toBe(20);
    expect(text.endsWith("on")).toBe(true);
  });
});

describe("footers", () => {
  it("select footer lists keys, ctrl-actions, then the plain-language hint", () => {
    expect(
      selectFooter(select({ actions: [{ key: "d", label: "delete" }], footerHint: "note" })),
    ).toBe("enter select · esc cancel · ^d delete · note");
    expect(selectFooter(select())).toBe("enter select · esc cancel");
  });
  it("prompt footer: busy > error > hint > default", () => {
    const spec = { kind: "prompt", title: "T", footerHint: "hint" } as const;
    expect(promptFooter(spec, { error: "bad", busy: true })).toEqual({
      text: "saving…",
      error: false,
    });
    expect(promptFooter(spec, { error: "bad", busy: false })).toEqual({
      text: "bad",
      error: true,
    });
    expect(promptFooter(spec, { error: null, busy: false })).toEqual({
      text: "hint",
      error: false,
    });
    expect(promptFooter({ kind: "prompt", title: "T" }, { error: null, busy: false }).text).toBe(
      "enter save · esc cancel",
    );
  });
  it("confirm options default Yes/No and the footer names y/n", () => {
    expect(confirmOptions({ kind: "confirm", title: "T" })).toEqual(["Yes", "No"]);
    expect(
      confirmOptions({ kind: "confirm", title: "T", yesLabel: "Reset", noLabel: "Keep" }),
    ).toEqual(["Reset", "Keep"]);
    expect(confirmFooter()).toContain("y/n");
  });
});

describe("wrapText", () => {
  it("wraps on words, hard-breaks overlong words, keeps paragraphs", () => {
    expect(wrapText("a b c", 10)).toEqual(["a b c"]);
    expect(wrapText("aaaa bbbb cccc", 9)).toEqual(["aaaa bbbb", "cccc"]);
    expect(wrapText("x".repeat(12), 5)).toEqual(["xxxxx", "xxxxx", "xx"]);
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"]);
    expect(wrapText("", 10)).toEqual([""]);
  });
});
