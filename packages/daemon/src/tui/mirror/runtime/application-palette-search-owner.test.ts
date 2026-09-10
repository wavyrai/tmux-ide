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
      owner.handleKey(key("q"));
      expect(owner.commands()).toHaveLength(0);
      owner.handleKey(key("enter"));
      expect(activate).toHaveBeenCalledTimes(1);
      owner.handleKey(key("escape"));
      expect(close).toHaveBeenCalledTimes(1);
      setOpen(false);
      expect(owner.handleKey(key("q"))).toBe(false);
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
      owner.select(9);
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

it("keeps route identities distinct and supports explicit normal mode without eating search letters", () =>
  createRoot((dispose) => {
    const commands: ApplicationPaletteCommand[] = [
      "home",
      ...Array.from({ length: 12 }, (_, i) => ({
        kind: "open-session" as const,
        sessionName: "same",
        label: `session-${i}`,
        fleet: {
          machineId: `host-${i}`,
          hostLabel: `Host ${i}`,
          liveSessionId: "live-session.12345678901234567890",
          daemonInstanceId: "instance",
        },
      })),
    ];
    expect(new Set(commands.map((c) => applicationCommandDescription(c).id)).size).toBe(13);
    const owner = createApplicationPaletteSearchOwner({
      commands: () => commands,
      open: () => true,
      activate: () => {},
      close: () => {},
      onChange: () => {},
    });
    owner.reset(0);
    owner.handleKey({ ...key("space"), ctrl: true });
    owner.handleKey(key("j"));
    expect(owner.selection()).toBe(1);
    expect(owner.query()).toBe("");
    owner.handleKey({ ...key("d"), ctrl: true });
    expect(owner.selection()).toBe(6);
    owner.handleKey({ ...key("g"), shift: true });
    expect(owner.selection()).toBe(12);
    owner.handleKey(key("i"));
    owner.handleKey(key("j"));
    expect(owner.query()).toBe("j");
    dispose();
  }));

it("uses the rendered viewport for page and half-page movement", () =>
  createRoot((dispose) => {
    const owner = createApplicationPaletteSearchOwner({
      commands: () =>
        applicationPaletteCommands(
          null,
          Array.from({ length: 40 }, (_, i) => `session-${i}`),
        ),
      open: () => true,
      activate: vi.fn(),
      close: vi.fn(),
      onChange: vi.fn(),
    });
    owner.setViewport(16);
    owner.handleKey(key("pagedown"));
    expect(owner.selection()).toBe(16);
    owner.handleKey({ ...key("space"), ctrl: true });
    owner.handleKey({ ...key("u"), ctrl: true });
    expect(owner.selection()).toBe(8);
    dispose();
  }));
it("ranks fuzzy matches while keeping equal matches deterministic", () => {
  const commands: ApplicationPaletteCommand[] = [
    { kind: "open-session", sessionName: "backend-service", label: "backend-service" },
    { kind: "open-session", sessionName: "build", label: "build" },
  ];
  expect(filterApplicationCommands(commands, "bksvc")).toEqual([commands[0]]);
  expect(filterApplicationCommands(commands, "")).toEqual(commands);
});

it("keeps fixed commands stable before favorite and recent fleet entries when unfiltered", () => {
  const favorite: ApplicationPaletteCommand = {
    kind: "open-session",
    sessionName: "favorite",
    label: "favorite",
    fleet: {
      machineId: "mini",
      hostLabel: "Mini",
      daemonInstanceId: "instance",
      liveSessionId: "session",
      favorite: true,
      recentRank: 0,
    },
  };
  expect(filterApplicationCommands(["home", "terminals", "close-pane", favorite], "")).toEqual([
    "home",
    "terminals",
    "close-pane",
    favorite,
  ]);
});
