import { hostname } from "node:os";
import { basename } from "node:path";
import {
  ApplicationShellProjectionInputV1WireSchemaZ,
  ApplicationShellProjectionInputV2SchemaZ,
  ApplicationShellProjectionInputV3SchemaZ,
  CANONICAL_SURFACE_REGISTRY,
  SemanticProductIdSchemaZ,
  TerminalAttachmentSemanticPaneIdSchemaZ,
  TerminalAttachmentSemanticWindowIdSchemaZ,
  projectApplicationShellV1,
  resolveAgentStatusPresentation,
  type AgentActivity,
  type AgentGraphDetectStatus,
  type AgentGraphOverlay,
  type AgentGraphStatusSource,
  type ApplicationShellProjectionInputV1,
  type ApplicationShellProjectionInputV2,
  type ApplicationShellProjectionInputV3,
  type AppWindowDocumentV1,
  type DesktopMissionWorkspaceResource,
  type TerminalResourceAttachability,
  type TerminalResourceUnavailableReason,
} from "@tmux-ide/contracts";

import {
  semanticResourceDigest,
  semanticResourceId as semanticId,
} from "../../lib/semantic-resource-id.ts";
import { parseAuthority, type InstantState } from "../../tui/detect/classify.ts";
import { agentDisplayMetadata, resolveAgentStatus } from "../../tui/detect/agent-resolution.ts";
import { fleetSessionIdForName } from "./fleet-catalog.ts";

export interface ApplicationShellPanePresentationFacts {
  /** Durable tmux-ide pane stamp. A live `%pane_id` is never accepted as identity. */
  readonly semanticPaneId: string | null;
  readonly index: number;
  readonly title: string;
  readonly currentCommand: string;
  readonly active: boolean;
  readonly role: string | null;
  readonly name: string | null;
  readonly type: string | null;
  /** Stable detected agent kind; private discovery fact, never a wire identity. */
  readonly agentKind?: string | null;
  /**
   * Durable `@tmux_ide_mission` creation stamp gathered by the IO discovery
   * layer, or null when the pane carries no mission stamp. Optional so legacy
   * facts sources that never gathered it keep projecting; the native inventory
   * backend always populates it. Used ONLY to derive inferred mission-membership
   * edges — its opaque value never crosses the overlay wire.
   */
  readonly missionStamp?: string | null;
  /**
   * Ground-truth agent facts gathered by the IO discovery layer. All four are
   * optional so pre-inventory (legacy) discovery — which never gathered them —
   * keeps its historical shell-vs-active heuristic instead of collapsing to
   * "disconnected". The native inventory backend always populates them.
   *
   * Raw `@agent_state` (`"<state>:<epoch>"`); parsed authority-first by
   * {@link parseAuthority} in the pure layer (never crosses the wire).
   */
  readonly agentStateRaw?: string | null;
  /** Raw `@agent_status_text`; sanitized + freshness-gated in the pure layer. */
  readonly agentStatusTextRaw?: string | null;
  /** Raw `@agent_display_name`; sanitized + freshness-gated in the pure layer. */
  readonly agentDisplayNameRaw?: string | null;
  /**
   * Screen-scrape fallback verdict the discovery layer resolved for panes
   * WITHOUT fresh authority. `null` means authority was fresh (scrape skipped);
   * an {@link InstantState} is a scraped result; `undefined` means the facts
   * source performs no agent detection at all (legacy discovery).
   */
  readonly agentScrapeState?: InstantState | null;
}

export interface ApplicationShellPaneFacts extends ApplicationShellPanePresentationFacts {
  /** Daemon-only live identity used solely as stable fallback hash input. */
  readonly runtimePaneId: string;
  readonly windowPaneCount: number;
  /**
   * Daemon-only live tmux `window_id` (m41 attach-2 gathers it at discovery).
   * Used SOLELY to group panes into their runtime window during the pure
   * attachability classification; like {@link runtimePaneId} it never crosses
   * the resource wire. Optional so pre-attach-4 facts sources that never
   * gathered it keep their historical single-pane gate; the native inventory
   * backend always populates it.
   */
  readonly windowId?: string;
  /**
   * Durable `@tmux_ide_window_id` window stamp (m41 attach-2 gathers it at
   * discovery), or null when the pane's window carries no stamp. It is a WINDOW
   * option, so every pane of one window reports the same value. The pure layer
   * validates it, proves the whole window, and mints the wire-safe
   * `windowResourceId` grouping key from its digest — the raw value never
   * crosses the wire. Optional for the same legacy reason as {@link windowId}.
   */
  readonly windowStamp?: string | null;
}

