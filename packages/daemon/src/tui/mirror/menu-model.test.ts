import { describe, expect, it } from "vitest";
import {
  MENU_ITEMS,
  menuDims,
  clampMenuPos,
  menuItemAt,
  pointInMenu,
  type MenuGeom,
} from "./menu-model.ts";

describe("MENU_ITEMS", () => {
  it("names one fixed list per region", () => {
    expect(MENU_ITEMS.session.map((i) => i.id)).toEqual(["attach", "rename", "kill"]);
    expect(MENU_ITEMS.file.map((i) => i.id)).toEqual(["open", "newfile", "rename", "delete"]);
    expect(MENU_ITEMS.difffile.map((i) => i.id)).toEqual(["open", "copypath"]);
    expect(MENU_ITEMS.pane.map((i) => i.id)).toEqual(["split-h", "split-v", "zoom", "kill"]);
    expect(MENU_ITEMS.window.map((i) => i.id)).toEqual(["new", "rename", "kill"]);
  });

  it("marks destructive items danger and text-entry items input", () => {
    expect(MENU_ITEMS.session.find((i) => i.id === "kill")?.danger).toBe(true);
    expect(MENU_ITEMS.pane.find((i) => i.id === "kill")?.danger).toBe(true);
    expect(MENU_ITEMS.file.find((i) => i.id === "delete")?.danger).toBe(true);
    expect(MENU_ITEMS.window.find((i) => i.id === "kill")?.danger).toBe(true);
    expect(MENU_ITEMS.session.find((i) => i.id === "rename")?.input).toBe("rename to");
    expect(MENU_ITEMS.file.find((i) => i.id === "newfile")?.input).toBe("new file");
    expect(MENU_ITEMS.window.find((i) => i.id === "rename")?.input).toBe("rename to");
  });
});

describe("menuDims", () => {
  it("heights to top border + header + items + bottom border", () => {
    expect(menuDims("s", MENU_ITEMS.difffile).height).toBe(2 + 3); // 2 items
    expect(menuDims("s", MENU_ITEMS.pane).height).toBe(4 + 3); // 4 items
  });

  it("widths to fit the longest non-danger row (label + 2 for the prefix)", () => {
    const items = [{ id: "a", label: "abcdefghijklmnopqrst" }]; // 20 chars, no danger
    expect(menuDims("t", items).width).toBe(20 + 2 + 2 + 2); // +2 prefix, +2 pad, +2 border
  });

  it("reserves width so a danger item's confirm suffix is never clipped", () => {
    // "Kill pane" (9) + "  confirm: y" (12) = 21 inner > "Split horizontal" 18.
    expect(menuDims("p", MENU_ITEMS.pane).width).toBe(21 + 2 + 2);
  });

  it("grows to fit a long title", () => {
    const long = "a-very-long-session-name-indeed";
    expect(menuDims(long, MENU_ITEMS.session).width).toBe(long.length + 2 + 2);
  });

  it("never falls below the minimum inner width", () => {
    expect(menuDims("x", [{ id: "a", label: "hi" }]).width).toBe(16 + 2 + 2);
  });
});

describe("clampMenuPos", () => {
  it("keeps the pointer position when the box fits", () => {
    expect(clampMenuPos(10, 5, 20, 7, 100, 40)).toEqual({ left: 10, top: 5 });
  });

  it("pulls the box left/up so it stays fully on-screen", () => {
    // width 20 at x=95 on a 100-wide grid → left = 80.
    expect(clampMenuPos(95, 38, 20, 7, 100, 40)).toEqual({ left: 80, top: 33 });
  });

  it("never goes negative on a tiny screen", () => {
    expect(clampMenuPos(2, 1, 30, 12, 10, 6)).toEqual({ left: 0, top: 0 });
  });
});

describe("menuItemAt", () => {
  const m: MenuGeom = { left: 10, top: 5, width: 20, itemCount: 3, height: 6 };

  it("maps rows below the top border + header to items", () => {
    // border at y=5, header at y=6, item 0 at y=7.
    expect(menuItemAt(m, 12, 7)).toBe(0);
    expect(menuItemAt(m, 12, 8)).toBe(1);
    expect(menuItemAt(m, 12, 9)).toBe(2);
  });

  it("returns -1 on the border, the header, and past the last item", () => {
    expect(menuItemAt(m, 12, 5)).toBe(-1); // top border
    expect(menuItemAt(m, 12, 6)).toBe(-1); // header
    expect(menuItemAt(m, 12, 10)).toBe(-1); // below last item (bottom border)
  });

  it("returns -1 outside the horizontal span", () => {
    expect(menuItemAt(m, 9, 7)).toBe(-1);
    expect(menuItemAt(m, 30, 7)).toBe(-1); // left+width is exclusive
    expect(menuItemAt(m, 29, 7)).toBe(0);
  });
});

describe("pointInMenu", () => {
  const m: MenuGeom = { left: 10, top: 5, width: 20, itemCount: 3, height: 6 };

  it("is true anywhere inside the box, including border and header", () => {
    expect(pointInMenu(m, 10, 5)).toBe(true); // top-left corner
    expect(pointInMenu(m, 29, 10)).toBe(true); // bottom-right cell
    expect(pointInMenu(m, 12, 6)).toBe(true); // header row
  });

  it("is false past either edge (exclusive far bounds)", () => {
    expect(pointInMenu(m, 9, 7)).toBe(false);
    expect(pointInMenu(m, 30, 7)).toBe(false);
    expect(pointInMenu(m, 12, 4)).toBe(false);
    expect(pointInMenu(m, 12, 11)).toBe(false);
  });
});
