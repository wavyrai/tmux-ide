import { z } from "zod";
import { CommandIdSchemaZ } from "./commands.ts";
import {
  DockToolIdSchemaZ,
  PrimaryWorkspaceModeIdSchemaZ,
  CANONICAL_SURFACE_REGISTRY,
} from "./experience-shell.ts";
import { PaneRoleIdSchemaZ, SemanticIconIdSchemaZ } from "./experience-identifiers.ts";
import { FocusOverlayStateV1SchemaZ } from "./focus-overlay.ts";
import {
  AgentActivitySchemaZ,
  CanonicalDomainStatusSchemaZ,
  PaneVisualStateV1SchemaZ,
  SemanticProductIdSchemaZ,
} from "./pane-appearance.ts";
import {
  ThemeAccessibilityPreferencesSchemaZ,
  VisualThemeDocumentV1SchemaZ,
} from "./visual-tokens.ts";

export const COHESION_FIXTURE_VERSION = 1 as const;

const LabelSchemaZ = z.string().min(1).max(160);
const OptionalLabelSchemaZ = z.string().min(1).max(240).nullable();

const ReadinessSchemaZ = z
  .object({
    state: z.enum(["ready", "warning", "blocked"]),
    facts: z.array(LabelSchemaZ).max(24),
    warnings: z.array(LabelSchemaZ).max(24),
  })
  .strict();

const SessionSidebarItemSchemaZ = z
  .object({
    id: SemanticProductIdSchemaZ,
    label: LabelSchemaZ,
    state: z.enum(["connected", "reconnecting", "disconnected"]),
    active: z.boolean(),
  })
  .strict();

const AgentSidebarItemSchemaZ = z
  .object({
    id: SemanticProductIdSchemaZ,
    name: LabelSchemaZ,
    harness: z.enum(["codex", "claude-code", "custom"]),
    activity: AgentActivitySchemaZ,
    paneId: SemanticProductIdSchemaZ.nullable(),
    attention: z.boolean(),
  })
  .strict();

const PaneActionSchemaZ = z
  .object({
    id: z.enum([
      "focus-terminal",
      "split",
      "duplicate",
      "float-toggle",
      "maximize-toggle",
      "detach",
    ]),
    icon: SemanticIconIdSchemaZ,
    label: LabelSchemaZ,
    commandId: CommandIdSchemaZ,
    available: z.boolean(),
    disabledReason: OptionalLabelSchemaZ,
  })
  .strict()
  .refine((action) => action.available === (action.disabledReason === null), {
    message: "available actions must not have a disabled reason and unavailable actions must",
    path: ["disabledReason"],
  });

const PaneFixtureSchemaZ = z
  .object({
    id: SemanticProductIdSchemaZ,
    role: PaneRoleIdSchemaZ,
    title: LabelSchemaZ,
    subtitle: OptionalLabelSchemaZ,
    terminalSourceId: SemanticProductIdSchemaZ.nullable(),
    agentId: SemanticProductIdSchemaZ.nullable(),
    state: PaneVisualStateV1SchemaZ,
    actions: z.array(PaneActionSchemaZ).min(1).max(6),
  })
  .strict()
  .superRefine((pane, ctx) => {
    const expectedOrder = [
      "focus-terminal",
      "split",
      "duplicate",
      "float-toggle",
      "maximize-toggle",
      "detach",
    ];
    let last = -1;
    for (const [index, action] of pane.actions.entries()) {
      const order = expectedOrder.indexOf(action.id);
      if (order <= last) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pane actions must follow canonical action order",
          path: ["actions", index, "id"],
        });
      }
      last = order;
    }
  });

const DockToolDataSchemaZ = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("files"),
      selectedResourceId: SemanticProductIdSchemaZ.nullable(),
      fileCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("changes"),
      selectedResourceId: SemanticProductIdSchemaZ.nullable(),
      changeCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("missions"),
      missionId: SemanticProductIdSchemaZ,
      title: LabelSchemaZ,
      status: CanonicalDomainStatusSchemaZ,
      goalCount: z.number().int().nonnegative(),
      taskCount: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("activity"),
      eventCount: z.number().int().nonnegative(),
      latestEventLabel: OptionalLabelSchemaZ,
    })
    .strict(),
]);

const DockToolFixtureSchemaZ = z
  .object({
    id: DockToolIdSchemaZ,
    label: LabelSchemaZ,
    shortcut: LabelSchemaZ,
    unreadCount: z.number().int().nonnegative(),
    disabledReason: OptionalLabelSchemaZ,
    data: DockToolDataSchemaZ,
  })
  .strict()
  .refine((tool) => tool.id === tool.data.kind, {
    message: "dock tool data kind must match its canonical tool id",
    path: ["data", "kind"],
  });