export interface ApplicationShellSessionFacts {
  readonly name: string;
  /** Daemon-only generation identity; hashed into fallback resource identity. */
  readonly runtimeSessionId: string;
  readonly dir: string;
  /**
   * Global result from the same catalog analyzer used by live attachment. The
   * per-pane-stamp reason (`invalid-semantic-stamp`) and every window-level
   * reason are resolved in the pure projection, never as a global issue.
   */
  readonly catalogIssue: Exclude<
    TerminalResourceUnavailableReason,
    | "invalid-semantic-stamp"
    | "not-single-pane-window"
    | "missing-window-stamp"
    | "window-stamp-inconsistent"
    | "duplicate-window-stamp"
  > | null;
  readonly panes: readonly ApplicationShellPaneFacts[];
}

/**
 * @deprecated Compatibility input for the standalone `command-center` V1
 * endpoint. The embedded daemon uses `ApplicationShellSessionFacts` instead.
 */
export interface DeprecatedStandaloneApplicationShellPaneFacts extends ApplicationShellPanePresentationFacts {
  /** Legacy live identity. It is intentionally excluded from the V1 projection. */
  readonly id: string;
}

/** @deprecated See `DeprecatedStandaloneApplicationShellPaneFacts`. */
export interface DeprecatedStandaloneApplicationShellSessionFacts {
  readonly name: string;
  readonly dir: string;
  readonly panes: readonly DeprecatedStandaloneApplicationShellPaneFacts[];
}

/**
 * The wire-safe agent identity minted from a pane's durable `@tmux_ide_pane_id`
 * stamp — the SAME value the sidebar projection publishes as an agent's `id`
 * (there, via the pane's resource id, which equals the stamp whenever the stamp
 * is valid and unique). Exported so the agent turn-completed receipt correlates
 * with the application-shell without a second minting scheme.
 */
export function agentIdForPaneStamp(stamp: string): string {
  return semanticId("agent", stamp);
}

/**
 * Whether a `pane_title` is the machine talking rather than the pane.
 *
 * tmux seeds `pane_title` with the host's own name, so a pane nobody has
 * titled reports something like `Thijs-MacBook-Pro-M4-Pro.fritz.box`. Shown as
 * a window title that is worse than useless: it is the same string on every
 * pane, it says nothing about what the pane is, and it puts the user's machine
 * name (and local domain) on screen and into every screenshot they share.
 *
 * The comparison is on the first DNS label so a fully qualified title matches
 * the bare hostname it came from, and vice versa.
 */
export function isHostNameTitle(title: string | null | undefined, hostName: string): boolean {
  if (!title) return false;
  const firstLabel = (value: string): string => value.trim().toLowerCase().split(".")[0] ?? "";
  const host = firstLabel(hostName);
  return host.length > 0 && firstLabel(title) === host;
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
  /**
   * Wire-safe grouping key (m41 attach-4) shared by every pane of one durable
   * tmux window. Present only when the pane is attachable through the window
   * path — i.e. its window carries a valid, unique window stamp. Minted from the
   * window stamp digest, never the raw stamp.
   */
  readonly windowResourceId?: string;
}

/** A durable window stamp is trusted only once it passes the semantic grammar. */
function validWindowStamp(value: string | null | undefined): string | null {
  return value != null && TerminalAttachmentSemanticWindowIdSchemaZ.safeParse(value).success
    ? value
    : null;
}

type WindowVerdict =
  | { readonly ok: true; readonly windowResourceId: string | null }
  | { readonly ok: false; readonly reason: TerminalResourceUnavailableReason };

