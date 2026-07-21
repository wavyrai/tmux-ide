/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from "vitest";
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import {
  PANE_FRAME_FIXTURE_EXPECTED_TRACE,
  PANE_FRAME_FIXTURE_MODEL,
  createPaneFrameFixtureTraceRecorder,
} from "./fixture.js";
import {
  PaneFramePresenter,
  type PaneFrameHostLeaves,
  type PaneFrameModel,
  type PaneFrameStatusItem,
} from "./presenter.js";

const disposers: Array<() => void> = [];

function statusLabel(item: PaneFrameStatusItem): string {
  return item.kind === "status" ? item.status.label : item.chip.label;
}

const TEST_HOST: PaneFrameHostLeaves = {
  Root: (props) => (
    <section data-leaf="root" data-pane={props.pane.id}>
      {props.children}
    </section>
  ),
  Header: (props) => <header data-leaf="header">{props.children}</header>,
  Grip: (props) => (
    <button data-leaf="grip" type="button" onClick={() => props.onActivate?.()}>
      Move {props.pane.id}
    </button>
  ),
  Title: (props) => (
    <h2 data-leaf="title">
      {props.title}
      {props.subtitle ? <small>{props.subtitle}</small> : null}
    </h2>
  ),
  Status: (props) => (
    <span
      data-leaf="status"
      data-item={`${props.item.kind}:${props.item.id}`}
      data-pane={props.pane.id}
    >
      {statusLabel(props.item)}
    </span>
  ),
  ActionList: (props) => (
    <nav data-leaf="actions" data-actions={props.actions.map((action) => action.id).join(",")}>
      {props.children}
    </nav>
  ),
  Action: (props) => (
    <button
      data-leaf="action"
      data-action={props.action.id}
      type="button"
      disabled={!props.interactive}
      onClick={() => props.onActivate?.()}
    >
      {props.action.label}
    </button>
  ),
  Body: (props) => (
    <main data-leaf="body" data-pane={props.pane.id}>
      {props.children}
    </main>
  ),
};

function freshModel(): PaneFrameModel {
  return {
    ...PANE_FRAME_FIXTURE_MODEL,
    pane: { ...PANE_FRAME_FIXTURE_MODEL.pane },
    status: PANE_FRAME_FIXTURE_MODEL.status ? { ...PANE_FRAME_FIXTURE_MODEL.status } : null,
    chips: PANE_FRAME_FIXTURE_MODEL.chips.map((chip) => ({ ...chip })),
    actions: PANE_FRAME_FIXTURE_MODEL.actions.map((action) => ({ ...action })),
  };
}

function renderPresenter(initial: PaneFrameModel = freshModel()) {
  const root = document.createElement("div");
  document.body.append(root);
  const [model, setModel] = createSignal(initial);
  const trace = createPaneFrameFixtureTraceRecorder();
  disposers.push(
    render(
      () => (
        <PaneFramePresenter
          model={model()}
          host={TEST_HOST}
          body={<p data-body-content="shared">Shared body</p>}
          onActionActivate={trace.onActionActivate}
          onGripActivate={trace.onGripActivate}
        />
      ),
      root,
    ),
  );
  return { model, root, setModel, trace };
}

function byData(root: HTMLElement, attribute: string, id: string): HTMLElement {
  return root.querySelector<HTMLElement>(`[data-${attribute}="${id}"]`)!;
}

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  document.body.replaceChildren();
});

