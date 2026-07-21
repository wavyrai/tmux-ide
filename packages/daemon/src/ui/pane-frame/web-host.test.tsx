/* @vitest-environment happy-dom */
import {
  COHESION_FIXTURE_V1,
  projectApplicationShellV1,
  type AgentActivity,
  type PaneStructure,
} from "@tmux-ide/contracts";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it } from "vitest";
import {
  paneFrameModelFromCohesionPane,
  paneFrameModelsFromApplicationShellAgents,
} from "./model.js";
import type {
  PaneFrameActionIntent,
  PaneFrameActivationSource,
  PaneFrameGripIntent,
  PaneFrameModel,
} from "./presenter.js";
import { WebPaneFrame } from "./web-host.js";
import styles from "./web-host.css?raw";

const disposers: Array<() => void> = [];
const fixturePane = COHESION_FIXTURE_V1.panes.find((pane) => pane.id === "pane.implementer")!;

function freshModel(): PaneFrameModel {
  const model = paneFrameModelFromCohesionPane(fixturePane);
  return {
    ...model,
    pane: { ...model.pane },
    appearance: {
      ...model.appearance,
      header: { ...model.appearance.header },
      border: { ...model.appearance.border },
      outerOutline: { ...model.appearance.outerOutline },
      status: { ...model.appearance.status },
      action: {
        ...model.appearance.action,
        background: null,
        hover: false,
        focusVisible: false,
        pressed: false,
      },
      accessibility: { ...model.appearance.accessibility },
    },
    status: model.status ? { ...model.status } : null,
    chips: model.chips.map((chip) => ({ ...chip })),
    actions: model.actions.map((action) => ({ ...action, pressed: false })),
  };
}

function liveAgentModel(
  activity: AgentActivity,
  attention = false,
  structure: PaneStructure = "docked",
): PaneFrameModel {
  const input = {
    project: COHESION_FIXTURE_V1.project,
    workspace: {
      ...COHESION_FIXTURE_V1.workspace,
      sidebar: {
        ...COHESION_FIXTURE_V1.workspace.sidebar,
        agents: COHESION_FIXTURE_V1.workspace.sidebar.agents.map((agent) =>
          agent.paneId === "pane.implementer" ? { ...agent, activity, attention } : agent,
        ),
      },
    },
    dock: COHESION_FIXTURE_V1.dock,
    focus: { ...COHESION_FIXTURE_V1.focus, overlays: [] },
    connection: {
      state: "connected" as const,
      message: "Live",
      safeState: "No attachment is open",
      nextAction: "Choose an agent terminal",
    },
  };
  return paneFrameModelsFromApplicationShellAgents(projectApplicationShellV1(input), {
    localStateByPaneId: new Map([["pane.implementer", { structure }]]),
  }).find((model) => model.pane.id === "pane.implementer")!;
}

function renderFrame(initial = freshModel()) {
  const root = document.createElement("div");
  document.body.append(root);
  const [model, setModel] = createSignal(initial);
  const trace: Array<{
    readonly intent: PaneFrameActionIntent | PaneFrameGripIntent;
    readonly source: PaneFrameActivationSource;
  }> = [];
  disposers.push(
    render(
      () => (
        <WebPaneFrame
          model={model()}
          onActionActivate={(intent, source) => trace.push({ intent, source })}
          onGripActivate={(intent, source) => trace.push({ intent, source })}
          renderPaneIcon={(_pane, icon) => <svg data-pane-icon={icon} />}
          renderActionIcon={(action) => <svg data-action-icon={action.icon} />}
          renderGripIcon={(icon) => <svg data-grip-icon={icon} />}
        >
          <div data-terminal-slot="opaque">Terminal transport mounts here</div>
        </WebPaneFrame>
      ),
      root,
    ),
  );
  return { model, root, setModel, trace };
}

function action(root: HTMLElement, id: string): HTMLButtonElement {
  return root.querySelector<HTMLButtonElement>(`[data-action-id="${id}"]`)!;
}

