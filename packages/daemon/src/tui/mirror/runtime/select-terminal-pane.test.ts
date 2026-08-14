import { describe, expect, it, vi } from "vitest";

import { selectTerminalPane, type LivePaneSelectionTarget } from "./select-terminal-pane.ts";

function target(requestAuthority: () => Promise<unknown | null>): LivePaneSelectionTarget {
  return {
    status: "live",
    workspaceName: "workspace.alpha",
    client: {
      requestAuthority: vi.fn(requestAuthority),
      dispatch: vi.fn(async () => ({})),
    },
  };
}

describe("selectTerminalPane", () => {
  it("waits for input authority before dispatching selection", async () => {
    let grant!: (lease: unknown) => void;
    const active = target(() => new Promise((resolve) => (grant = resolve)));
    const selecting = selectTerminalPane(active, () => active, "pane.editor");
    expect(active.client.dispatch).not.toHaveBeenCalled();
    grant({ token: "lease" });
    expect(await selecting).toBe(true);
    expect(active.client.dispatch).toHaveBeenCalledWith({
      kind: "semantic-intent",
      intent: {
        verb: "workspace.pane.select",
        workspaceName: "workspace.alpha",
        semanticPaneId: "pane.editor",
      },
    });
    const fresh = target(async () => ({ token: "lease" }));
    expect(await selectTerminalPane(fresh, () => ({ ...fresh }), "pane.editor")).toBe(true);
  });

  it("does not dispatch after denial or a late generation replacement", async () => {
    const denied = target(async () => null);
    expect(await selectTerminalPane(denied, () => denied, "pane.editor")).toBe(false);
    expect(denied.client.dispatch).not.toHaveBeenCalled();

    let grant!: (lease: unknown) => void;
    const retired = target(() => new Promise((resolve) => (grant = resolve)));
    const replacement = target(async () => ({ token: "new" }));
    let current = retired;
    const selecting = selectTerminalPane(retired, () => current, "pane.editor");
    current = replacement;
    grant({ token: "old" });
    expect(await selecting).toBe(false);
    expect(retired.client.dispatch).not.toHaveBeenCalled();
  });
});
