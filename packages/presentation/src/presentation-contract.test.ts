import { describe, expect, it } from "vitest";
import { resolvePaneAppearance } from "@tmux-ide/contracts";

import { resolveEffectivePaneFrameActionState } from "./pane-frame/action-state.ts";
import { workbenchDockNavigationTarget } from "./workbench-dock/navigation.ts";

const appearance = resolvePaneAppearance({
  structure: "docked",
  applicationFocus: { pane: true, terminalInput: true, windowActive: true },
  agentActivity: "running",
  domainStatus: "running",
  attention: "none",
  layoutInteraction: {
    editable: true,
    selected: false,
    dragging: false,
    resizing: false,
    previewing: false,
  },
  controlInteraction: {
    hover: false,
    focusVisible: false,
    pressed: false,
    disabled: false,
    loading: false,
  },
});

describe("renderer-neutral presentation policy", () => {
  it("shares exact action precedence without importing a host renderer", () => {
    expect(
      resolveEffectivePaneFrameActionState({
        appearance,
        action: {
          id: "pane.close",
          label: "Close",
          icon: "close",
          commandId: "workspace.pane.kill",
          behavior: "action",
          available: true,
          disabledReason: null,
          busy: false,
          pressed: false,
          attention: true,
        },
        attention: false,
        hostHovered: true,
        hostPressed: true,
      }).state,
    ).toBe("pressed");
  });

  it("skips disabled dock tabs identically for DOM and OpenTUI key names", () => {
    const tabs = [
      { id: "files" as const, disabled: false },
      { id: "changes" as const, disabled: true },
      { id: "missions" as const, disabled: false },
      { id: "activity" as const, disabled: false },
    ];
    expect(workbenchDockNavigationTarget(tabs, "files", { name: "ArrowRight" })).toBe("missions");
    expect(workbenchDockNavigationTarget(tabs, "files", { name: "l" })).toBe("missions");
  });
});