function withAction(
  model: PaneFrameModel,
  id: string,
  update: Partial<PaneFrameModel["actions"][number]>,
): PaneFrameModel {
  return {
    ...model,
    actions: model.actions.map((item) => (item.id === id ? { ...item, ...update } : item)),
  };
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

describe("WebPaneFrame", () => {
  it("renders canonical semantic chrome with native SVG host icons and an opaque body slot", () => {
    const { root } = renderFrame();
    const frame = root.querySelector<HTMLElement>(".web-pane-frame")!;

    expect(frame.dataset.paneId).toBe("pane.implementer");
    expect(frame.dataset.structure).toBe("maximized");
    expect(frame.dataset.terminalInputOwner).toBe("true");
    expect(frame.getAttribute("aria-label")).toContain("terminal input owner");
    expect(root.querySelector(".web-pane-frame__title")?.textContent).toBe("Implementer");
    expect(root.querySelector(".web-pane-frame__subtitle")?.textContent).toBe("Codex");
    expect(root.querySelector('[data-pane-icon="terminals"]')).not.toBeNull();
    expect(root.querySelector('[data-grip-icon="move"]')).not.toBeNull();
    expect(root.querySelector('[data-action-icon="split-right"]')).not.toBeNull();
    expect(root.querySelector('[data-item-kind="status"]')?.textContent).toContain("running");
    expect(root.querySelector('[data-chip-kind="attention"]')?.textContent).toContain("unread");
    expect(root.querySelector('[data-body-sentinel="stable"] [data-terminal-slot]')).not.toBeNull();
  });

  it("preserves semantic command identity and mouse/keyboard activation sources", () => {
    const { root, trace } = renderFrame();
    const grip = root.querySelector<HTMLButtonElement>(".web-pane-frame__grip")!;
    const split = action(root, "split");

    grip.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    split.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    split.click();

    expect(split.dataset.commandId).toBe("pane.split");
    expect(trace).toEqual([
      { intent: { kind: "grip", paneId: "pane.implementer" }, source: "mouse" },
      {
        intent: {
          kind: "action",
          paneId: "pane.implementer",
          actionId: "split",
          commandId: "pane.split",
        },
        source: "mouse",
      },
      {
        intent: {
          kind: "action",
          paneId: "pane.implementer",
          actionId: "split",
          commandId: "pane.split",
        },
        source: "keyboard",
      },
    ]);
  });

  it("uses one effective disabled/loading/pressed/focus/attention/hover action matrix", () => {
    const base = freshModel();
    const { root, setModel } = renderFrame(base);
    const split = action(root, "split");
    expect(split.dataset.state).toBe("base");

    setModel(withAction(base, "split", { attention: true }));
    expect(split.dataset.state).toBe("attention");

    setModel({
      ...withAction(base, "split", { attention: true }),
      appearance: {
        ...base.appearance,
        action: { ...base.appearance.action, focusVisible: true },
      },
    });
    expect(split.dataset.state).toBe("focused");
    expect(split.dataset.state).not.toBe("attention");

    setModel(withAction(base, "split", { pressed: true }));
    expect(split.dataset.state).toBe("pressed");

    setModel(withAction(base, "split", { busy: true }));
    expect(split.dataset.state).toBe("loading");
    expect(split.getAttribute("aria-busy")).toBe("true");
    expect(split.disabled).toBe(true);

    setModel(
      withAction(base, "split", {
        available: false,
        disabledReason: "Split requires a connected pane",
        busy: true,
      }),
    );
    expect(split.dataset.state).toBe("disabled");
    expect(split.getAttribute("aria-disabled")).toBe("true");
    expect(split.getAttribute("aria-label")).toBe("Split requires a connected pane");

    setModel(base);
    split.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    expect(split.dataset.state).toBe("hovered");
    split.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    expect(split.dataset.state).toBe("base");
  });

  it("exposes toggle pressed state separately from focus-visible and attention", () => {
    const base = freshModel();
    const { root, setModel } = renderFrame(base);
    const maximize = action(root, "maximize-toggle");
    expect(maximize.getAttribute("aria-pressed")).toBe("false");

    setModel(withAction(base, "maximize-toggle", { pressed: true, attention: true }));
    expect(maximize.getAttribute("aria-pressed")).toBe("true");
    expect(maximize.dataset.state).toBe("pressed");
  });

  it("keeps the body and controls mounted for immutable updates and remounts on pane identity", () => {
    const base = freshModel();
    const { root, setModel } = renderFrame(base);
    const body = root.querySelector('[data-body-sentinel="stable"]');
    const split = action(root, "split");

    setModel({ ...base, title: "Updated title" });
    expect(root.querySelector('[data-body-sentinel="stable"]')).toBe(body);
    expect(action(root, "split")).toBe(split);
    expect(root.querySelector(".web-pane-frame__title")?.textContent).toBe("Updated title");

    setModel({ ...base, pane: { ...base.pane, id: "pane.replacement" } });
    expect(root.querySelector('[data-body-sentinel="stable"]')).not.toBe(body);
  });

  it("keeps an application-shell agent terminal body mounted while live status changes", () => {
    const running = liveAgentModel("running");
    const { root, setModel } = renderFrame(running);
    const frame = root.querySelector<HTMLElement>(".web-pane-frame")!;
    const body = root.querySelector('[data-body-sentinel="stable"]');
    const zoom = action(root, "zoom");
    const menu = action(root, "menu");

    expect(frame.dataset.paneId).toBe("pane.implementer");
    expect(frame.dataset.terminalInputOwner).toBe("true");
    expect(root.querySelector(".web-pane-frame__subtitle")?.textContent).toBe("Codex");
    expect(root.querySelector('[data-item-kind="status"]')?.textContent).toContain("Running");
    expect(zoom.getAttribute("aria-pressed")).toBe("false");
    expect(zoom.getAttribute("aria-label")).toBe("Maximize this pane");
    expect(zoom.getAttribute("title")).toBe("Maximize this pane");
    expect(zoom.querySelector('[data-action-icon="maximize"]')).not.toBeNull();

    setModel(liveAgentModel("running", false, "maximized"));

    expect(action(root, "zoom")).toBe(zoom);
    expect(action(root, "menu")).toBe(menu);
    expect(zoom.getAttribute("aria-pressed")).toBe("true");
    expect(zoom.getAttribute("aria-label")).toBe("Restore pane layout");
    expect(zoom.getAttribute("title")).toBe("Restore pane layout");
    expect(zoom.querySelector('[data-action-icon="restore"]')).not.toBeNull();
    expect(menu.hasAttribute("aria-pressed")).toBe(false);

    setModel(liveAgentModel("complete", false, "maximized"));

    expect(root.querySelector('[data-body-sentinel="stable"]')).toBe(body);
    expect(action(root, "zoom")).toBe(zoom);
    expect(action(root, "menu")).toBe(menu);
    expect(root.querySelector('[data-item-kind="status"]')?.textContent).toContain(
      "Unread · complete",
    );
    expect(
      Array.from(
        root.querySelectorAll<HTMLElement>("[data-action-id]"),
        (item) => item.dataset.actionId,
      ),
    ).toEqual(["zoom", "menu"]);
    expect(root.innerHTML).not.toMatch(/%\d+/u);
    expect(root.innerHTML).not.toContain("attachment-ticket");
  });

  it("projects floating/maximized geometry and carries compact/reduced-motion CSS policy", () => {
    const base = freshModel();
    const { root, setModel } = renderFrame(base);
    const frame = root.querySelector<HTMLElement>(".web-pane-frame")!;
    expect(frame.dataset.structure).toBe("maximized");

    setModel({
      ...base,
      appearance: { ...base.appearance, structure: "floating" },
    });
    expect(frame.dataset.structure).toBe("floating");
    expect(styles).toMatch(/@container \(max-width: 32rem\)/u);
    expect(styles).toMatch(/@container \(max-width: 22rem\)/u);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)/u);
    expect(styles).not.toContain("transition: all");
  });
});