const ConnectionRecoverySchemaZ = z
  .object({
    state: z.enum(["connected", "reconnecting", "disconnected", "recovering"]),
    message: LabelSchemaZ,
    safeState: LabelSchemaZ,
    nextAction: LabelSchemaZ,
  })
  .strict();

export const CohesionFixtureV1SchemaZ = z
  .object({
    version: z.literal(COHESION_FIXTURE_VERSION),
    project: z
      .object({
        id: SemanticProductIdSchemaZ,
        name: LabelSchemaZ,
        rootLabel: LabelSchemaZ,
        readiness: ReadinessSchemaZ,
      })
      .strict(),
    workspace: z
      .object({
        id: SemanticProductIdSchemaZ,
        name: LabelSchemaZ,
        activeMode: PrimaryWorkspaceModeIdSchemaZ,
        session: SessionSidebarItemSchemaZ,
        sidebar: z
          .object({
            sessions: z.array(SessionSidebarItemSchemaZ).min(1).max(32),
            agents: z.array(AgentSidebarItemSchemaZ).max(64),
          })
          .strict(),
      })
      .strict(),
    panes: z.array(PaneFixtureSchemaZ).min(1).max(32),
    dock: z
      .object({
        mode: z.enum(["collapsed", "open", "maximized"]),
        activeTool: DockToolIdSchemaZ,
        tools: z.array(DockToolFixtureSchemaZ).length(4),
      })
      .strict(),
    focus: FocusOverlayStateV1SchemaZ,
    theme: z
      .object({
        user: VisualThemeDocumentV1SchemaZ.nullable(),
        project: VisualThemeDocumentV1SchemaZ.nullable(),
        accessibility: ThemeAccessibilityPreferencesSchemaZ,
      })
      .strict(),
    connection: ConnectionRecoverySchemaZ,
  })
  .strict()
  .superRefine((fixture, ctx) => {
    const paneIds = fixture.panes.map((pane) => pane.id);
    const paneIdSet = new Set(paneIds);
    if (paneIdSet.size !== paneIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "pane ids must be unique",
        path: ["panes"],
      });
    }
    const agentIds = fixture.workspace.sidebar.agents.map((agent) => agent.id);
    if (new Set(agentIds).size !== agentIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent ids must be unique",
        path: ["workspace", "sidebar", "agents"],
      });
    }
    const sessionIds = fixture.workspace.sidebar.sessions.map((session) => session.id);
    if (new Set(sessionIds).size !== sessionIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "session ids must be unique",
        path: ["workspace", "sidebar", "sessions"],
      });
    }
    if (
      !fixture.workspace.sidebar.sessions.some(
        (session) => session.id === fixture.workspace.session.id,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "active session must be present in the sidebar",
        path: ["workspace", "session", "id"],
      });
    }
    for (const [index, agent] of fixture.workspace.sidebar.agents.entries()) {
      if (agent.paneId !== null && !paneIdSet.has(agent.paneId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "agent pane must exist in fixture panes",
          path: ["workspace", "sidebar", "agents", index, "paneId"],
        });
      }
    }
    const focusReferences = [
      fixture.focus.appFocusedPaneId,
      fixture.focus.terminalInputPaneId,
      fixture.focus.layoutSelectedPaneId,
    ];
    for (const paneId of focusReferences) {
      if (paneId !== null && !paneIdSet.has(paneId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "focus state references an unknown pane",
          path: ["focus"],
        });
      }
    }
    for (const [index, pane] of fixture.panes.entries()) {
      const shouldBeFocused = pane.id === fixture.focus.appFocusedPaneId;
      const shouldOwnTerminal = pane.id === fixture.focus.terminalInputPaneId;
      const shouldBeSelected = pane.id === fixture.focus.layoutSelectedPaneId;
      if (pane.state.applicationFocus.pane !== shouldBeFocused) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pane focus channel must match canonical focus state",
          path: ["panes", index, "state", "applicationFocus", "pane"],
        });
      }
      if (pane.state.applicationFocus.terminalInput !== shouldOwnTerminal) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "terminal input channel must match canonical focus state",
          path: ["panes", index, "state", "applicationFocus", "terminalInput"],
        });
      }
      if (pane.state.layoutInteraction.selected !== shouldBeSelected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "layout selection channel must match canonical focus state",
          path: ["panes", index, "state", "layoutInteraction", "selected"],
        });
      }
      if (
        pane.state.applicationFocus.windowActive !==
        (fixture.focus.windowActivity === "active")
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pane window activity must match canonical focus state",
          path: ["panes", index, "state", "applicationFocus", "windowActive"],
        });
      }
    }
    const expectedDockOrder = CANONICAL_SURFACE_REGISTRY.filter(
      (surface) => surface.kind === "dock-tool",
    ).map((surface) => surface.id);
    const actualDockOrder = fixture.dock.tools.map((tool) => tool.id);
    if (actualDockOrder.some((tool, index) => tool !== expectedDockOrder[index])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "dock tools must use canonical identity and order",
        path: ["dock", "tools"],
      });
    }
  });

