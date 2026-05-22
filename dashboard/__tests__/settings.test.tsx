/**
 * /settings — Solid parity tests.
 *
 * The Settings page is a thin view over the shared `settings` signal,
 * so the tests focus on: tabs switch the body, theme tiles flip the
 * signal, terminal inputs round-trip, and the keybind reset button
 * clears overrides.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router";

import SettingsRoute from "@/routes/settings";
import { __resetSettingsForTests, setKeybindOverride, settings } from "@/lib/settings";

function renderRoute() {
  const history = createMemoryHistory();
  history.set({ value: "/settings" });
  return render(() => (
    <MemoryRouter history={history}>
      <Route path="/settings" component={SettingsRoute} />
    </MemoryRouter>
  ));
}

beforeEach(() => {
  __resetSettingsForTests();
  // The active-tab pointer lives in its own localStorage key; tests
  // that switch tabs would otherwise leak the previous selection into
  // the next render. Same idea as `__resetSettingsForTests` for the
  // main store.
  try {
    window.localStorage.removeItem("tmux-ide.settings.active-tab");
  } catch {
    /* ignore */
  }
});
afterEach(() => cleanup());

describe("/settings", () => {
  it("renders the 5-tab layout with Theme as the default panel", () => {
    const { getByTestId } = renderRoute();
    expect(getByTestId("settings-page")).toBeInTheDocument();
    expect(getByTestId("settings-page-tabs")).toBeInTheDocument();
    expect(getByTestId("settings-theme-grid")).toBeInTheDocument();
    for (const id of ["theme", "terminal", "sounds", "general", "keybinds"]) {
      expect(getByTestId(`settings-tab-${id}`)).toBeInTheDocument();
    }
  });

  it("clicking the Terminal tab swaps to the terminal panel", () => {
    const { getByTestId, queryByTestId } = renderRoute();
    fireEvent.click(getByTestId("settings-tab-terminal"));
    expect(getByTestId("settings-terminal-font-size")).toBeInTheDocument();
    expect(queryByTestId("settings-theme-grid")).toBeNull();
  });

  it("selecting a theme tile updates the shared settings signal + dataset", () => {
    const { getByTestId } = renderRoute();
    fireEvent.click(getByTestId("settings-theme-dracula"));
    expect(settings().themeId).toBe("dracula");
    expect(document.documentElement.dataset.theme).toBe("dracula");
  });

  it("terminal font-size input writes through to the store", () => {
    const { getByTestId } = renderRoute();
    fireEvent.click(getByTestId("settings-tab-terminal"));
    const input = getByTestId("settings-terminal-font-size") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "16" } });
    expect(settings().terminal.fontSize).toBe(16);
  });

  it("keybinds reset clears an override on the shared store", () => {
    setKeybindOverride("toggleLeftSidebar", "⌘L");
    const { getByTestId } = renderRoute();
    fireEvent.click(getByTestId("settings-tab-keybinds"));
    expect(settings().keybinds["toggleLeftSidebar"]).toBe("⌘L");
    fireEvent.click(getByTestId("settings-keybind-reset-toggleLeftSidebar"));
    expect(settings().keybinds["toggleLeftSidebar"]).toBeUndefined();
  });
});