describe("PaneFramePresenter", () => {
  it("emits only the shared semantic fixture trace", () => {
    const { root, trace } = renderPresenter();

    byData(root, "leaf", "grip").click();
    byData(root, "action", "split").click();

    expect(trace.trace).toEqual(PANE_FRAME_FIXTURE_EXPECTED_TRACE);
  });

  it("keeps body, action, and chip leaves keyed by semantic identity", () => {
    const { root, setModel } = renderPresenter();
    const body = byData(root, "leaf", "body");
    const split = byData(root, "action", "split");
    const agent = byData(root, "item", "chip:chip.agent");
    const attention = byData(root, "item", "chip:chip.attention");

    const next = freshModel();
    const [nextAgent, nextAttention] = next.chips;
    const splitIndex = next.actions.findIndex((action) => action.id === "split");
    const splitAction = next.actions[splitIndex]!;
    const otherActions = next.actions.filter((action) => action.id !== "split").reverse();
    setModel({
      ...next,
      title: "Updated implementer",
      chips: [
        { ...nextAttention!, label: "Attention updated" },
        { ...nextAgent!, label: "Agent updated" },
      ],
      actions: [{ ...splitAction, label: "Split updated" }, ...otherActions],
    });

    expect(byData(root, "leaf", "body")).toBe(body);
    expect(byData(root, "action", "split")).toBe(split);
    expect(byData(root, "item", "chip:chip.agent")).toBe(agent);
    expect(byData(root, "item", "chip:chip.attention")).toBe(attention);
    expect(split.textContent).toBe("Split updated");
    expect(byData(root, "leaf", "actions").dataset.actions?.split(",")[0]).toBe("split");
    expect(root.querySelector('[data-leaf="title"]')?.textContent).toContain("Updated implementer");
  });

  it("disposes removed identities and creates a fresh leaf when they return", () => {
    const { root, setModel } = renderPresenter();
    const original = byData(root, "action", "split");
    const withoutSplit = freshModel();
    setModel({
      ...withoutSplit,
      actions: withoutSplit.actions.filter((action) => action.id !== "split"),
    });
    expect(root.querySelector('[data-action="split"]')).toBeNull();

    const restored = freshModel();
    const split = restored.actions.find((action) => action.id === "split")!;
    setModel({
      ...restored,
      actions: [split, ...restored.actions.filter((item) => item !== split)],
    });
    const replacement = byData(root, "action", "split");
    expect(replacement).not.toBe(original);

    const updated = freshModel();
    setModel({
      ...updated,
      actions: updated.actions.map((action) =>
        action.id === "split" ? { ...action, label: "Restored and updated" } : action,
      ),
    });
    expect(byData(root, "action", "split")).toBe(replacement);
    expect(replacement.textContent).toBe("Restored and updated");
  });

  it("remounts the body leaf when its semantic pane identity changes", () => {
    const { root, setModel } = renderPresenter();
    const body = byData(root, "leaf", "body");
    const next = freshModel();

    setModel({ ...next, pane: { ...next.pane, id: "pane.follow-up" } });

    expect(byData(root, "leaf", "body")).not.toBe(body);
    expect(byData(root, "leaf", "body").dataset.pane).toBe("pane.follow-up");
  });

  it("withholds callbacks for unavailable, busy, and globally disabled actions", () => {
    const fixture = freshModel();
    const unavailable: PaneFrameModel = {
      ...fixture,
      actions: fixture.actions.map((action) =>
        action.id === "split"
          ? { ...action, available: false, disabledReason: "Unavailable" }
          : action,
      ),
    };
    const { root, setModel, trace } = renderPresenter(unavailable);

    expect((byData(root, "action", "split") as HTMLButtonElement).disabled).toBe(true);
    byData(root, "action", "split").click();

    const busy = freshModel();
    setModel({
      ...busy,
      actions: busy.actions.map((action) =>
        action.id === "split" ? { ...action, busy: true } : action,
      ),
    });
    expect((byData(root, "action", "split") as HTMLButtonElement).disabled).toBe(true);
    byData(root, "action", "split").click();

    const globallyDisabled = freshModel();
    setModel({
      ...globallyDisabled,
      appearance: {
        ...globallyDisabled.appearance,
        action: {
          ...globallyDisabled.appearance.action,
          disabled: true,
          interactive: false,
        },
      },
    });
    expect((byData(root, "action", "split") as HTMLButtonElement).disabled).toBe(true);
    byData(root, "action", "split").click();
    expect(trace.trace).toEqual([]);
  });

  it("rejects duplicate pane, status, chip, and action identities deterministically", () => {
    const pane = freshModel();
    const status = freshModel();
    const chips = freshModel();
    const actions = freshModel();
    const cases: readonly PaneFrameModel[] = [
      {
        ...pane,
        actions: [{ ...pane.actions[0]!, id: pane.pane.id }, ...pane.actions.slice(1)],
      },
      {
        ...status,
        chips: [{ ...status.chips[0]!, id: status.status!.id }, ...status.chips.slice(1)],
      },
      {
        ...chips,
        chips: [chips.chips[0]!, { ...chips.chips[1]!, id: chips.chips[0]!.id }],
      },
      {
        ...actions,
        actions: [
          actions.actions[0]!,
          { ...actions.actions[1]!, id: actions.actions[0]!.id },
          ...actions.actions.slice(2),
        ],
      },
    ];

    for (const model of cases) {
      expect(() => renderPresenter(model)).toThrow(/semantic identity must be unique/u);
    }
  });
});
