/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import {
  createWorkbenchDockHostFixture,
  createWorkbenchDockHostTrace,
  EXPECTED_WORKBENCH_DOCK_HOST_TRACE,
} from "./fixture.ts";
import { WebWorkbenchDock } from "./web-host.tsx";

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

function renderDock(projection = createWorkbenchDockHostFixture()) {
  const trace = createWorkbenchDockHostTrace();
  const root = document.createElement("div");
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
  return { root, trace };
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
    expect(root.querySelector('[role="tabpanel"]')?.textContent).toContain("shared dock body");

    expect(tab(root, "missions").getAttribute("aria-selected")).toBe("true");
    expect(tab(root, "missions").tabIndex).toBe(0);
    expect(tab(root, "changes").disabled).toBe(true);
    expect(tab(root, "changes").getAttribute("aria-disabled")).toBe("true");
    expect(tab(root, "activity").getAttribute("aria-label")).toContain("needs attention");
    expect(action(root, "toggle-collapse").getAttribute("aria-pressed")).toBe("true");
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
    tab(root, "activity").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(trace.calls).toEqual(["tab:activity"]);

    tab(root, "activity").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(document.activeElement).toBe(tab(root, "files"));
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
    expect(root.querySelector('[role="tabpanel"]')).toBeNull();
    expect(tab(root, "missions").title).toContain("Missions");
  });
});
