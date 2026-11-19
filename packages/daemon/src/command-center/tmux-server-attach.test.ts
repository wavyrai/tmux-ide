import { describe, expect, it } from "vitest";
import cases from "./attach-window-rule.cases.json" with { type: "json" };
import { chooseAttachSelection } from "./tmux-server-attach.ts";

// The app runs the same table against its own rule
// (apps/tmux-gpui …/browser_native_local_window_tests.rs), so the two agree.
describe("the attach window rule", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const inventory = {
      semanticPaneIds: c.windows.flatMap((w) => w.panes).sort(),
      windows: c.windows.map((w) => ({
        semanticWindowId: w.id,
        active: w.active,
        semanticPaneIds: w.panes,
      })),
    };
    const selection = chooseAttachSelection(inventory, c.preferred, c.maxPanes);
    expect(
      selection && {
        window: selection.semanticWindowId,
        panes: selection.panes,
        selected: selection.selectedPane,
      },
    ).toEqual(c.expect);
  });
});
