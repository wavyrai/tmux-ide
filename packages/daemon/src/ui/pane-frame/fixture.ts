import { COHESION_FIXTURE_V1, resolvePaneAppearance } from "@tmux-ide/contracts";
import type { PaneFrameActionIntent, PaneFrameGripIntent, PaneFrameModel } from "./presenter.js";

const fixturePane = COHESION_FIXTURE_V1.panes.find((pane) => pane.id === "pane.implementer");
if (!fixturePane) throw new Error("The cohesion fixture must include the implementer pane");

const appearance = resolvePaneAppearance(fixturePane.state);

/** Canonical semantic input shared by every PaneFrame host acceptance suite. */
export const PANE_FRAME_FIXTURE_MODEL: PaneFrameModel = Object.freeze({
  pane: Object.freeze({ id: fixturePane.id, kind: fixturePane.role }),
  appearance,
  title: fixturePane.title,
  subtitle: fixturePane.subtitle,
  status: Object.freeze({
    id: "status.domain",
    label: fixturePane.state.domainStatus,
    description: appearance.accessibility.description,
    tone: appearance.status.tone,
    busy: appearance.accessibility.busy,
  }),
  chips: Object.freeze([
    Object.freeze({
      id: "chip.agent",
      kind: "agent" as const,
      label: `${fixturePane.subtitle ?? "Agent"}: ${fixturePane.state.agentActivity}`,
      tone: appearance.status.domainTone,
    }),
    Object.freeze({
      id: "chip.attention",
      kind: "attention" as const,
      label: fixturePane.state.attention,
      tone: appearance.status.attentionTone,
    }),
  ]),
  actions: Object.freeze(
    fixturePane.actions.map((action) =>
      Object.freeze({
        id: action.id,
        commandId: action.commandId,
        icon: action.icon,
        label: action.label,
        description: action.disabledReason ?? action.label,
        available: action.available,
        disabledReason: action.disabledReason,
        pressed:
          (action.id === "maximize-toggle" && appearance.structure === "maximized") ||
          (action.id === "float-toggle" && appearance.structure === "floating"),
        busy: false,
      }),
    ),
  ),
});

export type PaneFrameFixtureTraceEntry = PaneFrameActionIntent | PaneFrameGripIntent;

export const PANE_FRAME_FIXTURE_EXPECTED_TRACE: readonly PaneFrameFixtureTraceEntry[] =
  Object.freeze([
    Object.freeze({ kind: "grip", paneId: fixturePane.id }),
    Object.freeze({
      kind: "action",
      paneId: fixturePane.id,
      actionId: "split",
      commandId: "pane.split",
    }),
  ]);

export interface PaneFrameFixtureTraceRecorder {
  readonly trace: PaneFrameFixtureTraceEntry[];
  readonly onActionActivate: (intent: PaneFrameActionIntent) => void;
  readonly onGripActivate: (intent: PaneFrameGripIntent) => void;
}

export function createPaneFrameFixtureTraceRecorder(): PaneFrameFixtureTraceRecorder {
  const trace: PaneFrameFixtureTraceEntry[] = [];
  return {
    trace,
    onActionActivate: (intent) => trace.push(intent),
    onGripActivate: (intent) => trace.push(intent),
  };
}
