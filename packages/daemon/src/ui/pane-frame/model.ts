import { resolvePaneAppearance, type CohesionFixtureV1 } from "@tmux-ide/contracts";
import type { PaneFrameModel } from "./presenter.js";

export type CohesionPaneFixture = CohesionFixtureV1["panes"][number];

/** Canonical fixture/resource adapter shared by every PaneFrame host. */
export function paneFrameModelFromCohesionPane(pane: CohesionPaneFixture): PaneFrameModel {
  const appearance = resolvePaneAppearance(pane.state);
  return {
    pane: { id: pane.id, kind: pane.role },
    appearance,
    title: pane.title,
    subtitle: pane.subtitle,
    status: {
      id: `${pane.id}:status`,
      label: pane.state.domainStatus,
      description: appearance.accessibility.description,
      tone: appearance.status.tone,
      busy: appearance.accessibility.busy,
    },
    chips: [
      {
        id: `${pane.id}:agent`,
        kind: "agent",
        label: `${pane.subtitle ?? "Agent"}: ${pane.state.agentActivity}`,
        tone: appearance.status.domainTone,
      },
      ...(pane.state.attention === "none"
        ? []
        : [
            {
              id: `${pane.id}:attention`,
              kind: "attention" as const,
              label: pane.state.attention,
              tone: appearance.status.attentionTone,
            },
          ]),
    ],
    actions: pane.actions.map((action) => ({
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
    })),
  };
}
