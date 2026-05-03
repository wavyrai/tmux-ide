import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelStack, type PanelStackEntry } from "../PanelStack";
import { PANEL_MIN_WIDTH } from "@/lib/panel-constants";

/**
 * Mocks Element.getBoundingClientRect to return the given width per element.
 * jsdom/happy-dom don't lay out flex, so the Sash needs deterministic widths
 * to compute proportions during the drag math.
 */
function mockBoundingRects(getWidth: (el: Element) => number) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: getWidth(this),
      bottom: 0,
      width: getWidth(this),
      height: 0,
      toJSON() {
        return {};
      },
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

describe("PanelStack", () => {
  afterEach(() => {
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
  });

  it("renders a single panel at full width with no sash", () => {
    const panels: PanelStackEntry[] = [
      {
        id: "only",
        proportion: 1,
        content: <div data-testid="only-content">only</div>,
      },
    ];

    render(<PanelStack panels={panels} testId="stack" />);

    expect(screen.getByTestId("only-content")).toBeTruthy();
    const slots = document.querySelectorAll('[data-slot="panel-stack-slot"]');
    expect(slots).toHaveLength(1);
    const slot = slots[0] as HTMLElement;
    expect(slot.style.flexGrow).toBe("1");
    expect(slot.style.minWidth).toBe("0");

    // No sashes rendered for single panel
    expect(
      document.querySelectorAll('[data-slot="panel-resize-sash"]'),
    ).toHaveLength(0);
  });

  it("renders two panels with a sash between them", () => {
    const panels: PanelStackEntry[] = [
      {
        id: "left",
        proportion: 0.3,
        content: <div data-testid="left-content">left</div>,
      },
      {
        id: "right",
        proportion: 0.7,
        content: <div data-testid="right-content">right</div>,
      },
    ];

    render(<PanelStack panels={panels} testId="stack" />);

    const slots = document.querySelectorAll('[data-slot="panel-stack-slot"]');
    expect(slots).toHaveLength(2);
    expect((slots[0] as HTMLElement).style.flexGrow).toBe("0.3");
    expect((slots[1] as HTMLElement).style.flexGrow).toBe("0.7");
    expect((slots[0] as HTMLElement).style.minWidth).toBe(
      `${PANEL_MIN_WIDTH}px`,
    );

    const sashes = document.querySelectorAll(
      '[data-slot="panel-resize-sash"]',
    );
    expect(sashes).toHaveLength(1);
  });

  it("renders three panels with two sashes between them", () => {
    const panels: PanelStackEntry[] = [
      { id: "a", proportion: 0.25, content: <div>a</div> },
      { id: "b", proportion: 0.5, content: <div>b</div> },
      { id: "c", proportion: 0.25, content: <div>c</div> },
    ];

    render(<PanelStack panels={panels} />);

    const sashes = document.querySelectorAll(
      '[data-slot="panel-resize-sash"]',
    );
    expect(sashes).toHaveLength(2);
  });

  it("fires onResize with new proportions while dragging the sash", () => {
    const onResize = vi.fn();

    // Each panel: 600px wide. Combined width: 1200px. Combined proportion: 1.
    // After dragging the sash 120px to the right:
    //   newLeftWidth = 720, newRightWidth = 480
    //   leftProportion = (720 / 1200) * 1 = 0.6
    //   rightProportion = 0.4
    const restore = mockBoundingRects(() => 600);

    const panels: PanelStackEntry[] = [
      { id: "left", proportion: 0.5, content: <div>left</div> },
      { id: "right", proportion: 0.5, content: <div>right</div> },
    ];

    render(<PanelStack panels={panels} onResize={onResize} />);

    const sash = document.querySelector(
      '[data-slot="panel-resize-sash"]',
    ) as HTMLElement;
    expect(sash).toBeTruthy();

    fireEvent.mouseDown(sash, { clientX: 600 });
    fireEvent.mouseMove(document, { clientX: 720 });

    expect(onResize).toHaveBeenCalled();
    const last = onResize.mock.calls.at(-1)![0];
    expect(last.leftIndex).toBe(0);
    expect(last.rightIndex).toBe(1);
    expect(last.leftProportion).toBeCloseTo(0.6, 5);
    expect(last.rightProportion).toBeCloseTo(0.4, 5);
    // Combined proportion preserved
    expect(last.leftProportion + last.rightProportion).toBeCloseTo(1, 5);

    fireEvent.mouseUp(document);
    restore();
  });

  it("clamps to PANEL_MIN_WIDTH during drag", () => {
    const onResize = vi.fn();

    // Each panel: 500px wide. PANEL_MIN_WIDTH is 360.
    // Drag 200px to the right would push the right panel to 300px (< min).
    // Algorithm clamps right to 360, sets left to combined(1000) - 360 = 640.
    // Proportions: 640/1000 = 0.64, 0.36.
    const restore = mockBoundingRects(() => 500);

    const panels: PanelStackEntry[] = [
      { id: "left", proportion: 0.5, content: <div>left</div> },
      { id: "right", proportion: 0.5, content: <div>right</div> },
    ];

    render(<PanelStack panels={panels} onResize={onResize} />);

    const sash = document.querySelector(
      '[data-slot="panel-resize-sash"]',
    ) as HTMLElement;

    fireEvent.mouseDown(sash, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 700 });

    const last = onResize.mock.calls.at(-1)![0];
    expect(last.leftProportion).toBeCloseTo(0.64, 5);
    expect(last.rightProportion).toBeCloseTo(0.36, 5);

    fireEvent.mouseUp(document);
    restore();
  });

  it("equalizes adjacent proportions on double-click", () => {
    const onResize = vi.fn();

    const panels: PanelStackEntry[] = [
      { id: "left", proportion: 0.2, content: <div>left</div> },
      { id: "right", proportion: 0.6, content: <div>right</div> },
    ];

    render(<PanelStack panels={panels} onResize={onResize} />);

    const sash = document.querySelector(
      '[data-slot="panel-resize-sash"]',
    ) as HTMLElement;

    fireEvent.doubleClick(sash);

    expect(onResize).toHaveBeenCalledTimes(1);
    const update = onResize.mock.calls[0][0];
    // Combined was 0.8, halved is 0.4 each
    expect(update.leftProportion).toBeCloseTo(0.4, 5);
    expect(update.rightProportion).toBeCloseTo(0.4, 5);
  });

  it("renders empty container when panels is empty", () => {
    render(<PanelStack panels={[]} testId="stack" />);
    expect(screen.getByTestId("stack")).toBeTruthy();
    expect(
      document.querySelectorAll('[data-slot="panel-stack-slot"]'),
    ).toHaveLength(0);
  });

  // Guards: ensure we restore body styles after drag ends
  describe("body style cleanup", () => {
    beforeEach(() => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    });

    it("sets body cursor and userSelect during drag and clears on mouseup", () => {
      const restore = mockBoundingRects(() => 400);

      const panels: PanelStackEntry[] = [
        { id: "left", proportion: 0.5, content: <div>left</div> },
        { id: "right", proportion: 0.5, content: <div>right</div> },
      ];

      render(<PanelStack panels={panels} onResize={() => {}} />);

      const sash = document.querySelector(
        '[data-slot="panel-resize-sash"]',
      ) as HTMLElement;

      fireEvent.mouseDown(sash, { clientX: 400 });
      expect(document.body.style.userSelect).toBe("none");
      expect(document.body.style.cursor).toBe("col-resize");

      fireEvent.mouseUp(document);
      expect(document.body.style.userSelect).toBe("");
      expect(document.body.style.cursor).toBe("");

      restore();
    });
  });
});
