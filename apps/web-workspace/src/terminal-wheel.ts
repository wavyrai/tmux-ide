export interface TerminalWheelState {
  inputEnabled: boolean;
  mouseTracking: boolean;
  cellHeight: number;
  rows: number;
}
export type TerminalWheelEvent = Pick<
  WheelEvent,
  "deltaY" | "deltaMode" | "shiftKey" | "ctrlKey" | "timeStamp" | "preventDefault"
>;

/** False bypasses xterm's app-input handler. Install in capture as well when
 * overriding its inner native viewport; stop propagation there on false, but
 * never prevent browser zoom. The same event is safe to inspect twice. */
export function createTerminalWheelController(
  state: () => TerminalWheelState,
  scrollLines: (lines: number) => void,
) {
  let remainder = 0;
  let direction = 0;
  let lastAt = -Infinity;
  const handled = new WeakMap<object, boolean>();
  const reset = () => {
    remainder = 0;
    direction = 0;
    lastAt = -Infinity;
  };
  const handle = (event: TerminalWheelEvent): boolean => {
    const previous = handled.get(event);
    if (previous !== undefined) return previous;
    if (event.ctrlKey) {
      reset();
      handled.set(event, false);
      return false;
    }
    const current = state();
    // xterm's own viewport normalizes browser pixels and supplies its smooth
    // scrolling. Mouse-aware applications retain ordinary wheel input only
    // while this client owns input; Shift always selects local history.
    if (!event.shiftKey && (!current.mouseTracking || current.inputEnabled)) {
      reset();
      handled.set(event, true);
      return true;
    }
    handled.set(event, false);
    if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return false;
    const height = current.cellHeight;
    if (!Number.isFinite(height) || height <= 0) return false;
    const scale =
      event.deltaMode === 0
        ? 1 / height
        : event.deltaMode === 1
          ? 1
          : event.deltaMode === 2
            ? current.rows
            : 0;
    if (!Number.isFinite(scale) || scale <= 0) return false;
    const sign = Math.sign(event.deltaY);
    if (sign !== direction || event.timeStamp - lastAt > 160 || event.timeStamp < lastAt)
      remainder = 0;
    direction = sign;
    lastAt = event.timeStamp;
    remainder += event.deltaY * scale;
    const lines = Math.trunc(remainder);
    remainder -= lines;
    event.preventDefault();
    if (lines) scrollLines(lines);
    return false;
  };
  return { handle, reset };
}