/**
 * PURE — prove the whole tmux window a pane lives in, mirroring the semantic
 * pane catalog's own window proof (`#proveWindow`). A single-pane window needs
 * no stamp (legacy attach path); a multi-pane window is attachable only once
 * every one of its panes shares one durable, unique `@tmux_ide_window_id`.
 * `stampToWindowIds` is the session-wide stamp -> runtime-window map used to
 * fail closed on a stamp claimed by two distinct windows.
 */
function proveWindow(
  windowId: string,
  panes: readonly ApplicationShellPaneFacts[],
  stampToWindowIds: ReadonlyMap<string, ReadonlySet<string>>,
): WindowVerdict {
  const group = panes.filter((pane) => pane.windowId === windowId);
  const paneCount = Math.max(...group.map((pane) => pane.windowPaneCount));
  const stampedCount = group.filter((pane) => validWindowStamp(pane.windowStamp) !== null).length;
  const distinctStamps = new Set(
    group.map((pane) => validWindowStamp(pane.windowStamp)).filter((s): s is string => s !== null),
  );
  if (distinctStamps.size > 1) return { ok: false, reason: "window-stamp-inconsistent" };
  const stamp = distinctStamps.size === 1 ? [...distinctStamps][0]! : null;
  if (paneCount > 1) {
    if (stamp === null) return { ok: false, reason: "missing-window-stamp" };
    if (stampedCount !== group.length) return { ok: false, reason: "window-stamp-inconsistent" };
  }
  if (stamp !== null) {
    if ((stampToWindowIds.get(stamp)?.size ?? 0) > 1) {
      return { ok: false, reason: "duplicate-window-stamp" };
    }
    return { ok: true, windowResourceId: semanticId("terminal-window", stamp) };
  }
  return { ok: true, windowResourceId: null };
}

