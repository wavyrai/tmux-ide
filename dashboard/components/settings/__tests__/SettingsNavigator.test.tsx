import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsNavigator } from "../SettingsNavigator";

describe("SettingsNavigator", () => {
  it("renders all six section buttons", () => {
    render(<SettingsNavigator active="general" onChange={() => {}} />);
    for (const id of ["general", "appearance", "keybinds", "terminal", "sounds", "about"]) {
      expect(screen.getByTestId(`settings-nav-${id}`)).toBeTruthy();
    }
  });

  it("marks the active section with data-active=true", () => {
    render(<SettingsNavigator active="appearance" onChange={() => {}} />);
    expect(
      screen.getByTestId("settings-nav-appearance").getAttribute("data-active"),
    ).toBe("true");
    expect(screen.getByTestId("settings-nav-general").getAttribute("data-active")).toBe(
      "false",
    );
  });

  it("fires onChange with the picked section id", () => {
    const handler = vi.fn();
    render(<SettingsNavigator active="general" onChange={handler} />);
    fireEvent.click(screen.getByTestId("settings-nav-keybinds"));
    expect(handler).toHaveBeenCalledWith("keybinds");
  });
});
