import { describe, expect, it } from "vitest";

import { initialWindowSizeCommands } from "./window-size-policy.ts";

describe("initial visual-client window size", () => {
  it("claims the measured canvas before the first state snapshot", () => {
    expect(initialWindowSizeCommands({ target: "work", cols: 180, rows: 61 })).toEqual([
      "refresh-client -C 180x61",
      "set-window-option -t 'work' window-size manual",
      "resize-window -t 'work' -x 180 -y 61",
    ]);
  });

  it("never emits an invalid zero-sized tmux window", () => {
    expect(initialWindowSizeCommands({ target: "work", cols: 0, rows: -4 })).toEqual([
      "refresh-client -C 1x1",
      "set-window-option -t 'work' window-size manual",
      "resize-window -t 'work' -x 1 -y 1",
    ]);
  });

  it("keeps an odd session name one tmux command argument", () => {
    expect(initialWindowSizeCommands({ target: "Thijs's work; next", cols: 80, rows: 24 })).toEqual(
      [
        "refresh-client -C 80x24",
        "set-window-option -t 'Thijs'\\''s work; next' window-size manual",
        "resize-window -t 'Thijs'\\''s work; next' -x 80 -y 24",
      ],
    );
  });
});
