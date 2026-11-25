import type { MirrorPaneHold } from "./events.ts";

/**
 * A pane's open refused because its recoveries failed in a row (#869, #872):
 * not a try that failed. It carries the time until tmux is asked again and
 * why the last try failed, so the stream can close with both.
 */
export class MirrorPaneHeldError extends Error {
  readonly hold: MirrorPaneHold;

  constructor(hold: MirrorPaneHold) {
    super("Native terminal recovery held after failed recoveries");
    this.name = "MirrorPaneHeldError";
    this.hold = hold;
  }
}
