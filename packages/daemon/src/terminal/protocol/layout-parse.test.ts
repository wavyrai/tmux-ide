import { describe, expect, it } from "vitest";
import {
  parseLayout,
  parseLayoutChange,
  parseWindowPaneChanged,
  parseSessionWindowChanged,
  parseMouseSubscription,
} from "./layout-parse.ts";

// Every layout string below was captured from a live tmux 3.7b server
// (zz-m235: a left pane + a right column split in two; resize/zoom/storm).

const THREE_PANE = "468e,120x40,0,0{60x40,0,0,443,59x40,61,0[59x20,61,0,444,59x19,61,21,445]}";
const ZOOMED = "6a6f,100x30,0,0,445";
const SINGLE = "6e38,282x90,0,0,446";
const STORM_STEP = "0bd6,90x28,0,0{45x28,0,0,443,44x28,46,0[44x14,46,0,444,44x13,46,15,445]}";

describe("parseLayout", () => {
  it("parses a nested horizontal+vertical split (real capture)", () => {
    const p = parseLayout(THREE_PANE)!;
    expect(p.width).toBe(120);
    expect(p.height).toBe(40);
    expect(p.leaves).toEqual([
      { id: "%443", left: 0, top: 0, width: 60, height: 40 },
      { id: "%444", left: 61, top: 0, width: 59, height: 20 },
      { id: "%445", left: 61, top: 21, width: 59, height: 19 },
    ]);
  });

  it("parses the zoomed visible layout — a single collapsed leaf", () => {
    const p = parseLayout(ZOOMED)!;
    expect(p.width).toBe(100);
    expect(p.height).toBe(30);
    expect(p.leaves).toEqual([{ id: "%445", left: 0, top: 0, width: 100, height: 30 }]);
  });

  it("parses a single-pane window", () => {
    const p = parseLayout(SINGLE)!;
    expect(p.width).toBe(282);
    expect(p.height).toBe(90);
    expect(p.leaves).toEqual([{ id: "%446", left: 0, top: 0, width: 282, height: 90 }]);
  });

  it("parses a resize-storm step (same shape, new sizes)", () => {
    const p = parseLayout(STORM_STEP)!;
    expect(p.width).toBe(90);
    expect(p.height).toBe(28);
    expect(p.leaves.map((l) => l.id)).toEqual(["%443", "%444", "%445"]);
    expect(p.leaves[2]).toEqual({ id: "%445", left: 46, top: 15, width: 44, height: 13 });
  });

  it("parses a vertical-only split", () => {
    // Hand-derived from the grammar: two stacked panes in an 80x24 window.
    const p = parseLayout("abcd,80x24,0,0[80x12,0,0,1,80x11,0,13,2]")!;
    expect(p.leaves).toEqual([
      { id: "%1", left: 0, top: 0, width: 80, height: 12 },
      { id: "%2", left: 0, top: 13, width: 80, height: 11 },
    ]);
  });

  it("rejects malformed input instead of throwing", () => {
    expect(parseLayout("")).toBeNull();
    expect(parseLayout("no-checksum,80x24,0,0,1")).toBeNull();
    expect(parseLayout("abcd,80x24,0,0")).toBeNull(); // no leaf id, no children
    expect(parseLayout("abcd,80x24,0,0{80x24,0,0,1")).toBeNull(); // unclosed brace
    expect(parseLayout("abcd,80x24,0,0,1trailing")).toBeNull(); // junk after root
    expect(parseLayout("abcd,80xx24,0,0,1")).toBeNull();
  });
});

describe("parseLayoutChange", () => {
  it("parses the real notification body incl. the zoom flag", () => {
    const ev = parseLayoutChange(`@387 ${THREE_PANE} ${ZOOMED} *Z`)!;
    expect(ev.windowId).toBe("@387");
    expect(ev.layout).toBe(THREE_PANE);
    expect(ev.visible).toBe(ZOOMED);
    expect(ev.zoomed).toBe(true);
  });
  it("unzoomed flags carry no Z", () => {
    expect(parseLayoutChange(`@387 ${THREE_PANE} ${THREE_PANE} *`)!.zoomed).toBe(false);
    expect(parseLayoutChange(`@387 ${THREE_PANE} ${THREE_PANE} -`)!.zoomed).toBe(false);
  });
  it("rejects off shapes", () => {
    expect(parseLayoutChange("")).toBeNull();
    expect(parseLayoutChange("%443 x y")).toBeNull();
    expect(parseLayoutChange("@387 onlylayout")).toBeNull();
  });
});

describe("parseWindowPaneChanged", () => {
  it("parses the real body", () => {
    expect(parseWindowPaneChanged("@387 %443")).toEqual({ windowId: "@387", paneId: "%443" });
  });
  it("rejects off shapes", () => {
    expect(parseWindowPaneChanged("@387")).toBeNull();
    expect(parseWindowPaneChanged("%443 @387")).toBeNull();
  });
});

describe("parseSessionWindowChanged", () => {
  it("parses the real body", () => {
    expect(parseSessionWindowChanged("$353 @388")).toEqual({ windowId: "@388" });
  });
  it("rejects off shapes", () => {
    expect(parseSessionWindowChanged("$353")).toBeNull();
  });
});

describe("parseMouseSubscription", () => {
  it("parses the real subscription line (on and off)", () => {
    expect(parseMouseSubscription("mouse $353 @387 0 %445 : 1")).toEqual({
      paneId: "%445",
      on: true,
    });
    expect(parseMouseSubscription("mouse $353 @387 0 %443 : 0")).toEqual({
      paneId: "%443",
      on: false,
    });
  });
  it("ignores other subscription names and off shapes", () => {
    expect(parseMouseSubscription("other $353 @387 0 %445 : 1")).toBeNull();
    expect(parseMouseSubscription("mouse $353 @387 0")).toBeNull();
  });
});
