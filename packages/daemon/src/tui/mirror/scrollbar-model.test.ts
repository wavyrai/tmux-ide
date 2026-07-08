import { describe, expect, it } from "vitest";
import { scrollThumb, trackZone, pageTop, dragTop } from "./scrollbar-model.ts";

describe("scrollThumb", () => {
  it("hides the track when content fits the viewport", () => {
    expect(scrollThumb(0, 10, 20).overflow).toBe(false);
    expect(scrollThumb(0, 20, 20).overflow).toBe(false); // exactly full
  });

  it("sizes the thumb as a viewport-fraction of the track", () => {
    // 100 lines, 20-row view → thumb ≈ 20*20/100 = 4 rows.
    const t = scrollThumb(0, 100, 20);
    expect(t.overflow).toBe(true);
    expect(t.size).toBe(4);
    expect(t.start).toBe(0); // top of buffer
  });

  it("pins the thumb to the track bottom at max scroll", () => {
    // maxTop = 100 - 20 = 80; thumb size 4 → maxStart = 16.
    const t = scrollThumb(80, 100, 20);
    expect(t.start).toBe(16);
    expect(t.start + t.size).toBe(20); // flush with the track end
  });

  it("places the thumb proportionally mid-scroll", () => {
    // viewportTop 40 of maxTop 80 → halfway → start = round(0.5 * 16) = 8.
    expect(scrollThumb(40, 100, 20).start).toBe(8);
  });

  it("floors the thumb at one row for very long content", () => {
    expect(scrollThumb(0, 100000, 10).size).toBe(1);
  });

  it("clamps an out-of-range viewportTop", () => {
    expect(scrollThumb(9999, 100, 20).start).toBe(16);
    expect(scrollThumb(-5, 100, 20).start).toBe(0);
  });
});

describe("trackZone", () => {
  const thumb = scrollThumb(40, 100, 20); // start 8, size 4 → thumb rows [8,12)

  it("classifies rows above / on / below the thumb", () => {
    expect(trackZone(0, thumb)).toBe("above");
    expect(trackZone(7, thumb)).toBe("above");
    expect(trackZone(8, thumb)).toBe("thumb");
    expect(trackZone(11, thumb)).toBe("thumb");
    expect(trackZone(12, thumb)).toBe("below");
    expect(trackZone(19, thumb)).toBe("below");
  });
});

describe("pageTop", () => {
  it("pages up one viewport for a click above the thumb", () => {
    expect(pageTop(0, 40, 100, 20)).toBe(20); // 40 - 20
  });

  it("pages down one viewport for a click below the thumb", () => {
    expect(pageTop(19, 40, 100, 20)).toBe(60); // 40 + 20
  });

  it("clamps paging at the buffer ends", () => {
    expect(pageTop(0, 10, 100, 20)).toBe(0); // would be -10
    expect(pageTop(19, 75, 100, 20)).toBe(80); // would be 95, maxTop 80
  });

  it("leaves the top unchanged for a click on the thumb", () => {
    expect(pageTop(9, 40, 100, 20)).toBe(40);
  });

  it("no-ops when content fits", () => {
    expect(pageTop(0, 0, 10, 20)).toBe(0);
  });
});

describe("dragTop", () => {
  it("maps the thumb top to scroll top 0", () => {
    expect(dragTop(0, 0, 100, 20)).toBe(0);
  });

  it("maps the thumb bottom (maxStart) to max scroll", () => {
    // maxStart = 16, grabOffset 0, drag to row 16 → maxTop 80.
    expect(dragTop(16, 0, 100, 20)).toBe(80);
  });

  it("honors the grab offset so the thumb doesn't jump", () => {
    // Grabbed 2 rows into the thumb; pointer at row 10 → thumbStart 8 → mid.
    expect(dragTop(10, 2, 100, 20)).toBe(40);
  });

  it("clamps a drag past the track ends", () => {
    expect(dragTop(999, 0, 100, 20)).toBe(80);
    expect(dragTop(-5, 0, 100, 20)).toBe(0);
  });

  it("returns 0 when content fits", () => {
    expect(dragTop(5, 0, 10, 20)).toBe(0);
  });
});
