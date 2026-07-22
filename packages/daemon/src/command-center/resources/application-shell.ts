import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  ApplicationShellProjectionInputV1WireSchemaZ,
  ApplicationShellProjectionInputV2SchemaZ,
  CANONICAL_SURFACE_REGISTRY,
  SemanticProductIdSchemaZ,
  TerminalAttachmentSemanticPaneIdSchemaZ,
  projectApplicationShellV1,
  type ApplicationShellProjectionInputV1,
  type ApplicationShellProjectionInputV2,
  type TerminalResourceAttachability,
  type TerminalResourceUnavailableReason,
} from "@tmux-ide/contracts";

interface ApplicationShellPanePresentationFacts {
  /** Durable tmux-ide pane stamp. A live `%pane_id` is never accepted as identity. */
  readonly semanticPaneId: string | null;
  readonly index: number;
  readonly title: string;
  readonly currentCommand: string;
  readonly active: boolean;
  readonly role: string | null;
  readonly name: string | null;
  readonly type: string | null;
}

export interface ApplicationShellPaneFacts extends ApplicationShellPanePresentationFacts {
  /** Daemon-only live identity used solely as stable fallback hash input. */
  readonly runtimePaneId: string;
  readonly windowPaneCount: number;
}

export interface ApplicationShellSessionFacts {
  readonly name: string;
  /** Daemon-only generation identity; hashed into fallback resource identity. */
  readonly runtimeSessionId: string;
  readonly dir: string;
  /** Global result from the same catalog analyzer used by live attachment. */
  readonly catalogIssue: Exclude<
    TerminalResourceUnavailableReason,
    "invalid-semantic-stamp" | "not-single-pane-window"
  > | null;
  readonly panes: readonly ApplicationShellPaneFacts[];
}

export interface LegacyApplicationShellPaneFacts extends ApplicationShellPanePresentationFacts {
  /** Legacy live identity. It is intentionally excluded from the V1 projection. */
  readonly id: string;
}

