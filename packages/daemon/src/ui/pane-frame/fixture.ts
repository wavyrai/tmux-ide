import { COHESION_FIXTURE_V1 } from "@tmux-ide/contracts";
import type { PaneFrameActionIntent, PaneFrameGripIntent, PaneFrameModel } from "./presenter.js";
import { paneFrameModelFromCohesionPane } from "./model.js";

const fixturePane = COHESION_FIXTURE_V1.panes.find((pane) => pane.id === "pane.implementer");
if (!fixturePane) throw new Error("The cohesion fixture must include the implementer pane");

/** Canonical semantic input shared by every PaneFrame host acceptance suite. */
export const PANE_FRAME_FIXTURE_MODEL: PaneFrameModel = Object.freeze(
  paneFrameModelFromCohesionPane(fixturePane),
);

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
