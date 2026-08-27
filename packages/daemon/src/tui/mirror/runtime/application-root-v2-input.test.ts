import { describe, expect, it } from "vitest";

import {
  applicationPaletteCommands,
  applicationPaletteKeyboardDisposition,
  applicationPaletteOwnsInput,
} from "./application-palette-input.ts";
import { projectOpenTuiApplicationShell } from "../workspace/application-shell-controller.ts";

describe("application-root-v2 palette input ownership", () => {
  it("blocks unhandled keys and paste while the palette owns input", () => {
    expect(applicationPaletteKeyboardDisposition({ name: "a" }, true, 0)).toEqual({
      kind: "block",
    });
    expect(applicationPaletteKeyboardDisposition({ name: "enter" }, true, 1)).toEqual({
      kind: "activate",
      command: "terminals",
    });
    expect(applicationPaletteKeyboardDisposition({ name: "a" }, false, 0)).toBeNull();
    expect(applicationPaletteOwnsInput(true)).toBe(true);
    expect(applicationPaletteOwnsInput(false)).toBe(false);
  });

  it("turns the semantic sidebar agent into a keyboard jump command", () => {
    const semantic = projectOpenTuiApplicationShell({
      projectName: "tmux-ide",
      rootLabel: "/workspace/tmux-ide",
      workspaceName: "workspace-main",
      activeMode: "terminals",
      dockMode: "collapsed",
      activeDockTool: "missions",
      focusZone: "terminal",
      focusedPaneId: "pane.agent",
      terminalInputPaneId: "pane.agent",
      paletteOpen: true,
      sessions: [{ name: "session-main", status: "working" }],
      activeSession: "session-main",
      agents: [{ paneId: "%7", name: "Codex", kind: "codex", status: "working" }],
      paneIdentities: [{ runtimePaneId: "%7", semanticPaneId: "pane.agent" }],
      notification: "ready",
    });
    const commands = applicationPaletteCommands(semantic);

    expect(commands.at(-1)).toEqual({
      kind: "jump-agent",
      sessionName: "session-main",
      paneId: "pane.agent",
      label: "Codex",
    });
    expect(
      applicationPaletteKeyboardDisposition({ name: "enter" }, true, commands.length - 1, commands),
    ).toEqual({ kind: "activate", command: commands.at(-1) });
  });
});