export interface LegacyApplicationShellSessionFacts {
  readonly name: string;
  readonly dir: string;
  readonly panes: readonly LegacyApplicationShellPaneFacts[];
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function semanticId(namespace: string, value: string): string {
  return `${namespace}.${digest(value)}`;
}

function label(value: string | null | undefined, fallback: string): string {
  const withoutControls = Array.from(value ?? "", (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
  }).join("");
  const normalized = withoutControls.replace(/\s+/gu, " ").trim().slice(0, 160);
  return normalized || fallback;
}

function fallbackPaneId(
  session: ApplicationShellSessionFacts,
  pane: ApplicationShellPaneFacts,
): string {
  // Runtime identity is hashed, never serialized. Unlike title/command/index,
  // it is stable for the lifetime of a pane across resource refreshes.
  return semanticId(
    "terminal.discovered",
    JSON.stringify({
      session: session.name,
      runtimeSessionId: session.runtimeSessionId,
      runtimePaneId: pane.runtimePaneId,
    }),
  );
}

interface PaneIdentity {
  readonly resourceId: string;
  readonly attachability: TerminalResourceAttachability;
}

function paneIdentities(session: ApplicationShellSessionFacts): readonly PaneIdentity[] {
  const panes = session.panes;
  const validCounts = new Map<string, number>();
  for (const pane of panes) {
    if (!TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(pane.semanticPaneId).success) continue;
    validCounts.set(pane.semanticPaneId!, (validCounts.get(pane.semanticPaneId!) ?? 0) + 1);
  }
  const claimed = new Set<string>();
  return panes.map((pane) => {
    const stamped = pane.semanticPaneId;
    const locallyValid =
      stamped !== null &&
      TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(stamped).success &&
      validCounts.get(stamped) === 1;
    if (locallyValid && !claimed.has(stamped)) {
      claimed.add(stamped);
      return {
        resourceId: stamped,
        attachability:
          session.catalogIssue !== null
            ? { status: "unavailable", reason: session.catalogIssue }
            : pane.windowPaneCount === 1
              ? { status: "available", semanticPaneId: stamped }
              : { status: "unavailable", reason: "not-single-pane-window" },
      };
    }
    const base = fallbackPaneId(session, pane);
    let candidate = base;
    let suffix = 1;
    while (claimed.has(candidate)) candidate = `${base}.${suffix++}`;
    claimed.add(candidate);
    return {
      resourceId: candidate,
      attachability: {
        status: "unavailable",
        reason:
          session.catalogIssue ??
          (stamped === null || stamped.length === 0
            ? "missing-semantic-stamp"
            : !TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(stamped).success
              ? "invalid-runtime-proof"
              : "duplicate-semantic-stamp"),
      },
    };
  });
}

function legacyFallbackPaneId(pane: LegacyApplicationShellPaneFacts): string {
  // Preserve the original V1 identity projection. Runtime pane ids were not
  // part of this legacy fallback and still never cross the resource wire.
  return semanticId(
    "pane.discovered",
    JSON.stringify({
      index: pane.index,
      title: pane.title,
      command: pane.currentCommand,
      role: pane.role,
      name: pane.name,
      type: pane.type,
    }),
  );
}

function legacyPaneIdentities(
  panes: readonly LegacyApplicationShellPaneFacts[],
): readonly string[] {
  const validCounts = new Map<string, number>();
  for (const pane of panes) {
    if (!SemanticProductIdSchemaZ.safeParse(pane.semanticPaneId).success) continue;
    validCounts.set(pane.semanticPaneId!, (validCounts.get(pane.semanticPaneId!) ?? 0) + 1);
  }
  const claimed = new Set<string>();
  return panes.map((pane) => {
    const stamped = pane.semanticPaneId;
    if (
      stamped !== null &&
      SemanticProductIdSchemaZ.safeParse(stamped).success &&
      validCounts.get(stamped) === 1 &&
      !claimed.has(stamped)
    ) {
      claimed.add(stamped);
      return stamped;
    }
    const base = legacyFallbackPaneId(pane);
    let candidate = base;
    let suffix = 1;
    while (claimed.has(candidate)) candidate = `${base}.${suffix++}`;
    claimed.add(candidate);
    return candidate;
  });
}

function harnessForPane(
  pane: ApplicationShellPanePresentationFacts,
): "codex" | "claude-code" | "custom" {
  const executable = `${pane.currentCommand} ${pane.type ?? ""} ${pane.name ?? ""}`.toLowerCase();
  if (executable.includes("codex")) return "codex";
  if (executable.includes("claude")) return "claude-code";
  return "custom";
}

function isAgentPane(pane: ApplicationShellPanePresentationFacts): boolean {
  const metadata = `${pane.currentCommand} ${pane.type ?? ""}`.toLowerCase();
  return (
    metadata.includes("codex") ||
    metadata.includes("claude") ||
    metadata.includes("opencode") ||
    pane.type === "agent" ||
    pane.role === "lead" ||
    pane.role === "teammate" ||
    pane.role === "planner" ||
    pane.role === "validator" ||
    pane.role === "researcher"
  );
}

function agentActivity(pane: ApplicationShellPanePresentationFacts): "idle" | "running" {
  return /^(?:ba|z|fi)?sh$/u.test(pane.currentCommand.trim().toLowerCase()) ? "idle" : "running";
}

function dockTools(projectId: string): ApplicationShellProjectionInputV1["dock"]["tools"] {
  const tools: ApplicationShellProjectionInputV1["dock"]["tools"][number][] = [];
  for (const surface of CANONICAL_SURFACE_REGISTRY) {
    if (surface.kind !== "dock-tool") continue;
    const unavailable = `${surface.label} capability is not available from the daemon application-shell resource yet`;
    const common = (id: "files" | "changes" | "missions" | "activity") =>
      ({
        id,
        label: surface.label,
        shortcut: surface.shortcut,
        unreadCount: 0,
        disabledReason: unavailable,
      }) as const;
    switch (surface.id) {
      case "files":
        tools.push({
          ...common("files"),
          data: { kind: "files", selectedResourceId: null, fileCount: 0 },
        });
        break;
      case "changes":
        tools.push({
          ...common("changes"),
          data: { kind: "changes", selectedResourceId: null, changeCount: 0 },
        });
        break;
      case "missions":
        tools.push({
          ...common("missions"),
          data: {
            kind: "missions",
            missionId: `mission.unavailable.${digest(projectId)}`,
            title: "Missions unavailable",
            status: "disconnected",
            goalCount: 0,
            taskCount: 0,
          },
        });
        break;
      case "activity":
        tools.push({
          ...common("activity"),
          data: { kind: "activity", eventCount: 0, latestEventLabel: null },
        });
        break;
    }
  }
  return tools;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function projectApplicationShellResourceV1Core(
  session: {
    readonly name: string;
    readonly dir: string;
    readonly panes: readonly ApplicationShellPanePresentationFacts[];
  },
  paneIds: readonly string[],
): ApplicationShellProjectionInputV1 {
  const sessionName = label(session.name, "tmux session");
  const rootLabel = label(basename(session.dir), sessionName);
  const projectId = semanticId("project", session.dir);
  const sessionId = semanticId("session", session.name);
  const focusedIndex = session.panes.findIndex((pane) => pane.active);
  const focusedPaneId = focusedIndex < 0 ? null : (paneIds[focusedIndex] ?? null);
  const agents = session.panes.flatMap((pane, index) => {
    if (!isAgentPane(pane)) return [];
    const paneId = paneIds[index]!;
    return [
      {
        id: semanticId("agent", paneId),
        name: label(pane.name ?? pane.title, `Agent ${index + 1}`),
        harness: harnessForPane(pane),
        activity: agentActivity(pane),
        paneId,
        attention: false,
      },
    ];
  });
  const hasPanes = session.panes.length > 0;
  const paneFact = `${session.panes.length} live terminal pane${session.panes.length === 1 ? "" : "s"} discovered`;
  const agentFact = `${agents.length} agent pane${agents.length === 1 ? "" : "s"} discovered`;

  const parsed = ApplicationShellProjectionInputV1WireSchemaZ.parse({
    project: {
      id: projectId,
      name: sessionName,
      rootLabel,
      readiness: {
        state: hasPanes ? "ready" : "warning",
        facts: ["Live tmux session discovered", paneFact, agentFact],
        warnings: hasPanes ? [] : ["No live terminal panes were discovered"],
      },
    },
    workspace: {
      id: semanticId("workspace", session.dir),
      name: `${sessionName} workspace`.slice(0, 160),
      activeMode: "terminals",
      session: {
        id: sessionId,
        label: sessionName,
        state: hasPanes ? "connected" : "reconnecting",
        active: true,
      },
      sidebar: {
        sessions: [
          {
            id: sessionId,
            label: sessionName,
            state: hasPanes ? "connected" : "reconnecting",
            active: true,
          },
        ],
        agents,
      },
    },
    dock: {
      mode: "collapsed",
      activeTool: "files",
      tools: dockTools(projectId),
    },
    focus: {
      // The daemon only knows whether tmux marks a pane active. Desktop host
      // window activity remains renderer-owned and can replace this
      // conservative snapshot once live host wiring is present.
      windowActivity: focusedPaneId === null ? "inactive" : "active",
      focusZone: focusedPaneId === null ? "primary-navigation" : "canvas",
      appFocusedPaneId: focusedPaneId,
      terminalInputPaneId: null,
      layoutSelectedPaneId: null,
      overlays: [],
    },
    connection: hasPanes
      ? {
          state: "connected",
          message: "Live tmux session discovered",
          safeState: "No desktop terminal attachment is open",
          nextAction: "Choose a terminal pane",
        }
      : {
          state: "recovering",
          message: "The tmux session has no discoverable panes",
          safeState: "No terminal attachment was attempted",
          nextAction: "Wait for tmux pane discovery to recover",
        },
  });
  projectApplicationShellV1(parsed);
  return parsed;
}

/**
 * Pure live-session -> canonical desktop shell adapter. It projects only
 * discovered daemon facts; renderer state, terminal transport, and fixtures
 * are intentionally outside this boundary.
 */
export function projectApplicationShellResource(
  session: ApplicationShellSessionFacts,
): ApplicationShellProjectionInputV2 {
  const identities = paneIdentities(session);
  const core = projectApplicationShellResourceV1Core(
    session,
    identities.map(({ resourceId }) => resourceId),
  );
  const focusedPaneId = core.focus.appFocusedPaneId;
  const terminalResources = session.panes.map((pane, index) => {
    const identity = identities[index]!;
    return {
      id: identity.resourceId,
      title: label(pane.name ?? pane.title, `Terminal ${index + 1}`),
      kind: isAgentPane(pane) ? ("agent" as const) : ("terminal" as const),
      active: identity.resourceId === focusedPaneId,
      attachability: identity.attachability,
    };
  });
  const parsed = ApplicationShellProjectionInputV2SchemaZ.parse({
    ...core,
    terminalInventory: {
      activeResourceId: focusedPaneId,
      resources: terminalResources,
    },
  });

  // Enforce the downstream kernel invariant here so the HTTP boundary can
  // never publish an input that the shared application shell cannot project.
  projectApplicationShellV1(parsed);
  return deepFreeze(parsed);
}

/**
 * Preserve the pre-inventory V1 resource for standalone command-center
 * callers. This adapter deliberately cannot produce a V2 inventory: its
 * discovery input was not collected by the pinned attachment runtime and
 * therefore carries no attachability authority.
 */
export function projectLegacyApplicationShellResourceV1(
  session: LegacyApplicationShellSessionFacts,
): ApplicationShellProjectionInputV1 {
  return deepFreeze(
    projectApplicationShellResourceV1Core(session, legacyPaneIdentities(session.panes)),
  );
}
