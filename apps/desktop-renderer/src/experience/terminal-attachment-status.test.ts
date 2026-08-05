import { describe, expect, it } from "vitest";

import {
  NO_ATTACHMENT_SAFE_STATE,
  statusStripWithAttachment,
} from "./terminal-attachment-status.ts";

const CONNECTED = {
  state: "connected",
  message: "Live tmux session discovered",
  safeState: NO_ATTACHMENT_SAFE_STATE,
  nextAction: "Choose a terminal pane",
} as const;

describe("the status strip's attachment line", () => {
  it("says nothing is attached while nothing is", () => {
    expect(statusStripWithAttachment(CONNECTED, false)).toEqual(CONNECTED);
  });

  it("stops claiming nothing is attached once a terminal is connected", () => {
    /*
     * The bug, verbatim from a screenshot: a connected terminal filling the
     * window, and under it the app insisting no attachment is open. The line is
     * the daemon's, and the daemon cannot see a renderer-side lease — so the
     * renderer is the only place the sentence can be made true.
     */
    expect(statusStripWithAttachment(CONNECTED, true)).toMatchObject({
      safeState: "A desktop terminal attachment is open",
      nextAction: "Type in the focused pane",
    });
  });

  it("leaves every other status alone, attached or not", () => {
    const degraded = {
      state: "recovering",
      message: "The tmux session has no discoverable panes",
      safeState: "No terminal attachment was attempted",
      nextAction: "Wait for tmux pane discovery to recover",
    } as const;
    expect(statusStripWithAttachment(degraded, true)).toEqual(degraded);
  });

  it("keeps a reworded guidance line rather than overwriting it", () => {
    // Only the pair this override is about is replaced; anything the daemon has
    // since made more specific survives.
    expect(
      statusStripWithAttachment({ ...CONNECTED, nextAction: "Reconnect the workspace" }, true)
        .nextAction,
    ).toBe("Reconnect the workspace");
  });

  it("stops firing if the daemon rewords its own line", () => {
    // The safe direction to fail: show the daemon's sentence rather than
    // silently overriding a line this no longer understands.
    const reworded = { ...CONNECTED, safeState: "Nothing attached" };
    expect(statusStripWithAttachment(reworded, true)).toEqual(reworded);
  });
});
