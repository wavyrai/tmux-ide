import { shellChromeLayout } from "../shell-chrome.ts";
import {
  projectOpenTuiPaneFrames,
  type OpenTuiTerminalLayout,
} from "./terminal-layout-projection.ts";

/** Exact global framebuffer projection shared by the renderer and ProductRig proof. */
export function projectCanonicalFocusPaneRect(input: {
  readonly hostCols: number;
  readonly hostRows: number;
  readonly canonicalLayout: OpenTuiTerminalLayout;
  readonly canonicalPaneId: string;
}): {
  readonly left: number;
  readonly chromeRow: number;
  readonly firstBodyRow: number;
  readonly width: number;
  readonly bodyRows: number;
  readonly contentHeight: number;
  readonly sidebarWidth: number;
} | null {
  const { hostCols, hostRows, canonicalLayout, canonicalPaneId } = input;
  if (
    ![hostCols, hostRows].every((value) => Number.isSafeInteger(value) && value > 0) ||
    typeof canonicalPaneId !== "string" ||
    canonicalPaneId.length < 1 ||
    !canonicalLayout ||
    !Number.isSafeInteger(canonicalLayout.cols) ||
    canonicalLayout.cols < 1 ||
    !Number.isSafeInteger(canonicalLayout.rows) ||
    canonicalLayout.rows < 2 ||
    !Array.isArray(canonicalLayout.panes) ||
    canonicalLayout.currentWindow !== true
  ) {
    return null;
  }
  const matchingPanes = canonicalLayout.panes.filter(({ pane }) => pane === canonicalPaneId);
  if (matchingPanes.length !== 1) return null;
  const canonicalPane = matchingPanes[0];
  if (!canonicalPane) return null;
  if (
    canonicalPane.active !== true ||
    canonicalLayout.panes.filter(({ active }) => active).length !== 1 ||
    canonicalPane.left < 0 ||
    canonicalPane.top < 0 ||
    canonicalPane.width < 1 ||
    canonicalPane.height < 2 ||
    canonicalPane.left + canonicalPane.width > canonicalLayout.cols ||
    canonicalPane.top + canonicalPane.height > canonicalLayout.rows
  ) {
    return null;
  }
  const shell = shellChromeLayout(hostCols, hostRows, 28);
  const contentHeight = Math.max(0, shell.main.height - shell.status.height);
  const terminalHeight = Math.max(2, contentHeight - 1);
  const frame = projectOpenTuiPaneFrames(canonicalLayout, {
    width: shell.main.width,
    height: terminalHeight,
  }).find(({ paneId }) => paneId === canonicalPaneId);
  if (!frame) return null;
  const workspaceTopOffset = 1;
  return Object.freeze({
    left: shell.main.x + frame.left,
    chromeRow: shell.main.y + workspaceTopOffset + frame.top,
    firstBodyRow: shell.main.y + workspaceTopOffset + frame.top + 1,
    width: frame.width,
    bodyRows: frame.contentHeight,
    contentHeight: frame.contentHeight,
    sidebarWidth: shell.sidebar.width,
  });
}
