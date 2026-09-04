import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createApplicationPaletteSearchOwner } from "./application-palette-search-owner.ts";
import {
  applicationCommandDescription,
  filterApplicationCommands,
} from "../workspace/application-command-description.ts";
import {
  applicationPaletteCommands,
  type ApplicationPaletteCommand,
} from "./application-palette-input.ts";
import { PANE_ACTION_MENU_ITEMS } from "../workspace/pane-action-menu-model.ts";

const key = (name: string) => ({ name, ctrl: false, meta: false, shift: false });
describe("command discovery", () => {
  it("uses shared pane labels and collision-free session/agent identities", () => {
    for (const command of ["split-right", "split-down", "close-pane"] as const)
      expect(applicationCommandDescription(command).label).toBe(
        PANE_ACTION_MENU_ITEMS.find((item) => item.id === command)?.label,
      );
    const commands: ApplicationPaletteCommand[] = [
      { kind: "open-session", sessionName: "a", label: "a" },
      { kind: "open-session", sessionName: "b", label: "b" },
      { kind: "jump-agent", sessionName: "a", paneId: "%1", label: "Codex" },
      { kind: "jump-agent", sessionName: "b", paneId: "%1", label: "Codex" },
    ];
    expect(new Set(commands.map((command) => applicationCommandDescription(command).id)).size).toBe(
      4,
    );
    expect(filterApplicationCommands(commands, "CODEX b")).toEqual([commands[3]]);
  });
  it("owns typing, Unicode paste, zero results and Escape without activation or leakage", () =>
    createRoot((dispose) => {
      const activate = vi.fn();
      const close = vi.fn();
      const [open, setOpen] = createSignal(true);
      const owner = createApplicationPaletteSearchOwner({
        commands: () => applicationPaletteCommands(null, ["研究"]),
        open,
        activate,
        close,
        onChange: vi.fn(),
      });
      expect(owner.handlePaste(Buffer.from("研究"))).toBe(true);
      expect(owner.commands()).toHaveLength(1);
      owner.handleKey(key("enter"));
      expect(activate).toHaveBeenCalledTimes(1);
      owner.handleKey({ ...key("u"), ctrl: true });
      owner.handleKey(key("z"));
      expect(owner.commands()).toHaveLength(0);
      owner.handleKey(key("enter"));
      expect(activate).toHaveBeenCalledTimes(1);
      owner.handleKey(key("escape"));
      expect(close).toHaveBeenCalledTimes(1);
      setOpen(false);
      expect(owner.handleKey(key("z"))).toBe(false);
      expect(owner.handlePaste(Buffer.from("x"))).toBe(false);
      dispose();
    }));
  it("preserves exact selection during catalog reorder and blocks modified/repeated activation", () =>
    createRoot((dispose) => {
      const [sessions, setSessions] = createSignal(["alpha", "beta"]);
      const activate = vi.fn();
      const owner = createApplicationPaletteSearchOwner({
        commands: () => applicationPaletteCommands(null, sessions()),
        open: () => true,
        activate,
        close: vi.fn(),
        onChange: vi.fn(),
      });
      owner.select(7);
      setSessions(["new", "beta", "alpha"]);
      expect(owner.commands()[owner.selection()]).toMatchObject({ sessionName: "beta" });
      owner.handleKey({ ...key("enter"), repeated: true });
      owner.handleKey({ ...key("enter"), ctrl: true });
      owner.handleKey({ ...key("enter"), eventType: "release" });
      expect(activate).not.toHaveBeenCalled();
      owner.handleKey(key("enter"));
      expect(activate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionName: "beta" }),
        "keyboard",
      );
      setSessions([]);
      expect(owner.selection()).toBe(0);
      dispose();
    }));
});