export type CohesionFixtureV1 = z.infer<typeof CohesionFixtureV1SchemaZ>;

const paneActions = (canSplit: boolean) => [
  {
    id: "focus-terminal" as const,
    icon: "terminals" as const,
    label: "Focus terminal",
    commandId: "pane.terminal.focus",
    available: true,
    disabledReason: null,
  },
  {
    id: "split" as const,
    icon: "split-right" as const,
    label: "Split pane",
    commandId: "pane.split",
    available: canSplit,
    disabledReason: canSplit ? null : "This pane cannot be split while recovering",
  },
  {
    id: "duplicate" as const,
    icon: "duplicate" as const,
    label: "Duplicate pane",
    commandId: "pane.duplicate",
    available: canSplit,
    disabledReason: canSplit ? null : "This pane cannot be duplicated while recovering",
  },
  {
    id: "float-toggle" as const,
    icon: "float" as const,
    label: "Float or dock",
    commandId: "pane.float.toggle",
    available: true,
    disabledReason: null,
  },
  {
    id: "maximize-toggle" as const,
    icon: "maximize" as const,
    label: "Maximize or restore",
    commandId: "pane.maximize.toggle",
    available: true,
    disabledReason: null,
  },
  {
    id: "detach" as const,
    icon: "pop-out" as const,
    label: "Detach pane",
    commandId: "pane.detach",
    available: true,
    disabledReason: null,
  },
];

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * Canonical immutable cross-host acceptance input; contains no live transport or geometry.
 * Card 22.2 host adapters consume this value but must never decorate or mutate it.
 */
