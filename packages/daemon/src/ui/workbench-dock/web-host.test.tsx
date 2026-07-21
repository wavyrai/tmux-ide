/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { COHESION_FIXTURE_V1, resolveVisualTheme } from "@tmux-ide/contracts";
import {
  createWorkbenchDockHostFixture,
  createWorkbenchDockHostTrace,
  EXPECTED_WORKBENCH_DOCK_HOST_TRACE,
  EXPECTED_WORKBENCH_DOCK_KEYBOARD_TRACE,
} from "./fixture.ts";
import { WebWorkbenchDock } from "./web-host.tsx";

const disposers: Array<() => void> = [];

function colorToCss(value: { red: number; green: number; blue: number }): string {
  return `rgb(${value.red} ${value.green} ${value.blue})`;
}

function installCanonicalFixtureVariables(
  root: HTMLElement,
): ReturnType<typeof resolveVisualTheme> {
  const theme = resolveVisualTheme({
    userTheme: COHESION_FIXTURE_V1.theme.user,
    projectTheme: COHESION_FIXTURE_V1.theme.project ?? undefined,
    accessibility: COHESION_FIXTURE_V1.theme.accessibility,
  });
  const { tokens } = theme;
  root.style.setProperty("--tmux-ide-surface-panel", colorToCss(tokens.surfaces.panel));
  root.style.setProperty(
    "--tmux-ide-surface-panel-raised",
    colorToCss(tokens.surfaces.panelRaised),
  );
  root.style.setProperty("--tmux-ide-border-subtle", colorToCss(tokens.borders.subtle));
  root.style.setProperty("--tmux-ide-border-focused", colorToCss(tokens.borders.focused));
  root.style.setProperty("--tmux-ide-border-attention", colorToCss(tokens.borders.attention));
  root.style.setProperty("--tmux-ide-text-primary", colorToCss(tokens.text.primary));
  root.style.setProperty("--tmux-ide-text-muted", colorToCss(tokens.text.muted));
  root.style.setProperty("--tmux-ide-selection-selection", colorToCss(tokens.selection.selection));
  root.style.setProperty("--tmux-ide-selection-hover", colorToCss(tokens.selection.hover));
  root.style.setProperty("--tmux-ide-selection-disabled", colorToCss(tokens.selection.disabled));
  root.style.setProperty("--tmux-ide-focus-outline", `${tokens.focus.outline.value * 18}px`);
  root.style.setProperty(
    "--tmux-ide-focus-outline-offset",
    `${tokens.focus.outlineOffset.value * 18}px`,
  );
  root.style.setProperty(
    "--tmux-ide-window-activity-inactive-opacity",
    String(tokens.windowActivity.inactive.opacity.value),
  );
  return theme;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function renderDock(projection = createWorkbenchDockHostFixture()) {
  const trace = createWorkbenchDockHostTrace();
  const root = document.createElement("div");
  const theme = installCanonicalFixtureVariables(root);
  document.body.append(root);
  disposers.push(
    render(
      () => (
        <WebWorkbenchDock
          projection={projection}
          onTabActivate={trace.onTabActivate}
          onActionActivate={trace.onActionActivate}
        >
          <p>shared dock body</p>
        </WebWorkbenchDock>
      ),
      root,
    ),
  );
  return { root, theme, trace };
}

function tab(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`#workbench-dock-tab-${id}`)!;
}

function action(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!;
}

