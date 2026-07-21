/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import { COHESION_FIXTURE_V1 } from "@tmux-ide/contracts";
import {
  DOM_EXPERIENCE_VARIABLE,
  createDomExperience,
  type DomExperienceInput,
} from "../../../../../apps/desktop-renderer/src/experience/dom-experience.ts";
import {
  createWorkbenchDockHostFixture,
  createWorkbenchDockHostTrace,
  EXPECTED_WORKBENCH_DOCK_HOST_TRACE,
  EXPECTED_WORKBENCH_DOCK_KEYBOARD_TRACE,
} from "./fixture.ts";
import { WebWorkbenchDock } from "./web-host.tsx";
import { assertWorkbenchDockHostOrder } from "./presenter.tsx";

const disposers: Array<() => void> = [];

function installCanonicalFixtureVariables(
  root: HTMLElement,
  overrides: DomExperienceInput = {},
): ReturnType<typeof createDomExperience> {
  const experience = createDomExperience({
    userTheme: COHESION_FIXTURE_V1.theme.user,
    projectTheme: COHESION_FIXTURE_V1.theme.project ?? undefined,
    productAccessibility: COHESION_FIXTURE_V1.theme.accessibility,
    ...overrides,
  });
  for (const [name, value] of Object.entries(experience.variables)) {
    root.style.setProperty(name, value);
  }
  root.dataset.increasedContrast = String(experience.accessibility.increasedContrast);
  return experience;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function renderDock(
  projection = createWorkbenchDockHostFixture(),
  experienceOverrides: DomExperienceInput = {},
) {
  const trace = createWorkbenchDockHostTrace();
  const root = document.createElement("div");
  const experience = installCanonicalFixtureVariables(root, experienceOverrides);
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
  return { experience, root, trace };
}

function tab(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`#workbench-dock-tab-${id}`)!;
}

function action(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)!;
}

function pointerClick(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
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

  it("preserves exact mouse and keyboard sources across semantic tab and action activation", () => {
    const calls: string[] = [];
    const root = document.createElement("div");
    installCanonicalFixtureVariables(root);
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <WebWorkbenchDock
            projection={createWorkbenchDockHostFixture()}
            onTabActivate={(tabId, source) => calls.push(`tab:${tabId}:${source}`)}
            onActionActivate={(actionId, nextMode, source) =>
              calls.push(`action:${actionId}:${nextMode}:${source}`)
            }
          />
        ),
        root,
      ),
    );

    pointerClick(tab(root, "files"));
    tab(root, "missions").focus();
    for (const key of ["ArrowLeft", "ArrowRight", "End", "Home", "Enter", " "]) {
      (document.activeElement as HTMLButtonElement).dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true }),
      );
    }
    pointerClick(action(root, "toggle-collapse"));
    action(root, "toggle-maximize").click();

    expect(calls).toEqual([
      "tab:files:mouse",
      "tab:files:keyboard",
      "tab:missions:keyboard",
      "tab:activity:keyboard",
      "tab:files:keyboard",
      "tab:files:keyboard",
      "tab:files:keyboard",
      "action:toggle-collapse:collapsed:mouse",
      "action:toggle-maximize:maximized:keyboard",
    ]);
  });

  it("reactively falls back to the first enabled tab stop when the selected tab is disabled", () => {
    const [projection, setProjection] = createSignal(createWorkbenchDockHostFixture());
    const root = document.createElement("div");
    installCanonicalFixtureVariables(root);
    document.body.append(root);
    disposers.push(render(() => <WebWorkbenchDock projection={projection()} />, root));

    expect(tab(root, "missions").tabIndex).toBe(0);
    const fresh = createWorkbenchDockHostFixture();
    setProjection({
      ...fresh,
      tabs: fresh.tabs.map((candidate) =>
        candidate.id === "missions"
          ? { ...candidate, selected: true, disabled: true, disabledReason: "Unavailable" }
          : candidate.id === "changes"
            ? { ...candidate, selected: false, disabled: true }
            : { ...candidate, selected: false },
      ),
    });

    const tabStops = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(
      (candidate) => candidate.tabIndex === 0,
    );
    expect(tab(root, "missions").disabled).toBe(true);
    expect(tabStops.map((candidate) => candidate.dataset.tabId)).toEqual(["files"]);
  });

  it("preserves host leaf identity across fresh immutable projections", () => {
    const [projection, setProjection] = createSignal(createWorkbenchDockHostFixture());
    const root = document.createElement("div");
    installCanonicalFixtureVariables(root);
    document.body.append(root);
    disposers.push(
      render(
        () => (
          <WebWorkbenchDock projection={projection()}>
            <p>stable body</p>
          </WebWorkbenchDock>
        ),
        root,
      ),
    );
    const filesTab = tab(root, "files");
    const collapseAction = action(root, "toggle-collapse");
    const filesPanel = root.querySelector("#workbench-dock-panel-files");

    setProjection(
      createWorkbenchDockHostFixture({
        dockMode: "maximized",
        activeDockTab: "files",
        focusZone: "dock-body",
      }),
    );

    expect(tab(root, "files")).toBe(filesTab);
    expect(action(root, "toggle-collapse")).toBe(collapseAction);
    expect(root.querySelector("#workbench-dock-panel-files")).toBe(filesPanel);
    expect(filesTab.getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector(".workbench-dock")?.getAttribute("data-mode")).toBe("maximized");
  });

  it("rejects reordered positional host leaves before rendering the wrong semantics", () => {
    const fixture = createWorkbenchDockHostFixture();
    expect(() =>
      assertWorkbenchDockHostOrder({ ...fixture, tabs: [...fixture.tabs].reverse() }),
    ).toThrowError("workbench dock tab order changed: activity,missions,changes,files");
    expect(() =>
      assertWorkbenchDockHostOrder({ ...fixture, actions: [...fixture.actions].reverse() }),
    ).toThrowError("workbench dock action order changed: toggle-maximize,toggle-collapse");
  });

  it("computes selected, focused, attention, and disabled styles from canonical variables", () => {
    const { experience, root } = renderDock();
    expect(document.styleSheets[0]?.cssRules.length).toBeGreaterThan(0);
    const missions = tab(root, "missions");
    const changes = tab(root, "changes");
    const attention = tab(root, "activity").querySelector<HTMLElement>(
      ".workbench-dock__attention",
    )!;

    expect(Array.from(root.style).sort()).toEqual(Object.keys(experience.variables).sort());
    expect(getComputedStyle(missions).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.selection.selection],
    );
    expect(getComputedStyle(missions).outlineColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.border.focused],
    );
    expect(getComputedStyle(attention).color).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.border.attention],
    );
    expect(getComputedStyle(changes).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.control.disabledBackground],
    );
    expect(getComputedStyle(changes).color).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.control.disabledForeground],
    );
    expect(
      getComputedStyle(changes.querySelector<HTMLElement>(".workbench-dock__shortcut")!).color,
    ).toBe("inherit");
    expect(getComputedStyle(changes).opacity).toBe("1");
  });

  it("uses the opaque high-contrast disabled foreground without changing the base surface", () => {
    const { experience, root } = renderDock(createWorkbenchDockHostFixture(), {
      hostTheme: { mode: "dark", highContrast: true },
    });
    const changes = tab(root, "changes");

    expect(getComputedStyle(changes).backgroundColor).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.control.disabledBackground],
    );
    expect(getComputedStyle(changes).color).toBe(
      experience.variables[DOM_EXPERIENCE_VARIABLE.control.disabledForegroundHighContrast],
    );
    expect(getComputedStyle(changes).opacity).toBe("1");
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