const COHESION_FIXTURE_V1_INPUT: CohesionFixtureV1 = CohesionFixtureV1SchemaZ.parse({
  version: COHESION_FIXTURE_VERSION,
  project: {
    id: "project.tmux-ide",
    name: "tmux-ide",
    rootLabel: "tmux-ide",
    readiness: {
      state: "warning",
      facts: ["pnpm workspace detected", "Codex and Claude Code are available"],
      warnings: ["Desktop terminal attachment is reconnecting"],
    },
  },
  workspace: {
    id: "workspace.product",
    name: "Product workspace",
    activeMode: "terminals",
    session: { id: "session.product", label: "Product", state: "reconnecting", active: true },
    sidebar: {
      sessions: [
        { id: "session.product", label: "Product", state: "reconnecting", active: true },
        { id: "session.docs", label: "Documentation", state: "connected", active: false },
      ],
      agents: [
        {
          id: "agent.pm",
          name: "Fable",
          harness: "claude-code",
          activity: "waiting",
          paneId: "pane.pm",
          attention: true,
        },
        {
          id: "agent.implementer",
          name: "Codex",
          harness: "codex",
          activity: "running",
          paneId: "pane.implementer",
          attention: false,
        },
        {
          id: "agent.reviewer",
          name: "Review",
          harness: "codex",
          activity: "complete",
          paneId: "pane.reviewer",
          attention: false,
        },
        {
          id: "agent.recovery",
          name: "Recovery",
          harness: "custom",
          activity: "disconnected",
          paneId: "pane.recovery",
          attention: true,
        },
      ],
    },
  },
  panes: [
    {
      id: "pane.pm",
      role: "terminal",
      title: "Project manager",
      subtitle: "Fable",
      terminalSourceId: "terminal.pm",
      agentId: "agent.pm",
      state: {
        structure: "docked",
        applicationFocus: { pane: false, terminalInput: false, windowActive: true },
        agentActivity: "waiting",
        domainStatus: "blocked",
        attention: "requested",
        layoutInteraction: {
          editable: true,
          selected: false,
          dragging: false,
          resizing: false,
          previewing: false,
        },
        controlInteraction: {
          hover: false,
          focusVisible: false,
          pressed: false,
          disabled: false,
          loading: false,
        },
      },
      actions: paneActions(true),
    },
    {
      id: "pane.implementer",
      role: "terminal",
      title: "Implementer",
      subtitle: "Codex",
      terminalSourceId: "terminal.implementer",
      agentId: "agent.implementer",
      state: {
        structure: "maximized",
        applicationFocus: { pane: true, terminalInput: true, windowActive: true },
        agentActivity: "running",
        domainStatus: "running",
        attention: "unread",
        layoutInteraction: {
          editable: false,
          selected: false,
          dragging: false,
          resizing: false,
          previewing: false,
        },
        controlInteraction: {
          hover: true,
          focusVisible: true,
          pressed: true,
          disabled: false,
          loading: false,
        },
      },
      actions: paneActions(true),
    },
    {
      id: "pane.reviewer",
      role: "terminal",
      title: "Reviewer",
      subtitle: "Completed review",
      terminalSourceId: "terminal.reviewer",
      agentId: "agent.reviewer",
      state: {
        structure: "floating",
        applicationFocus: { pane: false, terminalInput: false, windowActive: true },
        agentActivity: "complete",
        domainStatus: "review",
        attention: "none",
        layoutInteraction: {
          editable: true,
          selected: true,
          dragging: false,
          resizing: false,
          previewing: true,
        },
        controlInteraction: {
          hover: false,
          focusVisible: false,
          pressed: false,
          disabled: false,
          loading: false,
        },
      },
      actions: paneActions(true),
    },
    {
      id: "pane.recovery",
      role: "terminal",
      title: "Recovery",
      subtitle: "Connection lost",
      terminalSourceId: "terminal.recovery",
      agentId: "agent.recovery",
      state: {
        structure: "docked",
        applicationFocus: { pane: false, terminalInput: false, windowActive: true },
        agentActivity: "disconnected",
        domainStatus: "recovering",
        attention: "recovery",
        layoutInteraction: {
          editable: false,
          selected: false,
          dragging: false,
          resizing: false,
          previewing: false,
        },
        controlInteraction: {
          hover: false,
          focusVisible: true,
          pressed: true,
          disabled: true,
          loading: true,
        },
      },
      actions: paneActions(false),
    },
  ],
  dock: {
    mode: "open",
    activeTool: "missions",
    tools: [
      {
        id: "files",
        label: "Files",
        shortcut: "F3",
        unreadCount: 0,
        disabledReason: null,
        data: { kind: "files", selectedResourceId: "src.index", fileCount: 214 },
      },
      {
        id: "changes",
        label: "Changes",
        shortcut: "F4",
        unreadCount: 4,
        disabledReason: null,
        data: { kind: "changes", selectedResourceId: "src.chrome", changeCount: 4 },
      },
      {
        id: "missions",
        label: "Missions",
        shortcut: "F6",
        unreadCount: 1,
        disabledReason: null,
        data: {
          kind: "missions",
          missionId: "mission.m31",
          title: "Native agent workbench",
          status: "running",
          goalCount: 4,
          taskCount: 22,
        },
      },
      {
        id: "activity",
        label: "Activity",
        shortcut: "F9",
        unreadCount: 2,
        disabledReason: null,
        data: { kind: "activity", eventCount: 18, latestEventLabel: "Reviewer completed" },
      },
    ],
  },
  focus: {
    windowActivity: "active",
    focusZone: "terminal",
    appFocusedPaneId: "pane.implementer",
    terminalInputPaneId: "pane.implementer",
    layoutSelectedPaneId: "pane.reviewer",
    overlays: [
      {
        id: "overlay.palette",
        kind: "command-palette",
        focusReturnTarget: {
          kind: "pane",
          paneId: "pane.implementer",
          input: "terminal",
        },
      },
    ],
  },
  theme: {
    user: {
      version: 1,
      id: "tmux-ide-dark",
      name: "tmux-ide Dark",
      appearance: "dark",
      overrides: {},
    },
    project: null,
    accessibility: { reducedMotion: false, increasedContrast: false },
  },
  connection: {
    state: "recovering",
    message: "Desktop terminal attachment is reconnecting",
    safeState: "The tmux session and agent processes remain active",
    nextAction: "Retry the attachment or open recovery details",
  },
});

export const COHESION_FIXTURE_V1: CohesionFixtureV1 = deepFreeze(COHESION_FIXTURE_V1_INPUT);
