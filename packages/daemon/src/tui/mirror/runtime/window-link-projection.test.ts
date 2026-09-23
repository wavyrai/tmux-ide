import { describe, expect, it } from "vitest";
import type { OpenTuiWorkspaceLayoutSnapshot } from "../open-tui-workspace-runtime-port.ts";
import { windowLinkForPane, windowLinkTarget } from "./application-terminal-workspace-policy.ts";

const first = `window-link.${"a".repeat(32)}`;
const second = `window-link.${"b".repeat(32)}`;
const other = `window-link.${"c".repeat(32)}`;
function snapshot(activeLinkId = first): OpenTuiWorkspaceLayoutSnapshot {
  const current = {
    type: "layout" as const,
    semanticWindowId: "window.main",
    currentWindow: true,
    cols: 80,
    rows: 24,
    zoomed: false,
    paneBorderStatus: "off" as const,
    panes: [{ pane: "pane.main", left: 0, top: 0, width: 80, height: 24, active: true }],
  };
  return {
    current,
    windows: [current],
    windowLinks: {
      liveSessionId: `live-session.${"a".repeat(20)}`,
      linkRevision: 7,
      activeLinkId,
      links: [
        { linkId: first, semanticWindowId: "window.main", displayIndex: 2 },
        { linkId: second, semanticWindowId: "window.main", displayIndex: 9 },
        { linkId: other, semanticWindowId: "window.other", displayIndex: 10 },
      ],
    },
  };
}
describe("window link projection", () => {
  it("selects the active link for a pane shared by repeated links", () => {
    expect(windowLinkForPane(snapshot(second), "pane.main")).toEqual({
      liveSessionId: `live-session.${"a".repeat(20)}`,
      linkRevision: 7,
      linkId: second,
      expectedSemanticWindowId: "window.main",
    });
    expect(windowLinkTarget(snapshot(), first)).not.toHaveProperty("displayIndex");
  });
  it("does not guess a nonactive ambiguous backing or revive a stale handle", () => {
    expect(windowLinkForPane(snapshot(other), "pane.main")).toBeNull();
    expect(windowLinkTarget(snapshot(), "window-link.retired")).toBeNull();
    expect(windowLinkForPane({ ...snapshot(), windowLinks: null }, "pane.main")).toBeNull();
  });
});
