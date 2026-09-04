import { describe, expect, it } from "vitest";

import {
  applicationPaletteCommands,
  applicationPaletteKeyAction,
} from "./application-palette-input.ts";

describe("live-session palette commands", () => {
  it("preserves base commands when catalog routes are not provided", () => {
    expect(applicationPaletteCommands(null)).toEqual([
      "home",
      "terminals",
      "new-window",
      "split-right",
      "split-down",
      "close-pane",
    ]);
  });

  it("makes every exact catalog route reachable without a connected semantic shell", () => {
    const commands = applicationPaletteCommands(null, ["alpha", "beta workspace", "alpha"]);
    expect(commands.slice(6)).toEqual([
      { kind: "open-session", label: "alpha", sessionName: "alpha" },
      { kind: "open-session", label: "beta workspace", sessionName: "beta workspace" },
    ]);
    expect(applicationPaletteKeyAction({ name: "enter" }, true, 7, commands)).toEqual({
      kind: "activate",
      command: { kind: "open-session", label: "beta workspace", sessionName: "beta workspace" },
    });
  });
});