export function paneIdentities(session: ApplicationShellSessionFacts): readonly PaneIdentity[] {
  const panes = session.panes;
  const validCounts = new Map<string, number>();
  for (const pane of panes) {
    if (!TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(pane.semanticPaneId).success) continue;
    validCounts.set(pane.semanticPaneId!, (validCounts.get(pane.semanticPaneId!) ?? 0) + 1);
  }
  // Session-wide stamp -> runtime windows, for the catalog's duplicate proof.
  const stampToWindowIds = new Map<string, Set<string>>();
  for (const pane of panes) {
    const stamp = validWindowStamp(pane.windowStamp);
    if (stamp === null || pane.windowId === undefined) continue;
    const windows = stampToWindowIds.get(stamp) ?? new Set<string>();
    windows.add(pane.windowId);
    stampToWindowIds.set(stamp, windows);
  }
  const windowVerdicts = new Map<string, WindowVerdict>();
  const verdictFor = (windowId: string): WindowVerdict => {
    const cached = windowVerdicts.get(windowId);
    if (cached !== undefined) return cached;
    const verdict = proveWindow(windowId, panes, stampToWindowIds);
    windowVerdicts.set(windowId, verdict);
    return verdict;
  };
  const claimed = new Set<string>();
  return panes.map((pane) => {
    const stamped = pane.semanticPaneId;
    const locallyValid =
      stamped !== null &&
      TerminalAttachmentSemanticPaneIdSchemaZ.safeParse(stamped).success &&
      validCounts.get(stamped) === 1;
    if (locallyValid && !claimed.has(stamped)) {
      claimed.add(stamped);
      if (session.catalogIssue !== null) {
        return {
          resourceId: stamped,
          attachability: { status: "unavailable", reason: session.catalogIssue },
        };
      }
      // Legacy facts source without window facts: keep the historical gate.
      if (pane.windowId === undefined) {
        return {
          resourceId: stamped,
          attachability:
            pane.windowPaneCount === 1
              ? { status: "available", semanticPaneId: stamped }
              : { status: "unavailable", reason: "not-single-pane-window" },
        };
      }
      const verdict = verdictFor(pane.windowId);
      if (!verdict.ok) {
        return {
          resourceId: stamped,
          attachability: { status: "unavailable", reason: verdict.reason },
        };
      }
      return {
        resourceId: stamped,
        attachability: { status: "available", semanticPaneId: stamped },
        ...(verdict.windowResourceId !== null
          ? { windowResourceId: verdict.windowResourceId }
          : {}),
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

function deprecatedStandaloneFallbackPaneId(
  pane: DeprecatedStandaloneApplicationShellPaneFacts,
): string {
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

function deprecatedStandalonePaneIdentities(
  panes: readonly DeprecatedStandaloneApplicationShellPaneFacts[],
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
    const base = deprecatedStandaloneFallbackPaneId(pane);
    let candidate = base;
    let suffix = 1;
    while (claimed.has(candidate)) candidate = `${base}.${suffix++}`;
    claimed.add(candidate);
    return candidate;
  });
}

export function harnessForPane(
  pane: ApplicationShellPanePresentationFacts,
): "codex" | "claude-code" | "custom" {
  const detected = pane.agentKind?.toLowerCase();
  if (detected === "codex") return "codex";
  if (detected === "claude" || detected === "claude-code") return "claude-code";
  const executable = `${pane.currentCommand} ${pane.type ?? ""} ${pane.name ?? ""}`.toLowerCase();
  if (executable.includes("codex")) return "codex";
  if (executable.includes("claude")) return "claude-code";
  return "custom";
}

const AGENT_STATE_STAMP = /^(?:working|blocked|done|idle):\d+$/u;

export function isAgentPane(pane: ApplicationShellPanePresentationFacts): boolean {
  // A well-formed @agent_state stamp IS the agent contract: any pane that
  // self-reports is an agent pane, even when its command is a bare shell and
  // no @ide_type/role metadata exists. Staleness only affects the status, not
  // the pane's agent-ness.
  if (pane.agentStateRaw != null && AGENT_STATE_STAMP.test(pane.agentStateRaw.trim())) {
    return true;
  }
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

/**
 * Legacy pre-inventory heuristic: a bare shell is idle, anything else is
 * running. Retained ONLY for facts sources that gather no agent options (the
 * standalone command-center V1 discovery); the native inventory path resolves
 * ground truth via {@link resolveAgentPresentation} instead.
 */
function legacyAgentActivity(pane: ApplicationShellPanePresentationFacts): "idle" | "running" {
  return /^(?:ba|z|fi)?sh$/u.test(pane.currentCommand.trim().toLowerCase()) ? "idle" : "running";
}

/** The resolved, wire-safe agent presentation for one pane. */
export interface ResolvedAgentPresentation {
  /** Sidebar `activity` enum (`AGENT_ACTIVITY_IDS`). */
  readonly activity: AgentActivity;
  /** Whether the pane is asking for attention (blocked). */
  readonly attention: boolean;
  /**
   * Where the status came from. Internal for now — the strict sidebar/inventory
   * schemas carry no source field; the later agent-graph overlay card surfaces
   * it on the wire.
   */
  readonly statusSource: AgentGraphStatusSource;
  /** Narrowed detect status (the domain-status source). Internal, as above. */
  readonly detectStatus: AgentGraphDetectStatus;
  /** Sanitized `@agent_display_name`, present only alongside a fresh authority stamp. */
  readonly displayName?: string;
  /** Sanitized `@agent_status_text`, present only alongside a fresh authority stamp. */
  readonly statusText?: string;
}

/**
 * PURE — resolve one pane's ground-truth agent presentation.
 *
 * The status decision itself is {@link resolveAgentStatus} — the exact same
 * authority-first kernel the cockpit uses (tui/detect/agent-resolution.ts), so
 * the desktop app, the cockpit TUI and `team --json` all render one answer. This
 * function only adapts that shared status to the renderer's enums: it maps the
 * status through the shared {@link resolveAgentStatusPresentation} table and
 * gates display metadata via the shared {@link agentDisplayMetadata} (trusted
 * only while authority is fresh). A facts source that gathered no agent options
 * (legacy V1 discovery, `agentScrapeState === undefined`) keeps the historical
 * {@link legacyAgentActivity} heuristic.
 */
export function resolveAgentPresentation(
  pane: ApplicationShellPanePresentationFacts,
  nowSec: number,
): ResolvedAgentPresentation {
  const authorityRaw = pane.agentStateRaw ?? undefined;
  // Legacy back-compat: a facts source that gathered no agent options at all
  // (pre-inventory V1 discovery) has neither authority nor a scrape verdict —
  // keep its historical shell-vs-active heuristic instead of "disconnected".
  if (pane.agentScrapeState === undefined && parseAuthority(authorityRaw, nowSec) === null) {
    const legacy = legacyAgentActivity(pane);
    return {
      activity: legacy,
      attention: false,
      statusSource: "unknown",
      detectStatus: legacy === "idle" ? "idle" : "working",
    };
  }
  // THE shared authority-first decision — the same resolveAgentStatus the cockpit
  // uses. The desktop's scrape verdict is the discovery layer's pre-resolved
  // probe state (no tracker: `done` comes only from an authority stamp here).
  const resolution = resolveAgentStatus({
    authorityRaw,
    nowSec,
    scrape: () => pane.agentScrapeState ?? "unknown",
  });
  const presentation = resolveAgentStatusPresentation({
    status: resolution.status,
    stale: false,
  });
  const metadata = agentDisplayMetadata(
    pane.agentStatusTextRaw ?? undefined,
    pane.agentDisplayNameRaw ?? undefined,
    resolution.source === "authority",
  );
  return {
    activity: presentation.activity,
    attention: presentation.attention,
    statusSource: resolution.source,
    detectStatus: resolution.status,
    ...(metadata.displayName !== undefined ? { displayName: metadata.displayName } : {}),
    ...(metadata.statusText !== undefined ? { statusText: metadata.statusText } : {}),
  };
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
            missionId: `mission.unavailable.${semanticResourceDigest(projectId)}`,
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
  nowSec: number,
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
    const presentation = resolveAgentPresentation(pane, nowSec);
    return [
      {
        id: semanticId("agent", paneId),
        // A fresh authority stamp's sanitized display name outranks the raw pane
        // title; both pass through label()'s control-strip/clamp before the wire.
        name: label(presentation.displayName ?? pane.name ?? pane.title, `Agent ${index + 1}`),
        harness: harnessForPane(pane),
        activity: presentation.activity,
        paneId,
        attention: presentation.attention,
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
  opts: { readonly nowSec?: number } = {},
): ApplicationShellProjectionInputV2 {
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const identities = paneIdentities(session);
  const core = projectApplicationShellResourceV1Core(
    session,
    identities.map(({ resourceId }) => resourceId),
    nowSec,
  );
  const focusedPaneId = core.focus.appFocusedPaneId;
  const terminalResources = session.panes.map((pane, index) => {
    const identity = identities[index]!;
    return {
      id: identity.resourceId,
      title: label(
        pane.name ?? (isHostNameTitle(pane.title, hostname()) ? null : pane.title),
        `Terminal ${index + 1}`,
      ),
      kind: isAgentPane(pane) ? ("agent" as const) : ("terminal" as const),
      active: identity.resourceId === focusedPaneId,
      attachability: identity.attachability,
      ...(identity.windowResourceId !== undefined
        ? { windowResourceId: identity.windowResourceId }
        : {}),
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
 * Bounded counts for the Files and Changes dock badges. They come from the same
 * authorities the renderer reads, computed cheaply (one directory listing, one
 * `git status`) rather than scanned in this projection.
 */
export interface ApplicationShellWorkspaceDockSummary {
  readonly fileCount: number;
  readonly changeCount: number;
}

/**
 * V3 keeps live terminal discovery and durable window layout as separate
 * authorities, then combines their validated snapshots at the wire edge.
 */
export function projectApplicationShellResourceV3(
  session: ApplicationShellSessionFacts,
  appWindows: AppWindowDocumentV1,
  missionWorkspace?: DesktopMissionWorkspaceResource,
  dockSummary?: ApplicationShellWorkspaceDockSummary,
  /**
   * The runtime agent-graph overlay assembled elsewhere from the same shell read
   * (see `resources/agent-graph-overlay.ts`). Additive and optional: when absent
   * the V3 resource is byte-identical to before. Overlay assembly failures must
   * degrade to omitting it upstream — it never fails the shell read.
   */
  agentGraphOverlay?: AgentGraphOverlay,
  opts: { readonly nowSec?: number } = {},
): ApplicationShellProjectionInputV3 {
  const resource = projectApplicationShellResource(session, opts);
  const withMissions = missionWorkspace
    ? dockWithMissionWorkspace(resource.dock, missionWorkspace)
    : resource.dock;
  const dock = dockWithWorkspaceSurfaces(
    withMissions,
    dockSummary ?? { fileCount: 0, changeCount: 0 },
  );
  const parsed = ApplicationShellProjectionInputV3SchemaZ.parse({
    ...resource,
    dock,
    appWindows,
    ...(missionWorkspace === undefined ? {} : { missionWorkspace }),
    ...(agentGraphOverlay === undefined ? {} : { agentGraphOverlay }),
    // Correlation key: the open workspace's own fleet id, minted by the SAME
    // authority the catalog and promotion reversal use, so the renderer can mark
    // this session open in the sidebar and exclude it from the graph merge.
    fleetSessionId: fleetSessionIdForName(session.name),
  });
  projectApplicationShellV1(parsed);
  return deepFreeze(parsed);
}

/**
 * The desktop shell owns live Files and Changes surfaces, so V3 marks those
 * dock tools available and stamps their bounded counts. Their own surfaces
 * render an honest unavailable state when a workspace read fails, so the tool
 * stays openable regardless of the count.
 */
function dockWithWorkspaceSurfaces(
  dock: ApplicationShellProjectionInputV2["dock"],
  summary: ApplicationShellWorkspaceDockSummary,
): ApplicationShellProjectionInputV2["dock"] {
  return {
    ...dock,
    tools: dock.tools.map((tool) => {
      if (tool.id === "files" && tool.data.kind === "files") {
        return {
          ...tool,
          disabledReason: null,
          data: { ...tool.data, fileCount: summary.fileCount },
        };
      }
      if (tool.id === "changes" && tool.data.kind === "changes") {
        return {
          ...tool,
          disabledReason: null,
          data: { ...tool.data, changeCount: summary.changeCount },
        };
      }
      return tool;
    }),
  };
}

function dockWithMissionWorkspace(
  dock: ApplicationShellProjectionInputV2["dock"],
  missionWorkspace: DesktopMissionWorkspaceResource,
): ApplicationShellProjectionInputV2["dock"] {
  const primary =
    missionWorkspace.status === "ready" ? (missionWorkspace.missions[0] ?? null) : null;
  const latestActivity =
    missionWorkspace.status === "ready" ? (missionWorkspace.activity[0] ?? null) : null;
  return {
    ...dock,
    tools: dock.tools.map((tool) => {
      if (tool.id === "missions") {
        return {
          ...tool,
          disabledReason: null,
          data: {
            kind: "missions" as const,
            missionId: primary?.id ?? null,
            title:
              missionWorkspace.status === "degraded"
                ? "Mission history needs attention"
                : (primary?.title ?? "No missions yet"),
            status:
              missionWorkspace.status === "degraded"
                ? ("recovering" as const)
                : missionStatusForDock(primary?.status),
            goalCount: primary?.progress.total ?? 0,
            taskCount: primary?.progress.total ?? 0,
          },
        };
      }
      if (tool.id === "activity") {
        return {
          ...tool,
          disabledReason: null,
          data: {
            kind: "activity" as const,
            eventCount: missionWorkspace.status === "ready" ? missionWorkspace.counts.activity : 0,
            latestEventLabel: latestActivity?.label ?? null,
          },
        };
      }
      return tool;
    }),
  };
}

function missionStatusForDock(
  status: string | undefined,
): "idle" | "running" | "blocked" | "review" | "done" {
  if (status === "started") return "running";
  if (status === "blocked") return "blocked";
  if (status === "review") return "review";
  if (status === "completed" || status === "failed" || status === "cancelled") return "done";
  return "idle";
}

/**
 * @deprecated Explicit V1 compatibility for the public standalone
 * `tmux-ide command-center` process. Remove after the advertised sunset once
 * telemetry confirms no callers remain. It must never become the unversioned
 * default or feed V2/V3 resources.
 */
export function projectDeprecatedStandaloneApplicationShellResourceV1(
  session: DeprecatedStandaloneApplicationShellSessionFacts,
): ApplicationShellProjectionInputV1 {
  return deepFreeze(
    projectApplicationShellResourceV1Core(
      session,
      deprecatedStandalonePaneIdentities(session.panes),
      Math.floor(Date.now() / 1000),
    ),
  );
}
