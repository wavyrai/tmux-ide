import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { __resetSettingsForTests, getSettingsSnapshot } from "@/lib/useSettings";
import SettingsPage from "@/app/v2/settings/page";

beforeEach(() => {
  __resetSettingsForTests();
  try {
    window.localStorage.removeItem("tmux-ide.settings.active-tab");
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  cleanup();
});

describe("SettingsPage — chrome", () => {
  it("renders the five-tab nav", () => {
    render(<SettingsPage />);
    expect(screen.getByTestId("settings-tab-theme")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-terminal")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-sounds")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-general")).toBeTruthy();
    expect(screen.getByTestId("settings-tab-keybinds")).toBeTruthy();
  });

  it("starts on the Theme tab by default", () => {
    render(<SettingsPage />);
    expect(screen.getByTestId("settings-tab-theme").getAttribute("data-active")).toBe("true");
    expect(screen.getByTestId("settings-theme-grid")).toBeTruthy();
  });

  it("persists active tab in localStorage", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-tab-terminal"));
    expect(window.localStorage.getItem("tmux-ide.settings.active-tab")).toBe("terminal");
  });

  it("restores the persisted tab on remount", () => {
    window.localStorage.setItem("tmux-ide.settings.active-tab", "keybinds");
    render(<SettingsPage />);
    expect(screen.getByTestId("settings-tab-keybinds").getAttribute("data-active")).toBe("true");
  });

  it("falls back to Theme when the persisted tab id is unknown", () => {
    window.localStorage.setItem("tmux-ide.settings.active-tab", "bogus-tab");
    render(<SettingsPage />);
    expect(screen.getByTestId("settings-tab-theme").getAttribute("data-active")).toBe("true");
  });
});

describe("SettingsPage — Theme panel", () => {
  it("clicking a theme tile updates the settings store", () => {
    render(<SettingsPage />);
    expect(getSettingsSnapshot().themeId).toBe("dark");
    fireEvent.click(screen.getByTestId("settings-theme-dracula"));
    expect(getSettingsSnapshot().themeId).toBe("dracula");
    expect(screen.getByTestId("settings-theme-dracula").getAttribute("data-active")).toBe("true");
  });

  it("each theme tile marks itself active when selected", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-theme-tokyonight"));
    const activeTiles = screen
      .getAllByTestId(/settings-theme-/)
      .filter((tile) => tile.getAttribute("data-active") === "true");
    expect(activeTiles).toHaveLength(1);
    expect(activeTiles[0]!.dataset.testid).toBe("settings-theme-tokyonight");
  });
});

describe("SettingsPage — Terminal panel", () => {
  beforeEach(() => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-tab-terminal"));
  });

  it("font-size input writes through to the store", () => {
    fireEvent.change(screen.getByTestId("settings-terminal-font-size"), {
      target: { value: "14" },
    });
    expect(getSettingsSnapshot().terminal.fontSize).toBe(14);
  });

  it("renderer selector writes through to the store", () => {
    fireEvent.change(screen.getByTestId("settings-terminal-renderer"), {
      target: { value: "webgl" },
    });
    expect(getSettingsSnapshot().terminal.renderer).toBe("webgl");
  });

  it("cursor-blink toggle flips the store value", () => {
    expect(getSettingsSnapshot().terminal.cursorBlink).toBe(true);
    fireEvent.click(screen.getByTestId("settings-terminal-cursor-blink"));
    expect(getSettingsSnapshot().terminal.cursorBlink).toBe(false);
  });
});

describe("SettingsPage — Keybinds panel", () => {
  beforeEach(() => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-tab-keybinds"));
  });

  it("setting an override stores it under the action id", () => {
    fireEvent.change(screen.getByTestId("settings-keybind-input-openCommandPalette"), {
      target: { value: "⌘P" },
    });
    expect(getSettingsSnapshot().keybinds.openCommandPalette).toBe("⌘P");
  });

  it("Reset clears the override for that action", () => {
    fireEvent.change(screen.getByTestId("settings-keybind-input-openCommandPalette"), {
      target: { value: "⌘P" },
    });
    fireEvent.click(screen.getByTestId("settings-keybind-reset-openCommandPalette"));
    expect(getSettingsSnapshot().keybinds.openCommandPalette).toBeUndefined();
  });

  it("Reset all clears every override", () => {
    fireEvent.change(screen.getByTestId("settings-keybind-input-toggleLeftSidebar"), {
      target: { value: "⌘[" },
    });
    fireEvent.change(screen.getByTestId("settings-keybind-input-toggleBottomPanel"), {
      target: { value: "⌘]" },
    });
    fireEvent.click(screen.getByTestId("settings-keybinds-reset-all"));
    expect(Object.keys(getSettingsSnapshot().keybinds)).toHaveLength(0);
  });
});

describe("SettingsPage — Sounds + General panels", () => {
  it("sound toggle writes through to the store", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-tab-sounds"));
    expect(getSettingsSnapshot().sounds.onTaskComplete).toBe(false);
    fireEvent.click(screen.getByTestId("settings-sound-task-complete"));
    expect(getSettingsSnapshot().sounds.onTaskComplete).toBe(true);
  });

  it("default project tab dropdown writes through to the store", () => {
    render(<SettingsPage />);
    fireEvent.click(screen.getByTestId("settings-tab-general"));
    fireEvent.change(screen.getByTestId("settings-general-default-project-tab"), {
      target: { value: "mission" },
    });
    expect(getSettingsSnapshot().general.defaultProjectTab).toBe("mission");
  });
});