describe("shared WorkbenchDockPresenter DOM host", () => {
  it("renders semantic state and records the same activation trace as OpenTUI", () => {
    const { root, trace } = renderDock();
    const dock = root.querySelector<HTMLElement>(".workbench-dock")!;
    expect(dock.dataset.mode).toBe("open");
    expect(dock.dataset.variant).toBe("compact");
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(root.querySelector('[role="tabpanel"]:not([hidden])')?.textContent).toContain(
      "shared dock body",
    );

    expect(tab(root, "missions").getAttribute("aria-selected")).toBe("true");
    expect(tab(root, "missions").tabIndex).toBe(0);
    expect(tab(root, "changes").disabled).toBe(true);
    expect(tab(root, "changes").getAttribute("aria-disabled")).toBe("true");
    expect(tab(root, "activity").getAttribute("aria-label")).toContain("needs attention");
    for (const tabId of ["files", "changes", "missions", "activity"]) {
      const controlId = tab(root, tabId).getAttribute("aria-controls");
      expect(controlId).not.toBeNull();
      expect(root.querySelector(`#${controlId}`)).not.toBeNull();
    }
    expect(action(root, "toggle-collapse").getAttribute("aria-pressed")).toBeNull();
    expect(action(root, "toggle-collapse").getAttribute("aria-expanded")).toBe("true");
    expect(action(root, "toggle-collapse").getAttribute("aria-controls")).toBe(
      "workbench-dock-panel-missions",
    );
    expect(action(root, "toggle-maximize").getAttribute("aria-pressed")).toBe("false");

    tab(root, "files").click();
    action(root, "toggle-collapse").click();
    action(root, "toggle-maximize").click();
    expect(trace.calls).toEqual(EXPECTED_WORKBENCH_DOCK_HOST_TRACE);

    tab(root, "changes").click();
    expect(trace.calls).toEqual(EXPECTED_WORKBENCH_DOCK_HOST_TRACE);
  });

  it("supports roving focus, disabled-tab skipping, and keyboard activation", () => {
    const { root, trace } = renderDock();
    const missions = tab(root, "missions");
    missions.focus();
    missions.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(document.activeElement).toBe(tab(root, "files"));

    tab(root, "files").dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    expect(document.activeElement).toBe(tab(root, "missions"));

    missions.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(document.activeElement).toBe(tab(root, "activity"));
    expect(trace.calls).toEqual(EXPECTED_WORKBENCH_DOCK_KEYBOARD_TRACE);
    tab(root, "activity").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(trace.calls).toEqual([...EXPECTED_WORKBENCH_DOCK_KEYBOARD_TRACE, "tab:activity"]);

    tab(root, "activity").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(document.activeElement).toBe(tab(root, "files"));
    expect(trace.calls).toEqual([
      ...EXPECTED_WORKBENCH_DOCK_KEYBOARD_TRACE,
      "tab:activity",
      "tab:files",
    ]);
  });

  it("computes selected, focused, attention, and disabled styles from canonical variables", () => {
    const { root, theme } = renderDock();
    expect(document.styleSheets[0]?.cssRules.length).toBeGreaterThan(0);
    const missions = tab(root, "missions");
    const changes = tab(root, "changes");
    const attention = tab(root, "activity").querySelector<HTMLElement>(
      ".workbench-dock__attention",
    )!;

    expect(getComputedStyle(missions).backgroundColor).toBe(
      colorToCss(theme.tokens.selection.selection),
    );
    expect(getComputedStyle(missions).outlineColor).toBe(colorToCss(theme.tokens.borders.focused));
    expect(getComputedStyle(attention).color).toBe(colorToCss(theme.tokens.borders.attention));
    expect(getComputedStyle(changes).backgroundColor).toBe(
      colorToCss(theme.tokens.selection.disabled),
    );
    expect(getComputedStyle(changes).opacity).toBe(
      String(theme.tokens.windowActivity.inactive.opacity.value),
    );
  });

  it("keeps every surface and dock control discoverable in a narrow collapsed layout", () => {
    const projection = createWorkbenchDockHostFixture({
      width: 32,
      height: 12,
      dockMode: "collapsed",
    });
    const { root } = renderDock(projection);
    const dock = root.querySelector<HTMLElement>(".workbench-dock")!;
    expect(dock.dataset.variant).toBe("compact");
    expect(dock.dataset.mode).toBe("collapsed");
    expect(root.querySelectorAll('[role="tab"]')).toHaveLength(4);
    expect(root.querySelectorAll(".workbench-dock__action")).toHaveLength(2);
    expect(root.querySelectorAll('[role="tabpanel"]')).toHaveLength(4);
    expect(root.querySelectorAll('[role="tabpanel"][hidden]')).toHaveLength(4);
    for (const tabId of ["files", "changes", "missions", "activity"]) {
      const controlId = tab(root, tabId).getAttribute("aria-controls");
      expect(root.querySelector(`#${controlId}`)?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(action(root, "toggle-collapse").getAttribute("aria-expanded")).toBe("false");
    expect(action(root, "toggle-collapse").getAttribute("aria-pressed")).toBeNull();
    expect(
      root.querySelector(`#${action(root, "toggle-collapse").getAttribute("aria-controls")}`),
    ).not.toBeNull();
    expect(tab(root, "missions").title).toContain("Missions");
  });
});
