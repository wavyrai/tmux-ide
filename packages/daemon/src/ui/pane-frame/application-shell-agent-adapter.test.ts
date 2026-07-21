import {
  COHESION_FIXTURE_V1,
  projectApplicationShellV1,
  type AgentActivity,
  type ApplicationShellProjectionV1,
} from "@tmux-ide/contracts";
import { describe, expect, it } from "vitest";
import {
  APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS,
  paneFrameModelsFromApplicationShellAgents,
} from "./model.js";

type ConnectionState = ApplicationShellProjectionV1["statusStrip"]["state"];

function shell(
  options: {
    readonly activity?: AgentActivity;
    readonly attention?: boolean;
    readonly connection?: ConnectionState;
    readonly paneId?: string;
    readonly harness?: "codex" | "claude-code" | "custom";
  } = {},
): ApplicationShellProjectionV1 {
  const paneId = options.paneId ?? "pane.agent-primary";
  return projectApplicationShellV1({
    project: {
      ...COHESION_FIXTURE_V1.project,
      rootLabel: "/Users/alice/private-project",
    },
    workspace: {
      ...COHESION_FIXTURE_V1.workspace,
      sidebar: {
        ...COHESION_FIXTURE_V1.workspace.sidebar,
        agents: [
          {
            id: "agent.primary",
            name: "Primary implementer",
            harness: options.harness ?? "codex",
            activity: options.activity ?? "idle",
            paneId,
            attention: options.attention ?? false,
          },
          {
            id: "agent.detached",
            name: "Detached reviewer",
            harness: "claude-code",
            activity: "idle",
            paneId: null,
            attention: false,
          },
        ],
      },
    },
    dock: COHESION_FIXTURE_V1.dock,
    focus: {
      ...COHESION_FIXTURE_V1.focus,
      appFocusedPaneId: paneId,
      terminalInputPaneId: null,
      layoutSelectedPaneId: null,
      overlays: [],
    },
    connection: {
      state: options.connection ?? "connected",
      message: "Live shell",
      safeState: "attachment-ticket.super-secret must stay outside pane chrome",
      nextAction: "Do not render /Users/alice/private-project",
    },
  });
}

function firstModel(projection: ApplicationShellProjectionV1) {
  return paneFrameModelsFromApplicationShellAgents(projection)[0]!;
}

describe("application-shell agent-terminal PaneFrame adapter", () => {
  it("projects semantic identity, title, harness, focus channels, and existing actions", () => {
    const projection = shell({ harness: "claude-code" });
    const selected: ApplicationShellProjectionV1 = {
      ...projection,
      focus: {
        ...projection.focus,
        terminalInputPaneId: "pane.agent-primary",
        layoutSelectedPaneId: "pane.agent-primary",
      },
    };
    const model = firstModel(selected);

    expect(model).toMatchObject({
      pane: { id: "pane.agent-primary", kind: "terminal" },
      title: "Primary implementer",
      subtitle: "Claude Code",
    });
    expect(model.appearance.accessibility).toMatchObject({
      focused: true,
      terminalInputOwner: true,
      layoutSelected: true,
    });
    expect(model.actions.map(({ id, commandId, behavior }) => [id, commandId, behavior])).toEqual([
      [
        APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS.maximizeToggle,
        "workspace.windowMode.maximize.toggle",
        "toggle",
      ],
      [APPLICATION_SHELL_AGENT_TERMINAL_ACTION_IDS.menu, "workspace.pane.menu.open", "action"],
    ]);
  });

  it.each([
    ["explicit attention outranks disconnect", "running", true, "disconnected", "Needs you"],
    ["reconnecting outranks running", "running", false, "reconnecting", "Reconnecting"],
    ["failed becomes an honest error", "failed", false, "connected", "Error"],
    ["running outranks completion", "running", false, "connected", "Running"],
    ["completion is unread", "complete", false, "connected", "Unread · complete"],
    ["waiting alone does not claim user attention", "waiting", false, "connected", "Idle"],
  ] as const)("applies status precedence: %s", (_, activity, attention, connection, label) => {
    const model = firstModel(shell({ activity, attention, connection }));
    expect(model.status?.label).toBe(label);
  });

  it("keeps pane/body, status-slot, and action identities stable across status changes", () => {
    const running = firstModel(shell({ activity: "running" }));
    const complete = firstModel(shell({ activity: "complete" }));

    expect(complete.pane).toEqual(running.pane);
    expect(complete.status?.id).toBe(running.status?.id);
    expect(complete.actions.map(({ id }) => id)).toEqual(running.actions.map(({ id }) => id));
    expect(complete.status?.label).not.toBe(running.status?.label);
  });

  it("uses renderer-local semantic structure only for maximize/restore presentation", () => {
    const projection = shell();
    const paneId = projection.sidebar.agents[0]!.paneId!;
    const docked = firstModel(projection);
    const maximized = paneFrameModelsFromApplicationShellAgents(projection, {
      localStateByPaneId: new Map([[paneId, { structure: "maximized" }]]),
    })[0]!;
    const dockedToggle = docked.actions[0]!;
    const maximizedToggle = maximized.actions[0]!;

    expect(dockedToggle).toMatchObject({
      id: "zoom",
      behavior: "toggle",
      icon: "maximize",
      label: "Maximize",
      pressed: false,
    });
    expect(maximizedToggle).toMatchObject({
      id: "zoom",
      behavior: "toggle",
      icon: "restore",
      label: "Restore",
      pressed: true,
    });
    expect(maximized.actions[1]).toMatchObject({ id: "menu", behavior: "action" });
  });

  it("omits detached agents and rejects duplicate or raw pane identities", () => {
    expect(paneFrameModelsFromApplicationShellAgents(shell())).toHaveLength(1);

    const duplicate = shell();
    const attached = duplicate.sidebar.agents[0]!;
    expect(() =>
      paneFrameModelsFromApplicationShellAgents({
        ...duplicate,
        sidebar: {
          ...duplicate.sidebar,
          agents: [attached, { ...attached, id: "agent.duplicate" }],
        },
      }),
    ).toThrow(/duplicate semantic pane identity/u);

    const raw = shell();
    expect(() =>
      paneFrameModelsFromApplicationShellAgents({
        ...raw,
        sidebar: {
          ...raw.sidebar,
          agents: [{ ...raw.sidebar.agents[0]!, paneId: "%42" }],
        },
      }),
    ).toThrow(/transport-only character/u);
  });

  it("selects no raw commands, paths, secrets, runtime ids, or tickets into model data", () => {
    const encoded = JSON.stringify(firstModel(shell({ activity: "running" })));
    expect(encoded).not.toContain("/Users/alice/private-project");
    expect(encoded).not.toContain("attachment-ticket.super-secret");
    expect(encoded).not.toMatch(/%\d+/u);
    expect(encoded).not.toContain("currentCommand");
    expect(encoded).not.toContain("terminalSourceId");
  });

  it("bounds derived child identities for the longest valid semantic pane id", () => {
    const paneId = `p${"a".repeat(127)}`;
    const model = firstModel(shell({ paneId }));
    expect(model.pane.id).toBe(paneId);
    for (const id of [model.status!.id, ...model.chips.map(({ id }) => id)]) {
      expect(id.length).toBeLessThanOrEqual(128);
      expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
    }
  });
});
