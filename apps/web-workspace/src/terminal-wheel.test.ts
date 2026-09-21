import { expect, it, vi } from "vitest";
import { createTerminalWheelController, type TerminalWheelEvent } from "./terminal-wheel";
function setup() {
  const state = { inputEnabled: false, mouseTracking: true, cellHeight: 20, rows: 30 };
  const scroll = vi.fn();
  const controller = createTerminalWheelController(() => state, scroll);
  const event = (patch: Partial<TerminalWheelEvent> = {}): TerminalWheelEvent => ({
    deltaY: 10,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    timeStamp: 1,
    preventDefault: vi.fn(),
    ...patch,
  });
  return { state, scroll, ...controller, event };
}
it("accumulates pixels into rows once per event without acceleration", () => {
  const t = setup();
  const a = t.event();
  const b = t.event({ timeStamp: 2 });
  expect(t.handle(a)).toBe(false);
  expect(t.scroll).not.toHaveBeenCalled();
  t.handle(a);
  t.handle(b);
  expect(t.scroll.mock.calls).toEqual([[1]]);
  expect(a.preventDefault).toHaveBeenCalledOnce();
});
it("normalizes line and page deltas and drops remainder on reversal or gesture gap", () => {
  const t = setup();
  t.handle(t.event());
  t.handle(t.event({ deltaY: -10, timeStamp: 2 }));
  expect(t.scroll).not.toHaveBeenCalled();
  t.handle(t.event({ deltaMode: 1, deltaY: -2, timeStamp: 3 }));
  t.handle(t.event({ deltaMode: 2, deltaY: 1, timeStamp: 4 }));
  t.handle(t.event({ deltaY: 10, timeStamp: 200 }));
  expect(t.scroll.mock.calls).toEqual([[-2], [30]]);
});
it("routes ordinary app wheel only with input while Shift remains local", () => {
  const t = setup();
  t.state.inputEnabled = true;
  const app = t.event();
  expect(t.handle(app)).toBe(true);
  expect(app.preventDefault).not.toHaveBeenCalled();
  t.handle(t.event({ shiftKey: true, deltaY: 40 }));
  expect(t.scroll).toHaveBeenCalledWith(2);
  t.state.inputEnabled = false;
  t.handle(t.event({ deltaY: 40 }));
  expect(t.scroll).toHaveBeenCalledTimes(2);
});
it("leaves ordinary shell scrolling to xterm and does not consume browser zoom", () => {
  const t = setup();
  t.state.mouseTracking = false;
  expect(t.handle(t.event())).toBe(true);
  const zoom = t.event({ ctrlKey: true });
  expect(t.handle(zoom)).toBe(false);
  expect(zoom.preventDefault).not.toHaveBeenCalled();
  expect(t.scroll).not.toHaveBeenCalled();
});
it("ignores invalid geometry and deltas", () => {
  const t = setup();
  const bad = t.event({ deltaY: NaN });
  t.handle(bad);
  expect(bad.preventDefault).not.toHaveBeenCalled();
  t.state.cellHeight = 0;
  t.handle(t.event());
  expect(t.scroll).not.toHaveBeenCalled();
});
