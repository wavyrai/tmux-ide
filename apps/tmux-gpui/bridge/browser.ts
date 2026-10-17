import { createTerminalRecovery } from "./terminal-recovery.ts";
import { createSessionTabs, sessionTabCommandSchema } from "./session-tabs.ts";
import {
  createWorkspaceFleetAgents,
  openWorkspaceFleetAgentSchema,
} from "./workspace-fleet-agents.ts";
import {
  createSessionHistoryController,
  sessionHistoryCommandSchema,
} from "./session-history-controller.ts";
import { createPaletteOwner, paletteObserveSchema, openPaletteAgentSchema } from "./palette.ts";
import { fleetPreferenceCommand } from "./fleet-preference-publication.ts";
import { createDiagnosticChannel } from "./diagnostic-channel.ts";
import { diagnosticStatus } from "./live-diagnostics.ts";
import { closePane, confirmsClosedPane } from "./close-pane.ts";
import {
  confirmsNewWindow,
  newWindowReceiptSchema,
  matchesCreation,
  type NewAgent,
} from "./new-window.ts";
import { completeFleetServerSelection } from "./fleet-server-selection.ts";
import { createOnFleetRoute } from "./fleet-server-create.ts";
import { applyHomeAgentFilter, homeAgentFilterSchema } from "./home-agent-filter.ts";
import { createHomeAgentRecovery, homeAgentRecoverySchema } from "./home-agent-recovery.ts";
import { admitFleetAgent, discoveredAgentRequest } from "./fleet-agent-admission.ts";
import {
  createAttentionOwner,
  attentionObserveSchema,
  openAttentionAgentSchema,
} from "./attention.ts";
import { verifyFleetAgentTarget } from "./fleet-agents.ts";
import {
  projectHomeAgentRows,
  type HomeAgentRow,
} from "../../../packages/presentation/src/home-agent-roster.ts";
import { createNativeFleetRuntime } from "./fleet-runtime.ts";
import { FleetSelectionError } from "./fleet.ts";
import { prepareMachineConnection } from "./add-machine.ts";
import {
  createNativeMachineRegistry,
  MachineRegistryError,
  savedMachineRouteMatches,
} from "./machines.ts";
import {
  type SavedMachine,
  SavedMachineSchema,
  SavedMachineMutationSchema,
} from "../../../packages/contracts/src/saved-machines.ts";
import {
  splitRefreshGuard,
  refreshSplitInventory,
  SplitRefreshError,
} from "./pane-split-refresh.ts";
import { WorkspaceWindowSplitResultSchemaZ } from "../../../packages/contracts/src/workspace-multiplexer.ts";
import {
  splitGestureSchema,
  splitGesturePublicationSchema,
  type SplitGesturePublication,
} from "./split-gesture.ts";
import {
  WindowSplitLayoutResourceSchemaZ,
  type WindowSplitLayoutResource,
} from "../../../packages/contracts/src/window-split-layout.ts";
import { splitLayoutMatches } from "./split-layout.ts";
import { createHomeAgentObserver } from "./home-agents.ts";
import {
  homeAgentPublication,
  agentAvailable,
  openAgentSchema,
  openWorkspaceAgentSchema,
} from "./home-agent-publication.ts";
import {
  resizeGestureSchema,
  resizeGesturePublicationSchema,
  type ResizeGesturePublication,
} from "./resize-gesture.ts";
import { createSessionOwner, sessionCreateSchema } from "./session-create.ts";
import { paneActionSchema, paneActionsSchema } from "./pane-actions.ts";
import { openEditorSchema, openSelectedPaneEditor } from "./local-editor.ts";
import { paneResizeSchema, resizePresentationMatches } from "./pane-resize.ts";
import { CatalogStageError } from "./catalog-errors.ts";
import { createAppearanceOwner } from "./appearance.ts";
import { DaemonCompatibilityError, DaemonDiscoveryError } from "./discovery.ts";
import { scrollSchema } from "./history.ts";
import { wheelSchema } from "./wheel.ts";
import { surfacesSchema } from "./window-canvas.ts";
import { createWindowPresentation } from "./window-presentation.ts";
import { paneChoices, preferredPane, topologySchema, type Layout } from "./topology.ts";
import { resizeSchema } from "./geometry.ts";
import { previewInputSchema, MAX_INPUT_LINE } from "./input.ts";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { createPreviewCatalog, sessionChoice } from "./catalog.ts";
import { connectionSchema } from "./config.ts";
import { createPreviewHostSource, remoteHostConfigSchema } from "./host-source.ts";
import { RemoteRouteError } from "./remote-route.ts";

const machineRegistryCommand = z.discriminatedUnion("operation", [
  z
    .object({
      type: z.literal("machines"),
      operation: z.literal("read"),
      request: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      type: z.literal("machines"),
      operation: z.literal("save"),
      request: z.number().int().nonnegative().safe(),
      revision: z.number().int().nonnegative().safe(),
      machine: SavedMachineSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("machines"),
      operation: z.literal("mutate"),
      request: z.number().int().nonnegative().safe(),
      revision: z.number().int().nonnegative().safe(),
      change: SavedMachineMutationSchema,
    })
    .strict(),
]);
const commandSchema = z.union([
  fleetPreferenceCommand,
  sessionHistoryCommandSchema,
  sessionTabCommandSchema,
  openWorkspaceFleetAgentSchema,
  attentionObserveSchema,
  openAttentionAgentSchema,
  paletteObserveSchema,
  openPaletteAgentSchema,
  machineRegistryCommand,
  z
    .object({
      type: z.literal("fleet-disconnect"),
      request: z.number().int().nonnegative().safe(),
      disconnect: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fleet-retry"),
      request: z.number().int().nonnegative().safe(),
      retry: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fleet-server"),
      request: z.number().int().positive().safe(),
      selection: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fleet-session"),
      request: z.number().int().positive().safe(),
      selection: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      type: z.literal("machine-profile"),
      request: z.number().int().positive().safe(),
      id: SavedMachineSchema.shape.id,
      revision: z.number().int().nonnegative().safe(),
    })
    .strict(),
  z
    .object({
      type: z.literal("machine"),
      request: z.number().int().positive().safe(),
      sshTarget: remoteHostConfigSchema.shape.sshTarget.nullable(),
    })
    .strict(),
  openEditorSchema,
  openWorkspaceAgentSchema,
  homeAgentRecoverySchema,
  homeAgentFilterSchema,
  openAgentSchema,
  sessionCreateSchema,
  paneActionSchema,
  paneResizeSchema,
  resizeGestureSchema,
  splitGestureSchema,
  z.object({ type: z.literal("theme"), id: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal("appearance"), system: z.enum(["dark", "light"]) }).strict(),
  z
    .object({
      type: z.literal("presence"),
      active: z.boolean(),
      revision: z.number().int().nonnegative().safe().default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal("input"),
      request: z.number().int().positive().safe(),
      id: z.string().min(1).max(512),
      input: z.union([previewInputSchema, resizeSchema, scrollSchema, wheelSchema]),
    })
    .strict(),
  z.object({ type: z.literal("home"), request: z.number().int().positive().safe() }).strict(),
  z.object({ type: z.literal("refresh"), request: z.number().int().positive().safe() }).strict(),
  z
    .object({
      type: z.literal("session"),
      request: z.number().int().positive().safe(),
      id: z.string().min(1).max(512),
    })
    .strict(),
  z
    .object({
      type: z.literal("pane"),
      request: z.number().int().positive().safe(),
      id: z.string().min(1).max(512),
    })
    .strict(),
]);
const MAX_FRAME = 8 * 1024 * 1024;
const appearance = createAppearanceOwner();
const sessionCreate = createSessionOwner();
let machines: ReturnType<typeof createNativeMachineRegistry> | undefined;
let fleet: ReturnType<typeof createNativeFleetRuntime> | undefined;
let selectedFleet = false;
let machineMessage: string | null = null;
let selectedMachineProfile: SavedMachine | null = null;
let savedMachineRetired = false;
function machinesChanged() {
  if (fleet && machines) {
    const registry = machines.publication();
    fleet.reconcile(registry.available ? registry.machines : []);
  }
  if (
    selectedMachineProfile &&
    machines &&
    !savedMachineRouteMatches(selectedMachineProfile, machines.publication())
  ) {
    cancelTerminalRecovery();
    selectedMachineProfile = null;
    savedMachineRetired = true;
    hostSource?.dispose();
    hostSource = undefined;
    retireMachineRoute();
    status = "Saved machine changed — select a machine again";
  }
  publish();
}
let hostSource: ReturnType<typeof createPreviewHostSource> | undefined;
let machineRouteRevision = 0;
async function readHost() {
  try {
    if (selectedFleet && fleet) return await fleet.read();
    if (savedMachineRetired) throw new MachineRegistryError("inactive");
    if (process.argv.length !== 3) throw new Error("Invalid browser arguments");
    hostSource ??= createPreviewHostSource(process.argv[2]!, retireMachineRoute);
    return await hostSource.read();
  } catch (error) {
    if (
      error instanceof DaemonCompatibilityError ||
      error instanceof DaemonDiscoveryError ||
      error instanceof RemoteRouteError ||
      error instanceof FleetSelectionError ||
      error instanceof MachineRegistryError
    )
      throw error;
    // Parser errors can include pieces of the private JSON document.
    process.stderr.write("Could not read private native-browser host configuration\n");
    // eslint-disable-next-line preserve-caught-error -- Parser causes may contain the private owner token.
    throw new Error("Private host configuration is unavailable");
  }
}
let catalog: ReturnType<typeof createPreviewCatalog> | undefined;
const connection = randomUUID();
let request = 0,
  sequence = 0,
  stopped = false;
let shutdownRequested = false;
let sessions: ReturnType<typeof sessionChoice>[] = [];
let panes: z.infer<typeof connectionSchema>[] = [];
let selectedSession: string | null = null,
  selectedPane: string | null = null;
let resizeToken: string | null = null;
let splitLayout: WindowSplitLayoutResource | null = null;
let splitGesture: SplitGesturePublication | null = null;
let activeSplitGesture: string | null = null;
let resizeGestureSupported = false;
let resizeGesture: ResizeGesturePublication | null = null;
let activeGesture: { gesture: string; id: string; axis: "cols" | "rows"; request: number } | null =
  null;
let pendingPaneSplit:
  | (Extract<z.infer<typeof paneActionSchema>, { action: "split" }> & {
      window: string;
      presenceRevision: number;
    })
  | null = null;
let pendingClose: {
  token: string;
  id: string;
  presenceRevision: number;
  submitted: boolean;
} | null = null;
let pendingNewWindow: {
  token: string;
  window: string;
  presenceRevision: number;
  agent?: NewAgent;
} | null = null;
let paneActions: z.infer<typeof paneActionsSchema> | null = null;
let editorPending = false;
let editorConsumed: string | null = null;
let editorMessage: { request: number; id: string; text: string } | null = null;
let snapshot: unknown = null;
let historyOffset = 0;
let copyRegion: unknown = null;
let regions: unknown[] = [];
let layouts: Layout[] = [];
let inputReady = false;
let foreground = true;
let sessionCatalogComplete = false;
let initialPane: string | null = null;
let presenceRevision = 0;
let appliedPresenceRevision = 0;
let surface: "home" | "workspace" = "home";
let homePhase: "loading" | "live" | "unavailable" = "loading";
let status = "Loading sessions";
let pending: string | null = null,
  blocked = false;
let active:
  | {
      child: ChildProcess;
      done: Promise<void>;
      catalogOnly: boolean;
      presentation: ReturnType<typeof createWindowPresentation>;
    }
  | undefined;

let attentionSelectionRejected: { request: number; fromRequest: number; scope: number } | null =
  null;
const attention = createAttentionOwner(publish);
let paletteSelectionRejected: { request: number; fromRequest: number; scope: number } | null = null;
const palette = createPaletteOwner(publish);
const sessionTabs = createSessionTabs();
let sessionTabResult: {
  request: number;
  fromRequest: number;
  revision: number;
  action: string;
  outcome: "closed" | "rejected";
} | null = null;
let observingTabs = false;
let stopTabObservation: (() => void) | undefined;
const workspaceFleetAgents = createWorkspaceFleetAgents(publish);
let workspaceFleetAgentRejected: {
  request: number;
  fromRequest: number;
  scope: number;
  rosterRevision: number;
  key: string;
} | null = null;
const sessionHistory = createSessionHistoryController();
let sessionHistoryRejected: {
  request: number;
  fromRequest: number;
  revision: number;
  action: string;
} | null = null;
let historySaveFailed = false;
let acceptSessionVisit: (() => void) | null = null;
let recoveryTarget: {
  resolve: () => string | null;
  key: string;
  pane: string;
  request: number;
} | null = null;
const terminalRecovery = createTerminalRecovery({
  async attempt(current) {
    const target = recoveryTarget;
    const owner = fleet;
    if (!target || !owner || stopped || request !== target.request || surface !== "workspace")
      return true;
    const key = target.resolve();
    if (!key) return false;
    const valid = () =>
      current() &&
      !stopped &&
      recoveryTarget === target &&
      request === target.request &&
      fleet === owner &&
      surface === "workspace";
    await retire();
    if (!valid()) return true;
    const { host, sessionId } = await owner.selectCanonical(key);
    if (!valid()) return true;
    const fresh = createPreviewCatalog(host);
    catalog?.dispose();
    catalog = fresh;
    const live = () => valid() && catalog === fresh;
    const list = await fresh.sessions();
    if (!live()) return false;
    if (list.length > 512 || !list.some((session) => session.liveSessionId === sessionId))
      return false;
    sessions = list.map(sessionChoice);
    const choices = await fresh.panes(sessionId);
    if (!live()) return false;
    if (choices.length > 512) throw new Error("Recovery catalog limit");
    // Never substitute another pane or replay input from the retired lifetime.
    const pane = choices.find(
      (choice) => choice.semanticPaneId === target.pane && choice.liveSessionId === sessionId,
    );
    if (!pane) return false;
    panes = choices;
    selectedSession = sessionId;
    selectedPane = target.pane;
    snapshot = null;
    inputReady = false;
    status = "Reconnecting terminal";
    publish();
    await openPane(pane, target.request, false, undefined, live);
    const deadline = Date.now() + 5000;
    while (live() && Date.now() < deadline) {
      if (snapshot && selectedPane === target.pane && (!foreground || inputReady)) {
        const retained = owner.retainedTarget(key);
        if (retained && sessionTabs.recover(target.request, target.key, retained)) target.key = key;
        startAgents();
        publish();
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  },
  exhausted() {
    status = "Connection recovery paused — refresh or select the session again";
    publish();
  },
});
function cancelTerminalRecovery() {
  terminalRecovery.cancel();
  recoveryTarget = null;
}
function recoverTerminal(reason: string) {
  if (!recoveryTarget || recoveryTarget.request !== request || stopped || surface !== "workspace")
    return;
  // Fixed stage only, no host identifiers, credentials or terminal content.
  process.stderr.write(`TMUX_GPUI_RECOVERY ${reason}\n`);
  inputReady = false;
  snapshot = null;
  status = "Reconnecting terminal";
  terminalRecovery.start();
  publish();
}
let highestNavigationAttempt = 0;
const admitNavigationAttempt = (attempt: number) => {
  if (attempt <= request || attempt <= highestNavigationAttempt) return false;
  cancelTerminalRecovery();
  highestNavigationAttempt = attempt;
  return true;
};
let agentOwner: ReturnType<typeof createHomeAgentObserver> | undefined;
const homeRecovery = createHomeAgentRecovery();
let homeAgentFilter: { revision: number; machineId: string | null } | null = null;
let agentPublication: ReturnType<typeof homeAgentPublication> | null = null;
let stopFleetAgents: (() => void) | undefined;
let agentRevision = 0;
let agentTimer: ReturnType<typeof setTimeout> | undefined;
function retireAgents() {
  stopFleetAgents?.();
  stopFleetAgents = undefined;
  clearTimeout(agentTimer);
  agentTimer = undefined;
  agentOwner?.dispose();
  agentOwner = undefined;
  agentPublication = null;
  homeRecovery.clear();
  homeAgentFilter = null;
}
function startAgents() {
  retireAgents();
  if (fleet && surface === "home" && foreground && !stopped) {
    const token = request;
    stopFleetAgents = fleet.observeHomeAgents(({ snapshot: value, machineId }) => {
      if (stopped || !foreground || surface !== "home" || request !== token) return;
      agentPublication = homeAgentPublication(
        value,
        ++agentRevision,
        (row) => !!discoveredAgentRequest(fleet?.resolveAgent(row.key)?.row),
      );
      homeAgentFilter = { revision: agentRevision, machineId };
      homeRecovery.adopt(value, agentRevision);
      publish();
    });
    return;
  }
  const host = catalog,
    token = request,
    observedSurface = surface,
    observedSession = selectedSession;
  if (
    !host ||
    stopped ||
    !foreground ||
    (surface === "home" ? homePhase !== "live" : !selectedSession)
  )
    return;
  const current = () =>
    !stopped &&
    foreground &&
    surface === observedSurface &&
    selectedSession === observedSession &&
    request === token &&
    catalog === host &&
    agentOwner === owner;
  const owner = createHomeAgentObserver({
    readShell: (session, signal) => host.readHomeShell(session, signal),
    publish(value) {
      if (!current()) return;
      agentPublication = homeAgentPublication(value, ++agentRevision);
      publish();
      if (value.loadingSessions === 0) {
        clearTimeout(agentTimer);
        agentTimer = setTimeout(() => void refreshAgents(), 5000);
      }
    },
  });
  agentOwner = owner;
  agentPublication = {
    revision: ++agentRevision,
    phase: "loading",
    rows: [],
    observedSessions: 0,
    totalSessions: observedSurface === "home" ? sessions.length : 1,
    truncatedSessions: 0,
    truncatedRows: 0,
    note: "Discovering agents…",
  };
  publish();
  async function refreshAgents() {
    if (!current()) return;
    try {
      const list = await host!.homeSessions();
      if (current()) {
        const observed =
          observedSurface === "home"
            ? list
            : list.filter((session) => session.liveSessionId === observedSession);
        if (observedSurface === "workspace" && observed.length !== 1)
          throw new Error("Selected session unavailable");
        owner.refresh(observed);
      }
    } catch {
      if (current()) {
        retireAgents();
        agentPublication = {
          revision: ++agentRevision,
          phase: "unavailable",
          rows: [],
          observedSessions: 0,
          totalSessions: observedSurface === "home" ? sessions.length : 1,
          truncatedSessions: 0,
          truncatedRows: 0,
          note: "Agent observations unavailable — refresh the catalog",
        };
        if (observedSurface === "home")
          status = "Agent observations unavailable — refresh the catalog";
        publish();
      }
    }
  }
  void refreshAgents();
}

function launchFleetSelection(
  selection: string,
  token: number,
  agent?: HomeAgentRow,
  requiredCurrent: () => boolean = () => true,
  canonicalKey?: string,
) {
  if (!fleet) throw new FleetSelectionError();
  selectedFleet = true;
  selectedMachineProfile = null;
  savedMachineRetired = false;
  machineRouteRevision++;
  hostSource?.dispose();
  hostSource = undefined;
  catalog?.dispose();
  catalog = undefined;
  const owner = fleet;
  const routeRevision = machineRouteRevision;
  const capturedPresence = presenceRevision;
  const current = () =>
    !stopped &&
    request === token &&
    requiredCurrent() &&
    fleet === owner &&
    routeRevision === machineRouteRevision &&
    (!agent || (foreground && capturedPresence === presenceRevision));
  // SSH identity/inventory work must not block Home or another selection.
  void (canonicalKey ? owner.selectCanonical(canonicalKey) : owner.select(selection))
    .then(async ({ host, sessionId, session }) => {
      if (!current()) return;
      const fresh = createPreviewCatalog(host);
      catalog = fresh;
      const list = await fresh.sessions();
      if (!current() || catalog !== fresh) return;
      if (list.length > 512) throw new Error("Too many sessions for preview");
      sessions = list.map(sessionChoice);
      if (!sessions.some((session) => session.id === sessionId)) throw new FleetSelectionError();
      const admission =
        agent && discoveredAgentRequest(agent)
          ? await admitFleetAgent(
              agent,
              (target) => fresh.openAgent(sessionId, target),
              async (result) => {
                const identity = {
                  id: session.sourceId,
                  name: session.name,
                  liveSessionId: sessionId,
                  workspaceName: result.workspaceName,
                  server: session.server,
                };
                const shell = await fresh.readHomeShell(identity, new AbortController().signal);
                return projectHomeAgentRows(identity, {
                  resource: shell.resource,
                  daemon: { instanceId: shell.server.generation },
                });
              },
              owner.read,
              () => current() && catalog === fresh,
            )
          : null;
      if (!current() || catalog !== fresh) return;
      const choices = admission
        ? await fresh.workspacePanes(sessionId, admission.workspaceName)
        : await fresh.panes(sessionId);
      if (!current() || catalog !== fresh) return;
      if (choices.length > 512) throw new Error("Too many panes for preview");
      let target: (typeof choices)[number] | undefined = choices[0];
      if (admission) {
        const matches = choices.filter((pane) => pane.semanticPaneId === admission.semanticPaneId);
        if (matches.length !== 1) throw new FleetSelectionError();
        target = matches[0];
      } else if (agent) {
        if (!session.workspaceName) throw new FleetSelectionError();
        const identity = {
          id: session.sourceId,
          name: session.name,
          liveSessionId: sessionId,
          workspaceName: session.workspaceName,
          server: session.server,
        };
        const paneId = await verifyFleetAgentTarget(
          agent,
          async () => {
            const shell = await fresh.readHomeShell(identity, new AbortController().signal);
            return projectHomeAgentRows(identity, {
              resource: shell.resource,
              daemon: { instanceId: shell.server.generation },
            });
          },
          owner.read,
          () => current() && catalog === fresh,
        );
        target = choices.find((pane) => pane.semanticPaneId === paneId);
        if (!target) throw new FleetSelectionError();
      }
      panes = choices;
      selectedSession = sessionId;
      sessionCatalogComplete = panes.length === 0;
      status = panes.length ? "Loading windows" : "No available panes";
      publish();
      if (target) {
        if (agent) selectedPane = target.semanticPaneId;
        await openPane(target, token, !agent, undefined, agent ? current : undefined);
      }
      if (current()) startAgents();
    })
    .catch(() => {
      if (!current()) return;
      inputReady = false;
      sessionHistory.cancel();
      sessionTabs.cancel();
      status = "Fleet session unavailable — return Home and select it again";
      publish();
    });
}

function publish() {
  workspaceFleetAgents.sync(
    request,
    catalog ?? null,
    !stopped && foreground && surface === "workspace" && selectedSession !== null,
    fleet,
    (row) => {
      const pane = panes.find(
        (pane) => pane.semanticPaneId === selectedPane && pane.liveSessionId === selectedSession,
      );
      return !!pane && !!fleet?.isSelectedAgent(row, pane);
    },
  );
  const preferenceState = fleet?.preferenceSnapshot();
  if (preferenceState?.phase === "ready" && preferenceState.state)
    sessionHistory.seed(preferenceState.state.recent);
  acceptSessionVisit?.();
  const wantTabs = !!fleet && foreground && !stopped && sessionTabs.keys().length > 0;
  if (wantTabs && !observingTabs) {
    observingTabs = true;
    stopTabObservation = fleet!.observeAgents(() => {
      let changed = false;
      for (const key of sessionTabs.keys())
        changed = sessionTabs.observe(key, fleet?.tabObservation(key) ?? null) || changed;
      if (changed) publish();
    });
  } else if (!wantTabs && observingTabs) {
    observingTabs = false;
    const stop = stopTabObservation;
    stopTabObservation = undefined;
    stop?.();
    for (const key of sessionTabs.keys()) sessionTabs.observe(key, null);
  }
  const tabPublication = sessionTabs.publication(
    request,
    !!fleet,
    (key) => fleet?.retainedTarget(key) ?? null,
  );
  const historyPublication = sessionHistory.publication(
    request,
    !!fleet && !!preferenceState?.state,
  );
  // A session may remain selectable beyond the server display cap, but Home
  // must not offer creation without a visible exact destination.
  if (surface === "home" && homePhase === "live" && selectedFleet && !fleet?.selectedServer()) {
    homePhase = "unavailable";
    status = "Selected server is not available in this fleet view — select a server again.";
  }
  // Terminal-free navigation surfaces apply presence locally. Interactive helpers
  // retain ACK ownership even while their snapshot or input grant is unavailable.
  if (
    !active &&
    (surface === "home" ||
      (surface === "workspace" &&
        catalog &&
        selectedSession !== null &&
        sessionCatalogComplete &&
        selectedPane === null &&
        snapshot === null &&
        !inputReady))
  )
    appliedPresenceRevision = presenceRevision;
  if (stopped) return;
  const line =
    JSON.stringify({
      version: 1,
      connection,
      sequence: ++sequence,
      request,
      sessions,
      surface,
      home: { phase: homePhase },
      createSession: selectedFleet && !fleet?.selectedServer() ? null : sessionCreate.publication(),
      selectedServer:
        surface === "home" && homePhase === "live" && selectedFleet
          ? (fleet?.selectedServer() ?? null)
          : null,
      homeAgents: surface === "home" ? agentPublication : null,
      homeAgentRecovery: surface === "home" && fleet ? homeRecovery.publication() : null,
      homeAgentFilter: surface === "home" && fleet ? homeAgentFilter : null,
      // Protocol support; private hosts publish an explicit unavailable roster.
      sessionHistory: historyPublication,
      sessionHistoryRejected,
      paletteSupported: !!fleet,
      paletteAgents: palette.publication(),
      paletteSelectionRejected,
      attentionSupported: true,
      attentionAgents: attention.publication(),
      attentionSelectionRejected,
      sessionTabs: tabPublication,
      sessionTabResult,
      workspaceFleetAgents: workspaceFleetAgents.publication(),
      workspaceFleetAgentRejected,
      workspaceAgents:
        surface === "workspace" && selectedSession && agentPublication
          ? { ...agentPublication, sessionId: selectedSession }
          : null,
      panes: paneChoices(
        panes.map((p) => p.semanticPaneId),
        layouts,
      ),
      sessionCatalogComplete,
      preferredPane: foreground && sessionCatalogComplete ? initialPane : null,
      selectedSession,
      selectedPane,
      status: historySaveFailed
        ? `${status} — Session visit could not be saved; refresh local preferences.`
        : inputReady && editorMessage?.request === request && editorMessage.id === selectedPane
          ? editorMessage.text
          : surface === "home" && machineMessage
            ? `${status} · ${machineMessage}`
            : status,
      snapshot,
      historyOffset: snapshot && selectedPane ? historyOffset : 0,
      copyRegion: snapshot ? copyRegion : null,
      regions: snapshot ? regions : [],
      inputReady,
      resizeToken: inputReady && snapshot ? resizeToken : null,
      splitLayout: inputReady && snapshot ? splitLayout : null,
      splitGesture,
      resizeGestureSupported: !!active && resizeGestureSupported,
      resizeGesture: resizeGesture
        ? { ...resizeGesture, token: inputReady && snapshot ? resizeGesture.token : null }
        : null,
      paneActions: inputReady && snapshot ? paneActions : null,
      presenceRevision: appliedPresenceRevision,
      appearance: appearance.publication(),
      fleet: fleet?.publication() ?? null,
      machines: machines ? { ...machines.publication(), message: machineMessage } : null,
    }) + "\n";
  if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("Browser publication too large");
  if (blocked) pending = line;
  else blocked = !process.stdout.write(line);
}
process.stdout.on("drain", () => {
  blocked = false;
  if (pending) {
    const line = pending;
    pending = null;
    blocked = !process.stdout.write(line);
  }
});
async function retire() {
  attentionSelectionRejected = null;
  paletteSelectionRejected = null;
  attention.cancel();
  palette.cancel();
  const old = active;
  active = undefined;
  pendingPaneSplit = null;
  pendingNewWindow = null;
  pendingClose = null;
  splitLayout = null;
  splitGesture = null;
  activeSplitGesture = null;
  resizeGestureSupported = false;
  resizeGesture = null;
  activeGesture = null;
  if (!old) return;
  old.child.kill("SIGTERM");
  const timer = setTimeout(() => old.child.kill("SIGKILL"), 500);
  try {
    await old.done;
  } finally {
    clearTimeout(timer);
  }
}
function retireMachineRoute() {
  if (stopped) return;
  recoverTerminal("machine-route-retired");
  sessionHistory.cancel();
  sessionTabs.cancel();
  machineRouteRevision++;
  retireAgents();
  catalog?.dispose();
  catalog = undefined;
  sessions = [];
  panes = [];
  layouts = [];
  selectedSession = null;
  selectedPane = null;
  initialPane = null;
  sessionCatalogComplete = false;
  inputReady = false;
  snapshot = null;
  paneActions = null;
  homePhase = "unavailable";
  status = recoveryTarget
    ? "Reconnecting terminal"
    : "Machine connection changed — refresh sessions to reconnect";
  void retire();
  publish();
}
async function stop() {
  if (stopped) return;
  cancelTerminalRecovery();
  sessionHistory.cancel();
  sessionTabs.cancel();
  acceptSessionVisit = null;
  stopped = true;
  stopTabObservation?.();
  stopTabObservation = undefined;
  observingTabs = false;
  sessionTabs.dispose();
  workspaceFleetAgents.cancel();
  hostSource?.dispose();
  machines?.dispose();
  fleet?.dispose();
  retireAgents();
  catalog?.dispose();
  await retire();
  process.stdin.destroy();
  process.stdout.end();
}
function requestShutdown() {
  shutdownRequested = true;
  void stop();
}
process.on("SIGINT", requestShutdown);
process.on("SIGTERM", requestShutdown);
process.stdout.on("error", () => void stop());
async function refresh(token: number, requiredCurrent: () => boolean = () => true) {
  const routeRevision = machineRouteRevision;
  catalog?.dispose();
  catalog = undefined;
  const discovered = await readHost();
  if (stopped || request !== token || routeRevision !== machineRouteRevision || !requiredCurrent())
    return;
  const fresh = createPreviewCatalog(discovered);
  sessionCreate.reset();
  catalog = fresh;
  const list = await fresh.sessions();
  if (stopped || request !== token || catalog !== fresh || !requiredCurrent()) return;
  if (selectedFleet && !fleet?.selectedServer()) throw new FleetSelectionError();
  if (list.length > 512) throw new Error("Too many sessions for preview");
  sessions = list.map(sessionChoice);
  homePhase = "live";
  startAgents();
  status = sessions.length ? "Choose a session" : "No live sessions";
  publish();
}
async function openPane(
  config: z.infer<typeof connectionSchema>,
  token: number,
  catalogOnly = false,
  splitConfirmation?: {
    window: string;
    createdPane: string;
    current: () => boolean;
    originalPane?: string;
  },
  requiredCurrent?: () => boolean,
  closeConfirmation?: { killed: string; current: () => boolean },
  recoveryNotice?: string,
) {
  const admissionPresence = presenceRevision;
  const owningCatalog = catalog;
  const directory = await mkdtemp(join(tmpdir(), "tmux-gpui-pane-"));
  let handedOff = false;
  const presentation = createWindowPresentation(config.semanticPaneId);
  try {
    const path = join(directory, "connection.json");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    if (
      stopped ||
      token !== request ||
      !owningCatalog ||
      catalog !== owningCatalog ||
      (requiredCurrent && !requiredCurrent())
    )
      return;
    const child = spawn(
      process.execPath,
      [
        ...(import.meta.url.endsWith(".bundle.mjs") ? [] : ["--import", "tsx"]),
        fileURLToPath(
          new URL(
            import.meta.url.endsWith(".bundle.mjs") ? "live.bundle.mjs" : "live.ts",
            import.meta.url,
          ),
        ),
        path,
        catalogOnly ? "--catalog" : "--interactive",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const done = new Promise<void>((resolve) =>
      child.once("close", () => {
        void rm(directory, { recursive: true, force: true })
          .catch(() => {
            process.stderr.write("Could not remove private preview state\n");
            process.exitCode = 1;
          })
          .finally(resolve);
      }),
    );
    child.stdin.on("error", () => {
      if (active?.child !== child) return;
      inputReady = false;
      void retire();
    });
    active = { child, done, catalogOnly, presentation };
    if (!catalogOnly)
      child.stdin.write(
        JSON.stringify({ kind: "presence", active: foreground, revision: presenceRevision }) + "\n",
      );
    handedOff = true;
    let buffer = Buffer.alloc(0),
      childConnection: string | undefined,
      childSequence = 0;
    let childPresentationEpoch: number | undefined;
    const diagnostics = createDiagnosticChannel((fault) => {
      if (stopped || request !== token || active?.child !== child) return;
      process.stderr.write(`TMUX_GPUI_DIAGNOSTIC ${JSON.stringify(fault)}\n`);
      unavailable();
      if (fault.code === "transport-closed" || fault.code === "transport-error")
        recoverTerminal(fault.code);
    });
    const unavailable = () => {
      if (stopped || request !== token || active?.child !== child) return;
      if (pendingClose?.submitted) {
        snapshot = null;
        inputReady = false;
        status = "Closing pane";
        publish();
        return;
      }
      sessionHistory.cancel();
      sessionTabs.cancel();
      attention.cancel();
      palette.cancel();
      retireAgents();
      snapshot = null;
      inputReady = false;
      initialPane = null;
      if (catalogOnly) sessionCatalogComplete = true;
      status = diagnostics.fault
        ? diagnosticStatus(diagnostics.fault)
        : catalogOnly
          ? "Session layout unavailable — refresh, then select the session again"
          : "Pane unavailable — select again or refresh";
      publish();
    };
    child.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk));
    child.on("error", unavailable);
    child.on("exit", unavailable);
    child.stdout.on("data", (chunk: Buffer) => {
      // Fatal helper diagnostics retire this presentation lifetime. Buffered
      // stdout must not restore a frame or input authority after that fault.
      if (stopped || request !== token || active?.child !== child || diagnostics.fault) return;
      let publicationStage = "framing";
      try {
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          publicationStage = "framing";
          if (end > MAX_FRAME) throw new Error("Oversized child publication");
          publicationStage = "decode";
          const event = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          buffer = buffer.subarray(end + 1);
          publicationStage = "envelope";
          if (
            typeof event.connection !== "string" ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence <= childSequence ||
            (childConnection && event.connection !== childConnection)
          )
            throw new Error("Invalid child publication");
          publicationStage = "topology";
          childConnection = event.connection;
          childSequence = event.sequence;
          layouts = topologySchema.parse(event.layouts ?? []);
          if (catalogOnly) {
            if (event.catalogReady !== true) throw new Error("Layout catalog unavailable");
            if (closeConfirmation) {
              if (
                !closeConfirmation.current() ||
                !confirmsClosedPane(
                  layouts.flatMap((l) =>
                    l.panes.map((p) => p.pane).filter((id): id is string => !!id),
                  ),
                  closeConfirmation.killed,
                )
              )
                throw new Error("Closed pane still present");
              const preferred = preferredPane(
                panes.map((p) => p.semanticPaneId),
                layouts,
              );
              const survivor = panes.find((p) => p.semanticPaneId === preferred);
              if (survivor) {
                void retire()
                  .then(async () => {
                    if (!closeConfirmation.current()) return;
                    selectedPane = survivor.semanticPaneId;
                    await openPane(survivor, token, false, undefined, closeConfirmation.current);
                  })
                  .catch(() => {
                    if (closeConfirmation.current()) {
                      snapshot = null;
                      inputReady = false;
                      status = "Pane closed; survivor unavailable — refresh";
                      publish();
                    }
                  });
                return;
              }
            }
            if (splitConfirmation) {
              const matching = layouts.filter(
                (layout) => layout.semanticWindowId === splitConfirmation.window,
              );
              if (
                splitConfirmation.originalPane
                  ? !confirmsNewWindow(
                      layouts,
                      splitConfirmation.originalPane,
                      splitConfirmation.window,
                      splitConfirmation.createdPane,
                    )
                  : matching.length !== 1 ||
                    !matching[0].panes.some((pane) => pane.pane === config.semanticPaneId) ||
                    !matching[0].panes.some((pane) => pane.pane === splitConfirmation.createdPane)
              )
                throw new Error("Split layout did not confirm both panes");
              void retire()
                .then(async () => {
                  if (!splitConfirmation.current()) return;
                  await openPane(config, token, false, undefined, splitConfirmation.current);
                })
                .catch(() => {
                  if (splitConfirmation.current()) {
                    snapshot = null;
                    inputReady = false;
                    status = "Split applied; pane unavailable — refresh";
                    publish();
                  }
                });
              return;
            }
            snapshot = null;
            inputReady = false;
            sessionCatalogComplete = true;
            initialPane = preferredPane(
              panes.map((pane) => pane.semanticPaneId),
              layouts,
            );
            const historyKey =
              foreground && admissionPresence === presenceRevision
                ? fleet?.attachmentKey(config)
                : null;
            if (historyKey) {
              sessionHistory.catalogReady(token, historyKey, owningCatalog, presenceRevision);
              sessionTabs.catalogReady(token, historyKey, owningCatalog, presenceRevision);
            }
            status = "Choose a pane or window";
            // retire clears active synchronously; publish only after this metadata
            // helper releases ACK ownership, without waiting for process reaping.
            void retire();
            publish();
            return;
          }
          if (event.closePaneReady && pendingClose && !pendingClose.submitted) {
            const ready = z
              .object({
                token: z.string().uuid(),
                id: z.string().min(1).max(512),
                hostClientId: z
                  .string()
                  .refine(
                    (value) =>
                      value.startsWith("gpui:") &&
                      z.string().uuid().safeParse(value.slice(5)).success,
                  ),
                presenceRevision: z.number().int().nonnegative().safe(),
              })
              .strict()
              .parse(event.closePaneReady);
            if (
              ready.token !== pendingClose.token ||
              ready.id !== pendingClose.id ||
              ready.id !== config.semanticPaneId ||
              ready.presenceRevision !== pendingClose.presenceRevision ||
              presenceRevision !== ready.presenceRevision ||
              !foreground ||
              !catalog ||
              !selectedSession ||
              event.inputReady !== true
            )
              throw new Error("Close target retired");
            pendingClose.submitted = true;
            const host = catalog,
              session = selectedSession,
              killed = ready.id;
            const current = splitRefreshGuard(() => ({
              request,
              session: selectedSession,
              catalog,
              presenceRevision,
              foreground,
              stopped,
            }));
            snapshot = null;
            inputReady = false;
            paneActions = null;
            status = "Closing pane";
            publish();
            void (async () => {
              if (
                !(await closePane({
                  current,
                  generation: config.scope.generation,
                  workspace: config.workspaceName,
                  pane: killed,
                  submit: (operation) =>
                    host.closePane(
                      operation,
                      config.workspaceName,
                      session,
                      killed,
                      ready.hostClientId,
                    ),
                }))
              )
                return;
              await retire();
              if (!current()) return;
              const freshSessions = (await host.sessions()).map(sessionChoice);
              if (!current()) return;
              if (freshSessions.length > 512) throw new Error("Session catalog exceeds limit");
              sessions = freshSessions;
              if (!freshSessions.some((s) => s.id === session)) {
                selectedPane = null;
                selectedSession = null;
                panes = [];
                layouts = [];
                surface = "home";
                homePhase = "live";
                status = "Session no longer available after pane close";
                snapshot = null;
                inputReady = false;
                publish();
                startAgents();
                return;
              }
              const choices = await host.workspacePanes(session, config.workspaceName);
              if (!current()) return;
              if (
                !confirmsClosedPane(
                  choices.map((p) => p.semanticPaneId),
                  killed,
                )
              )
                throw new Error("Pane close absence not confirmed");
              panes = choices;
              selectedPane = null;
              layouts = [];
              snapshot = null;
              inputReady = false;
              status = "Loading surviving panes";
              publish();
              if (choices[0])
                await openPane(choices[0], token, true, undefined, current, { killed, current });
              else {
                status = "No available panes — refresh";
                publish();
              }
            })().catch(async () => {
              if (!current()) return;
              await retire();
              if (!current()) return;
              snapshot = null;
              inputReady = false;
              paneActions = null;
              status = "Pane close not confirmed — reselect pane or refresh";
              publish();
              // A failed response is not proof of refusal. Requalify only the exact
              // original semantic pane; never replay the mutation or pick a substitute.
              try {
                const choices = await host.workspacePanes(session, config.workspaceName);
                if (!current() || choices.length > 512) return;
                const matches = choices.filter((pane) => pane.semanticPaneId === killed);
                if (matches.length !== 1) return;
                panes = choices;
                layouts = [];
                selectedPane = killed;
                await openPane(
                  matches[0],
                  token,
                  false,
                  undefined,
                  current,
                  undefined,
                  "Close not confirmed — original pane reconnected",
                );
              } catch {
                // Keep the explicit unavailable state if exact requalification fails.
              }
            });
            return;
          }
          if (
            event.newWindowReceipt &&
            pendingNewWindow &&
            event.newWindowReceipt.token === pendingNewWindow.token
          ) {
            const captured = pendingNewWindow;
            const receipt = z
              .object({ token: z.string().uuid(), result: newWindowReceiptSchema })
              .strict()
              .parse(event.newWindowReceipt);
            if (
              receipt.result.daemonInstanceId !== config.scope.generation ||
              receipt.result.resource.workspaceName !== config.workspaceName ||
              !matchesCreation(receipt.result.resource, captured.agent) ||
              receipt.result.outcome !== "created" ||
              receipt.result.resource.semanticPaneId === config.semanticPaneId
            )
              throw new Error("Invalid new window receipt");
            if (
              !catalog ||
              !selectedSession ||
              !foreground ||
              presenceRevision !== captured.presenceRevision
            )
              throw new Error("New window target retired");
            const host = catalog,
              session = selectedSession;
            pendingNewWindow = null;
            pendingClose = null;
            snapshot = null;
            inputReady = false;
            paneActions = null;
            status = captured.agent ? "Loading new agent window" : "Loading new terminal window";
            publish();
            const current = splitRefreshGuard(() => ({
              request,
              session: selectedSession,
              catalog,
              presenceRevision,
              foreground,
              stopped,
            }));
            void refreshSplitInventory({
              current,
              originalPane: config.semanticPaneId,
              createdPane: receipt.result.resource.semanticPaneId,
              retire,
              read: () => host.workspacePanes(session, config.workspaceName),
              selectedSession: session,
              readSessions: async () => (await host.sessions()).map(sessionChoice),
              attach: async (_original, choices, freshSessions) => {
                const created = choices.find(
                  (p) => p.semanticPaneId === receipt.result.resource.semanticPaneId,
                );
                if (!created) throw new Error("Created window unavailable");
                sessions = freshSessions;
                panes = choices;
                selectedPane = created.semanticPaneId;
                await openPane(
                  created,
                  token,
                  true,
                  {
                    window: captured.window,
                    createdPane: created.semanticPaneId,
                    originalPane: config.semanticPaneId,
                    current,
                  },
                  current,
                );
              },
            }).catch((error: unknown) => {
              if (current()) {
                // Fixed stage only; do not expose raw transport/configuration errors.
                console.error(
                  JSON.stringify({
                    stage: "new-window-refresh-failed",
                    refreshStage: error instanceof SplitRefreshError ? error.stage : "unknown",
                    catalog: error instanceof SplitRefreshError ? error.catalog : undefined,
                  }),
                );
                snapshot = null;
                inputReady = false;
                status = "New window created; pane unavailable — refresh";
                publish();
              }
            });
            return;
          }
          if (
            event.paneSplitReceipt &&
            pendingPaneSplit &&
            event.paneSplitReceipt.token === pendingPaneSplit.token
          ) {
            const split = pendingPaneSplit;
            const receipt = z
              .object({ token: z.string().uuid(), result: WorkspaceWindowSplitResultSchemaZ })
              .strict()
              .parse(event.paneSplitReceipt);
            if (
              receipt.token !== split.token ||
              receipt.result.direction !== split.direction ||
              receipt.result.daemonInstanceId !== config.scope.generation ||
              receipt.result.workspaceName !== config.workspaceName ||
              receipt.result.outcome !== "applied" ||
              receipt.result.semanticPaneId === config.semanticPaneId
            )
              throw new Error("Invalid split receipt");
            const window = split.window;
            if (
              !window ||
              !catalog ||
              !selectedSession ||
              !foreground ||
              presenceRevision !== split.presenceRevision
            )
              throw new Error("Split target retired");
            const host = catalog,
              session = selectedSession;
            pendingPaneSplit = null;
            pendingNewWindow = null;
            pendingClose = null;
            snapshot = null;
            inputReady = false;
            paneActions = null;
            status = "Loading split layout";
            publish();
            const current = splitRefreshGuard(() => ({
              request,
              session: selectedSession,
              catalog,
              presenceRevision,
              foreground,
              stopped,
            }));
            void refreshSplitInventory({
              current,
              originalPane: config.semanticPaneId,
              createdPane: receipt.result.semanticPaneId,
              retire,
              read: () => host.workspacePanes(session, config.workspaceName),
              selectedSession: session,
              readSessions: async () => (await host.sessions()).map(sessionChoice),
              attach: async (original, choices, freshSessions) => {
                sessions = freshSessions;
                panes = choices;
                await openPane(
                  original,
                  token,
                  true,
                  {
                    window,
                    createdPane: receipt.result.semanticPaneId,
                    current,
                  },
                  current,
                );
              },
            }).catch(() => {
              if (current()) {
                snapshot = null;
                inputReady = false;
                status = "Split applied; pane unavailable — refresh";
                publish();
              }
            });
            return;
          }
          publicationStage = "epoch";
          const epoch = z.number().int().nonnegative().safe().parse(event.presentationEpoch);
          if (childPresentationEpoch !== epoch) presentation.update(undefined, [], false);
          childPresentationEpoch = epoch;
          const layout = layouts.find((l) => l.panes.some((p) => p.pane === config.semanticPaneId));
          publicationStage = "surfaces";
          const surfaces = surfacesSchema.parse(event.surfaces ?? []);
          const scrollOffset = z
            .number()
            .int()
            .min(0)
            .max(1000)
            .parse(event.scrollOffset ?? 0);
          appliedPresenceRevision = event.presenceRevision;
          const hasAuthority =
            !pendingClose &&
            foreground &&
            appliedPresenceRevision === presenceRevision &&
            event.inputReady === true &&
            scrollOffset === 0;
          publicationStage = "presentation";
          const coherent = presentation.update(
            event.snapshot ? layout : undefined,
            surfaces,
            hasAuthority,
          );
          snapshot = coherent?.snapshot ?? null;
          historyOffset = snapshot ? scrollOffset : 0;
          copyRegion = coherent?.copyRegion ?? null;
          regions = coherent?.regions ?? [];
          inputReady = hasAuthority && !!snapshot;
          publicationStage = "resize-token";
          resizeToken = resizePresentationMatches(layout, coherent?.regions ?? [])
            ? z
                .string()
                .uuid()
                .nullable()
                .parse(event.resizeToken ?? null)
            : null;
          publicationStage = "split-layout";
          const offeredSplit = WindowSplitLayoutResourceSchemaZ.nullable().parse(
            event.splitLayout ?? null,
          );
          splitLayout =
            hasAuthority &&
            layout &&
            offeredSplit &&
            splitLayoutMatches(offeredSplit, layout) &&
            resizePresentationMatches(layout, coherent?.regions ?? [])
              ? offeredSplit
              : null;
          publicationStage = "split-gesture";
          const offeredSplitGesture = splitGesturePublicationSchema
            .nullable()
            .parse(event.splitGesture ?? null);
          splitGesture =
            offeredSplitGesture?.gesture === activeSplitGesture ? offeredSplitGesture : null;
          resizeGestureSupported = event.resizeGestureSupported === true;
          publicationStage = "resize-gesture";
          const offeredGesture = resizeGesturePublicationSchema
            .nullable()
            .parse(event.resizeGesture ?? null);
          resizeGesture =
            offeredGesture &&
            activeGesture?.gesture === offeredGesture.gesture &&
            activeGesture.id === offeredGesture.id &&
            activeGesture.axis === offeredGesture.axis
              ? {
                  ...offeredGesture,
                  token:
                    hasAuthority && resizeToken === offeredGesture.token
                      ? offeredGesture.token
                      : null,
                }
              : null;
          publicationStage = "pane-actions";
          const offeredActions = paneActionsSchema.nullable().parse(event.paneActions ?? null);
          const geometryMatches =
            !!layout &&
            layout.panes.length === (coherent?.regions.length ?? 0) &&
            layout.panes.every((pane) =>
              coherent?.regions.some(
                (r) =>
                  r.id === pane.pane &&
                  r.left === pane.left &&
                  r.top === pane.top &&
                  r.width === pane.width &&
                  r.height === pane.height,
              ),
            );
          paneActions =
            inputReady &&
            geometryMatches &&
            offeredActions?.id === config.semanticPaneId &&
            offeredActions.zoomed === layout?.zoomed
              ? offeredActions
              : null;
          status =
            recoveryNotice && inputReady
              ? recoveryNotice
              : event.paneActionError === "Pane action unavailable — reselect pane to retry"
                ? event.paneActionError
                : snapshot && scrollOffset > 0
                  ? `History: ${scrollOffset} lines above live — Shift-End returns to live`
                  : snapshot
                    ? inputReady
                      ? event.resizeBlocked === true
                        ? "Resize unavailable — reselect pane to retry"
                        : "Keyboard ready — click terminal to type"
                      : !foreground
                        ? "Window inactive — activate tmux-ide to type"
                        : "Waiting for input authority"
                    : diagnostics.fault
                      ? diagnosticStatus(diagnostics.fault)
                      : "Pane unavailable — select again or refresh";
          if (!catalogOnly)
            acceptSessionVisit = () => {
              if (
                !inputReady ||
                !snapshot ||
                scrollOffset !== 0 ||
                !foreground ||
                stopped ||
                active?.child !== child ||
                token !== request ||
                catalog !== owningCatalog ||
                admissionPresence !== presenceRevision ||
                selectedPane !== config.semanticPaneId ||
                selectedSession !== config.liveSessionId
              )
                return;
              const key = fleet?.attachmentKey(config);
              if (!key) return;
              if (
                !recoveryTarget ||
                recoveryTarget.request !== token ||
                recoveryTarget.pane !== config.semanticPaneId
              ) {
                const resolve = fleet?.recoveryRoute(key);
                if (resolve)
                  recoveryTarget = { resolve, key, pane: config.semanticPaneId, request: token };
              }
              const tabTarget = fleet?.retainedTarget(key);
              if (tabTarget) sessionTabs.accept(token, tabTarget);
              const visit = sessionHistory.accept(token, key),
                owner = fleet;
              if (visit && owner)
                void owner.recordVisit(visit.key).then((saved) => {
                  if (stopped || fleet !== owner) return;
                  historySaveFailed = !saved;
                  publish();
                });
            };
          publicationStage = "publish";
          publish();
        }
        publicationStage = "framing";
        if (buffer.length > MAX_FRAME) throw new Error("Oversized child publication");
      } catch {
        // Fixed stage metadata only: never log terminal contents or connection credentials.
        console.error(
          JSON.stringify({ diagnostic: "child-publication-rejected", stage: publicationStage }),
        );
        unavailable();
        void retire();
      }
    });
  } finally {
    if (!handedOff) await rm(directory, { recursive: true, force: true });
  }
}
async function command(value: unknown) {
  const cmd = commandSchema.parse(value);
  if (cmd.type === "home-agent-filter") {
    if (stopped || !fleet) return;
    applyHomeAgentFilter(
      cmd,
      { request, revision: agentPublication?.revision, home: surface === "home", foreground },
      fleet.filterHomeAgents,
    );
    publish();
    return;
  }
  if (cmd.type === "home-agent-recovery") {
    if (stopped || !fleet) return;
    homeRecovery.command(cmd, { request, home: surface === "home", foreground }, (action) =>
      fleet?.recoverAgents(action),
    );
    publish();
    return;
  }
  if (cmd.type === "fleet-preference") {
    if (stopped || !foreground || cmd.request !== request || !fleet) return;
    // Keep presence/navigation responsive while the local daemon acknowledges.
    void fleet.preferenceCommand(cmd, { request, foreground }).finally(() => {
      if (!stopped) publish();
    });
    return;
  }
  if (cmd.type === "fleet-retry" || cmd.type === "fleet-disconnect") {
    if (stopped || !foreground || cmd.request !== request || !fleet) return;
    try {
      if (cmd.type === "fleet-retry") fleet.retry(cmd.retry);
      else {
        cancelTerminalRecovery();
        fleet.disconnect(cmd.disconnect);
      }
    } catch {
      /* Stale displayed connections cannot operate on replacement routes. */
    }
    publish();
    return;
  }
  if (cmd.type === "machines") {
    if (stopped || !foreground || cmd.request !== request) return;
    if (!machines) {
      machines = createNativeMachineRegistry(machinesChanged);
      machines.start();
    }
    machineMessage = null;
    if (cmd.operation === "read") {
      machines.refresh();
      publish();
      return;
    }
    const owner = machines;
    // Mutations target the canonical local registry, never the selected SSH host.
    // Keep stdin responsive; an uncertain response is reconciled, never replayed.
    const operation =
      cmd.operation === "save"
        ? owner.save(cmd.machine, cmd.revision)
        : owner.mutate(cmd.change, cmd.revision);
    void operation.catch((error) => {
      if (stopped || machines !== owner) return;
      machineMessage =
        error instanceof MachineRegistryError
          ? error.message
          : "Machine change unavailable — refresh saved machines";
      publish();
    });
    publish();
    return;
  }
  if (cmd.type === "create-session") {
    const owner = catalog;
    const token = request;
    const current = () =>
      !stopped &&
      request === token &&
      catalog === owner &&
      surface === "home" &&
      homePhase === "live" &&
      !active;
    if (!owner || !foreground || cmd.request !== token || !current()) return;
    const createPresence = presenceRevision;
    const createRoute = selectedFleet ? fleet : undefined;
    // Deliberately do not await: navigation/presence remain responsive while the
    // single mutation is pending; its captured request/catalog fence owns results.
    void sessionCreate.start({
      name: cmd.name,
      current,
      create: (operationId, name) => {
        const effectCurrent = () => current() && foreground && presenceRevision === createPresence;
        const create = () => owner.createSession(operationId, name);
        if (createRoute)
          return createOnFleetRoute(
            createRoute,
            () => fleet === createRoute && effectCurrent(),
            create,
          );
        if (!effectCurrent()) throw new FleetSelectionError();
        return create();
      },
      refresh: async () => {
        const list = await owner.sessions();
        if (!current()) return;
        if (list.length > 512) throw new Error("Too many sessions for preview");
        sessions = list.map(sessionChoice);
        startAgents();
        status = sessions.length ? "Choose a session" : "No live sessions";
      },
      changed: publish,
    });
    return;
  }
  if (cmd.type === "theme" || cmd.type === "appearance") {
    if (cmd.type === "theme") appearance.select(cmd.id);
    else appearance.setSystem(cmd.system);
    publish();
    return;
  }
  if (cmd.type === "presence") {
    active?.presentation.update(undefined, [], false);
    foreground = cmd.active;
    if (!foreground) {
      workspaceFleetAgents.cancel();
      sessionHistory.cancel();
      sessionTabs.cancel();
      attention.cancel();
      palette.cancel();
      initialPane = null;
      pendingPaneSplit = null;
      pendingNewWindow = null;
      pendingClose = null;
    }
    if (foreground) startAgents();
    else retireAgents();
    presenceRevision = cmd.revision;
    inputReady = false;
    paneActions = null;
    if (active?.child.stdin && !active.catalogOnly) {
      if (active.child.stdin.writableLength > MAX_INPUT_LINE * 2) {
        await retire();
        throw new Error("Presence queue full");
      }
      active.child.stdin.write(
        JSON.stringify({ kind: "presence", active: foreground, revision: presenceRevision }) + "\n",
      );
    }
    publish();
    return;
  }
  if (cmd.type === "open-editor") {
    const key = `${cmd.request}\0${cmd.id}\0${cmd.token}`;
    const owner = catalog;
    const pane = panes.find((candidate) => candidate.semanticPaneId === cmd.id);
    const session = selectedSession;
    const capturedPresence = presenceRevision;
    const helper = active;
    const current = () =>
      !stopped &&
      catalog === owner &&
      active === helper &&
      surface === "workspace" &&
      request === cmd.request &&
      selectedSession === session &&
      selectedPane === cmd.id &&
      paneActions?.id === cmd.id &&
      paneActions.token === cmd.token &&
      foreground &&
      presenceRevision === capturedPresence &&
      inputReady &&
      snapshot !== null;
    if (editorPending || editorConsumed === key || !owner || !pane || !session || !current())
      return;
    editorPending = true;
    editorConsumed = key;
    status = "Opening selected pane folder in VS Code";
    editorMessage = { request: cmd.request, id: cmd.id, text: status };
    publish();
    // Do not block stdin: presence/navigation must be able to revoke an in-flight read.
    void openSelectedPaneEditor({
      proof: owner.localProof,
      current,
      read: (signal) => owner.paneEditorContext(pane.workspaceName, session, cmd.id, signal),
    })
      .then((message) => {
        if (current()) {
          status = message;
          editorMessage = { request: cmd.request, id: cmd.id, text: message };
          publish();
        }
      })
      .finally(() => {
        editorPending = false;
      });
    return;
  }
  if (cmd.type === "pane-action") {
    editorMessage = null;
    if (
      surface !== "workspace" ||
      cmd.request !== request ||
      cmd.id !== selectedPane ||
      cmd.id !== paneActions?.id ||
      cmd.token !== paneActions.token ||
      !inputReady ||
      !foreground ||
      !snapshot ||
      !active?.child.stdin
    )
      return;
    const line = JSON.stringify(cmd) + "\n";
    if (
      Buffer.byteLength(line) > MAX_INPUT_LINE ||
      active.child.stdin.writableLength > MAX_INPUT_LINE * 2
    )
      throw new Error("Pane action queue full");
    paneActions = null;
    if (cmd.action === "close")
      pendingClose = { token: cmd.token, id: cmd.id, presenceRevision, submitted: false };
    if (cmd.action === "split" || cmd.action === "new-window" || cmd.action === "new-agent") {
      const window = layouts.find((layout) =>
        layout.panes.some((pane) => pane.pane === cmd.id),
      )?.semanticWindowId;
      if (!window) throw new Error("Split window unavailable");
      if (cmd.action === "split") pendingPaneSplit = { ...cmd, window, presenceRevision };
      else
        pendingNewWindow = {
          token: cmd.token,
          window,
          presenceRevision,
          ...(cmd.action === "new-agent"
            ? { agent: { name: cmd.name, harness: cmd.harness } }
            : {}),
        };
    }
    publish();
    active.child.stdin.write(line);
    return;
  }
  if (cmd.type === "split-gesture") {
    if (surface !== "workspace" || cmd.request !== request || !active?.child.stdin) return;
    if (cmd.phase === "begin") {
      if (
        !foreground ||
        !inputReady ||
        !snapshot ||
        !splitLayout ||
        cmd.target.layoutId !== splitLayout.layoutId ||
        JSON.stringify(cmd.target.window) !== JSON.stringify(splitLayout.window) ||
        !splitLayout.splits.some(
          (split) =>
            split.splitId === cmd.target.splitId &&
            split.axis === cmd.axis &&
            split.boundary === cmd.target.boundary,
        ) ||
        (activeSplitGesture &&
          (!splitGesture || ["dragging", "pending"].includes(splitGesture.phase))) ||
        (activeGesture && (!resizeGesture || ["dragging", "pending"].includes(resizeGesture.phase)))
      )
        return;
      activeSplitGesture = cmd.gesture;
    } else if (cmd.gesture !== activeSplitGesture || (!foreground && cmd.phase !== "cancel"))
      return;
    if (active.child.stdin.writableLength > MAX_INPUT_LINE * 2)
      throw new Error("Split gesture queue full");
    active.child.stdin.write(JSON.stringify(cmd) + "\n");
    return;
  }
  if (cmd.type === "resize-gesture") {
    if (
      surface !== "workspace" ||
      cmd.request !== request ||
      !active?.child.stdin ||
      !resizeGestureSupported
    )
      return;
    if (cmd.phase === "begin") {
      if (
        activeSplitGesture &&
        (!splitGesture || ["dragging", "pending"].includes(splitGesture.phase))
      )
        return;
      if (
        !inputReady ||
        !foreground ||
        !snapshot ||
        cmd.token !== resizeToken ||
        !regions.some(
          (region) =>
            typeof region === "object" && region !== null && "id" in region && region.id === cmd.id,
        )
      )
        return;
      if (
        activeGesture &&
        (!resizeGesture || ["dragging", "pending"].includes(resizeGesture.phase))
      )
        return;
      activeGesture = { gesture: cmd.gesture, id: cmd.id, axis: cmd.axis, request: cmd.request };
    } else if (
      !activeGesture ||
      activeGesture.gesture !== cmd.gesture ||
      activeGesture.id !== cmd.id ||
      activeGesture.axis !== cmd.axis ||
      (!foreground && cmd.phase !== "cancel")
    )
      return;
    if (active.child.stdin.writableLength > MAX_INPUT_LINE * 2)
      throw new Error("Resize gesture queue full");
    active.child.stdin.write(JSON.stringify(cmd) + "\n");
    return;
  }
  if (cmd.type === "resize-pane") {
    if (
      surface !== "workspace" ||
      cmd.request !== request ||
      cmd.token !== resizeToken ||
      !inputReady ||
      !foreground ||
      !snapshot ||
      !active?.child.stdin ||
      !regions.some(
        (region) =>
          typeof region === "object" && region !== null && "id" in region && region.id === cmd.id,
      )
    )
      return;
    if (active.child.stdin.writableLength > MAX_INPUT_LINE * 2)
      throw new Error("Resize queue full");
    active.child.stdin.write(JSON.stringify(cmd) + "\n");
    return;
  }
  if (cmd.type === "input") {
    if (
      cmd.request !== request ||
      cmd.id !== selectedPane ||
      (!inputReady &&
        cmd.input.kind !== "scroll" &&
        !(cmd.input.kind === "wheel" && historyOffset > 0)) ||
      !foreground ||
      !snapshot ||
      !active?.child.stdin
    )
      return; // Discard stale/focus-lost input, never reinterpret it for another pane.
    if (cmd.input.kind === "scroll" || cmd.input.kind === "wheel")
      active.presentation.update(undefined, [], false);
    const line = JSON.stringify(cmd.input) + "\n";
    if (
      Buffer.byteLength(line) > MAX_INPUT_LINE ||
      active.child.stdin.writableLength > MAX_INPUT_LINE * 2
    )
      throw new Error("Input queue full");
    active.child.stdin.write(line);
    return;
  }
  if (cmd.type === "open-workspace-fleet-agent") {
    if (!admitNavigationAttempt(cmd.request) || cmd.fromRequest !== request) return;
    const target = workspaceFleetAgents.resolve(
      cmd,
      request,
      foreground && !stopped && surface === "workspace",
      fleet,
    );
    if (!target) {
      workspaceFleetAgentRejected = {
        request: cmd.request,
        fromRequest: cmd.fromRequest,
        scope: cmd.scope,
        rosterRevision: cmd.rosterRevision,
        key: cmd.key,
      };
      publish();
      return;
    }
    workspaceFleetAgents.cancel();
    attention.cancel();
    palette.cancel();
    retireAgents();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    const token = request,
      capturedPresence = presenceRevision;
    const current = () =>
      !stopped && request === token && foreground && presenceRevision === capturedPresence;
    sessionCatalogComplete = false;
    initialPane = null;
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    paneActions = null;
    surface = "workspace";
    selectedSession = null;
    panes = [];
    layouts = [];
    status = "Loading agent";
    publish();
    await retire();
    if (!current()) return;
    launchFleetSelection(target.selection, token, target.row, current);
    return;
  }
  if (cmd.type === "session-tab") {
    if (!admitNavigationAttempt(cmd.request) || cmd.fromRequest !== request) return;
    const admitted = sessionTabs.admit(
      cmd,
      request,
      foreground && !stopped,
      (key) => fleet?.retainedTarget(key) ?? null,
    );
    if (!admitted) {
      sessionTabResult = {
        request: cmd.request,
        fromRequest: cmd.fromRequest,
        revision: cmd.revision,
        action: cmd.action,
        outcome: "rejected",
      };
      status = "That tab is unavailable or has changed — try again.";
      publish();
      return;
    }
    if (admitted.kind === "close" && !admitted.home) {
      sessionTabResult = {
        request: cmd.request,
        fromRequest: cmd.fromRequest,
        revision: cmd.revision,
        action: cmd.action,
        outcome: "closed",
      };
      publish();
      return;
    }
    attention.cancel();
    palette.cancel();
    workspaceFleetAgents.cancel();
    retireAgents();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    const token = request,
      capturedPresence = presenceRevision;
    const current = () =>
      !stopped && request === token && foreground && presenceRevision === capturedPresence;
    sessionCatalogComplete = false;
    initialPane = null;
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    paneActions = null;
    selectedSession = null;
    panes = [];
    layouts = [];
    surface = admitted.kind === "close" ? "home" : "workspace";
    if (admitted.kind === "close") {
      homePhase = "loading";
      sessions = [];
      selectedFleet = false;
      fleet?.clearSelection();
    }
    status = admitted.kind === "close" ? "Loading sessions" : "Loading retained session";
    publish();
    await retire();
    if (!current()) return;
    if (admitted.kind === "close") launchRefresh(token);
    else launchFleetSelection("", token, undefined, current, admitted.key);
    return;
  }
  if (cmd.type === "session-history") {
    if (!admitNavigationAttempt(cmd.request) || cmd.fromRequest !== request) return;
    const key = sessionHistory.admit(
      cmd,
      request,
      foreground && !stopped,
      (key) => fleet?.resolveCanonical(key) ?? false,
    );
    if (!key) {
      sessionHistoryRejected = {
        request: cmd.request,
        fromRequest: cmd.fromRequest,
        revision: cmd.revision,
        action: cmd.action,
      };
      publish();
      return;
    }
    attention.cancel();
    palette.cancel();
    retireAgents();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    const token = request,
      capturedPresence = presenceRevision;
    const current = () =>
      !stopped && request === token && foreground && presenceRevision === capturedPresence;
    sessionCatalogComplete = false;
    initialPane = null;
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    paneActions = null;
    surface = "workspace";
    selectedSession = null;
    panes = [];
    layouts = [];
    status = "Loading visited session";
    publish();
    await retire();
    if (!current()) return;
    launchFleetSelection("", token, undefined, current, key);
    return;
  }
  if (cmd.type === "palette-observe") {
    palette.observe(cmd, request, foreground && !stopped, fleet);
    return;
  }
  if (cmd.type === "open-palette-agent") {
    if (!admitNavigationAttempt(cmd.request) || !palette.admitAttempt(cmd.request, request)) return;
    const target = palette.resolve(cmd, request, foreground && !stopped, fleet);
    if (!target) {
      paletteSelectionRejected = {
        request: cmd.request,
        fromRequest: cmd.fromRequest,
        scope: cmd.scope,
      };
      publish();
      return;
    }
    attention.cancel();
    palette.cancel();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    const token = request;
    const capturedPresence = presenceRevision;
    const current = () =>
      !stopped &&
      token === request &&
      foreground &&
      capturedPresence === presenceRevision &&
      palette.latest(cmd.scope);
    retireAgents();
    sessionCatalogComplete = false;
    initialPane = null;
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    paneActions = null;
    surface = "workspace";
    selectedSession = null;
    panes = [];
    layouts = [];
    status = "Loading agent";
    paletteSelectionRejected = null;
    // Accepted navigation is published before any asynchronous retirement.
    publish();
    await retire();
    if (!current()) return;
    launchFleetSelection(target.selection, token, target.row, current);
    return;
  }
  if (cmd.type === "attention-observe") {
    attention.observe(cmd, request, foreground && !stopped, fleet);
    return;
  }
  if (cmd.type === "open-attention-agent") {
    if (!admitNavigationAttempt(cmd.request) || !attention.admitAttempt(cmd.request, request))
      return;
    const target = attention.resolve(cmd, request, foreground && !stopped, fleet);
    if (!target) {
      attentionSelectionRejected = {
        request: cmd.request,
        fromRequest: cmd.fromRequest,
        scope: cmd.scope,
      };
      publish();
      return;
    }
    attention.cancel();
    palette.cancel();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    const token = request;
    const capturedPresence = presenceRevision;
    const current = () =>
      !stopped &&
      token === request &&
      foreground &&
      capturedPresence === presenceRevision &&
      attention.latest(cmd.scope);
    retireAgents();
    sessionCatalogComplete = false;
    initialPane = null;
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    paneActions = null;
    surface = "workspace";
    selectedSession = null;
    panes = [];
    layouts = [];
    status = "Loading agent";
    attentionSelectionRejected = null;
    // Accepted navigation is published before any asynchronous retirement.
    publish();
    await retire();
    if (!current()) return;
    launchFleetSelection(target.selection, token, target.row, current);
    return;
  }
  if (cmd.type === "open-workspace-agent") {
    const host = catalog;
    const workspace = panes[0]?.workspaceName;
    const row = agentOwner?.getSnapshot().rows.find((row) => row.key === cmd.key);
    const valid =
      cmd.request > request &&
      cmd.fromRequest === request &&
      surface === "workspace" &&
      foreground &&
      selectedSession === cmd.sessionId &&
      row?.liveSessionId === cmd.sessionId &&
      agentPublication?.revision === cmd.rosterRevision &&
      agentPublication.rows.some((item) => item.key === cmd.key && item.available) &&
      row &&
      agentAvailable(row) &&
      agentOwner?.isCurrentTarget(row) &&
      host &&
      workspace;
    if (!admitNavigationAttempt(cmd.request)) throw new Error("Stale workspace agent command");
    attention.cancel();
    palette.cancel();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    sessionCatalogComplete = false;
    initialPane = null;
    const token = request;
    retireAgents();
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    paneActions = null;
    await retire();
    if (!valid || !host || !workspace || !row) throw new Error("Workspace agent is stale");
    const choices = await host.workspacePanes(cmd.sessionId, workspace);
    if (stopped || request !== token || catalog !== host || selectedSession !== cmd.sessionId)
      return;
    if (choices.length > 512) throw new Error("Too many panes for preview");
    const pane = choices.find((pane) => pane.semanticPaneId === row.paneId);
    if (!pane) throw new Error("Workspace agent pane unavailable");
    panes = choices;
    if (stopped || request !== token) return;
    selectedPane = pane.semanticPaneId;
    publish();
    await openPane(pane, token);
    if (!stopped && request === token) startAgents();
    return;
  }
  if (cmd.type === "open-agent" && fleet) {
    const target = fleet.resolveAgent(cmd.key);
    if (!admitNavigationAttempt(cmd.request)) throw new Error("Stale agent command");
    const valid =
      cmd.fromRequest === request &&
      surface === "home" &&
      foreground &&
      agentPublication?.revision === cmd.rosterRevision &&
      agentPublication.rows.some((row) => row.key === cmd.key && row.available) &&
      target;
    attention.cancel();
    palette.cancel();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    const token = request;
    const capturedPresence = presenceRevision;
    retireAgents();
    sessionCatalogComplete = false;
    initialPane = null;
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    paneActions = null;
    await retire();
    if (!valid || !target) throw new Error("Fleet agent selection is stale");
    if (stopped || token !== request || !foreground || capturedPresence !== presenceRevision)
      return;
    surface = "workspace";
    selectedSession = null;
    panes = [];
    layouts = [];
    status = "Loading agent";
    publish();
    launchFleetSelection(target.selection, token, target.row);
    return;
  }
  if (cmd.type === "open-agent") {
    const owner = agentOwner,
      host = catalog;
    const row = owner?.getSnapshot().rows.find((row) => row.key === cmd.key);
    const valid =
      cmd.request > request &&
      cmd.fromRequest === request &&
      surface === "home" &&
      foreground &&
      homePhase === "live" &&
      agentPublication?.revision === cmd.rosterRevision &&
      agentPublication.rows.some((item) => item.key === cmd.key && item.available) &&
      row &&
      agentAvailable(row) &&
      owner?.isCurrentTarget(row) &&
      host;
    if (!admitNavigationAttempt(cmd.request)) throw new Error("Stale agent command");
    attention.cancel();
    palette.cancel();
    request = cmd.request;
    sessionHistory.navigation(request);
    sessionTabs.navigation(request);
    sessionTabResult = null;
    sessionHistoryRejected = null;
    workspaceFleetAgentRejected = null;
    sessionCatalogComplete = false;
    initialPane = null;
    retireAgents();
    snapshot = null;
    inputReady = false;
    selectedPane = null;
    if (!valid || !row || !host) throw new Error("Agent selection is stale");
    const token = request;
    surface = "workspace";
    selectedSession = row.liveSessionId;
    panes = [];
    layouts = [];
    status = "Loading agent";
    publish();
    await retire();
    const choices = await host.panes(row.liveSessionId);
    if (stopped || request !== token || catalog !== host) return;
    if (choices.length > 512) throw new Error("Too many panes for preview");
    const pane = choices.find((pane) => pane.semanticPaneId === row.paneId);
    if (!pane) throw new Error("Agent pane is no longer available");
    panes = choices;
    selectedPane = pane.semanticPaneId;
    publish();
    await openPane(pane, token);
    if (!stopped && request === token) startAgents();
    return;
  }
  if (!admitNavigationAttempt(cmd.request)) throw new Error("Stale browser command");
  // The completed metadata helper has retired. Only its proved catalog and exact displayed pane may
  // carry a pending traversal into the newer interactive-child request.
  const continuationPane =
    cmd.type === "pane" && catalog && sessionCatalogComplete
      ? panes.find(
          (pane) => pane.semanticPaneId === cmd.id && pane.liveSessionId === selectedSession,
        )
      : undefined;
  const continuationKey =
    continuationPane && foreground ? fleet?.attachmentKey(continuationPane) : null;
  const historyContinuation = continuationKey
    ? { fromRequest: request, key: continuationKey, catalog: catalog!, presence: presenceRevision }
    : undefined;
  attention.cancel();
  palette.cancel();
  retireAgents();
  request = cmd.request;
  sessionHistory.navigation(request, historyContinuation);
  sessionTabs.navigation(request, historyContinuation);
  sessionTabResult = null;
  sessionHistoryRejected = null;
  workspaceFleetAgentRejected = null;
  sessionCatalogComplete = false;
  initialPane = null;
  const token = request;
  snapshot = null;
  inputReady = false;
  selectedPane = null;
  paneActions = null;
  status = "Loading";
  surface =
    cmd.type === "home" ||
    cmd.type === "refresh" ||
    cmd.type === "machine" ||
    cmd.type === "machine-profile" ||
    cmd.type === "fleet-server"
      ? "home"
      : "workspace";
  if (surface === "home") {
    homePhase = "loading";
    sessions = [];
  }
  if (cmd.type !== "pane") {
    layouts = [];
    panes = [];
    selectedSession = null;
  }
  publish();
  await retire();
  if (stopped || token !== request) return;
  if (cmd.type === "fleet-server") {
    const owner = fleet;
    if (!owner) throw new FleetSelectionError();
    selectedFleet = true;
    selectedMachineProfile = null;
    savedMachineRetired = false;
    const revision = ++machineRouteRevision;
    hostSource?.dispose();
    hostSource = undefined;
    catalog?.dispose();
    catalog = undefined;
    const presence = presenceRevision;
    const current = () =>
      !stopped &&
      request === token &&
      fleet === owner &&
      machineRouteRevision === revision &&
      foreground &&
      presenceRevision === presence;
    const retireSelection = () => {
      if (stopped || request !== token || fleet !== owner || machineRouteRevision !== revision)
        return;
      owner.clearSelection();
      catalog?.dispose();
      catalog = undefined;
      sessions = [];
      homePhase = "unavailable";
      status = "Server changed or selection cancelled — select the server again.";
      publish();
    };
    void completeFleetServerSelection({
      select: () => owner.selectServer(cmd.selection),
      refresh: (valid) => refresh(token, valid),
      current,
      retire: retireSelection,
    });
    return;
  }
  if (cmd.type === "fleet-session") {
    if (!fleet) throw new FleetSelectionError();
    launchFleetSelection(cmd.selection, token);
    return;
  }
  if (cmd.type === "home" || cmd.type === "machine" || cmd.type === "machine-profile") {
    selectedFleet = false;
    fleet?.clearSelection();
  }
  if (cmd.type === "machine" && cmd.sshTarget !== null) {
    cancelTerminalRecovery();
    selectedMachineProfile = null;
    savedMachineRetired = true;
    machineMessage = null;
    machineRouteRevision++;
    hostSource?.dispose();
    hostSource = undefined;
    catalog?.dispose();
    catalog = undefined;
    if (!machines) {
      machines = createNativeMachineRegistry(machinesChanged);
      machines.start();
    }
    const owner = machines;
    const current = () => !stopped && request === token && machines === owner;
    void prepareMachineConnection(owner, cmd.sshTarget, current)
      .then((result) => {
        if (!current() || !result) return;
        selectedMachineProfile = result.persisted ? result.profile : null;
        savedMachineRetired = false;
        machineMessage = result.persisted
          ? null
          : "Machine not saved locally — this connection attempt is temporary.";
        hostSource = createPreviewHostSource(process.argv[2]!, retireMachineRoute);
        hostSource.select(result.profile.sshTarget, result.profile.expectedEnvironmentId);
        launchRefresh(token);
      })
      .catch((error) => {
        if (!current()) return;
        homePhase = "unavailable";
        status =
          error instanceof MachineRegistryError
            ? error.message
            : "Could not add machine — refresh saved machines";
        publish();
      });
    return;
  }
  if (cmd.type === "machine" || cmd.type === "machine-profile") {
    machineMessage = null;
    // A refused selection must acknowledge the new request too, or the native
    // client (which already advanced its request) stays stuck on Loading.
    const savedProfile =
      cmd.type === "machine-profile" ? machines?.select(cmd.id, cmd.revision) : undefined;
    if (cmd.type === "machine-profile" && !savedProfile) throw new MachineRegistryError("inactive");
    selectedMachineProfile = savedProfile ?? null;
    savedMachineRetired = false;
    machineRouteRevision++;
    hostSource ??= createPreviewHostSource(process.argv[2]!, retireMachineRoute);
    if (savedProfile) hostSource.select(savedProfile.sshTarget, savedProfile.expectedEnvironmentId);
    else if (cmd.type === "machine") hostSource.select(cmd.sshTarget);
    catalog?.dispose();
    catalog = undefined;
  }
  if (
    cmd.type === "machine" ||
    cmd.type === "machine-profile" ||
    cmd.type === "refresh" ||
    cmd.type === "home"
  ) {
    if (cmd.type === "refresh") void fleet?.refreshPreferences();
    launchRefresh(token);
    return;
  }
  if (cmd.type === "session") {
    if (!sessions.some((s) => s.id === cmd.id)) throw new Error("Unknown session");
    if (!catalog) throw new Error("Catalog unavailable");
    const selectedCatalog = catalog;
    const choices = await selectedCatalog.panes(cmd.id);
    if (stopped || token !== request || catalog !== selectedCatalog) return;
    if (choices.length > 512) throw new Error("Too many panes for preview");
    panes = choices;
    selectedSession = cmd.id;
    sessionCatalogComplete = panes.length === 0;
    status = panes.length ? "Loading windows" : "No available panes";
    publish();
    if (panes[0]) await openPane(panes[0], token, true);
    if (!stopped && request === token) startAgents();
  } else {
    const pane = panes.find((p) => p.semanticPaneId === cmd.id);
    if (!pane) throw new Error("Unknown pane");
    selectedPane = cmd.id;
    publish();
    await openPane(pane, token);
    if (!stopped && request === token) startAgents();
  }
}
// Discovery stays off the command loop so Local can always cancel a slow SSH dial.
function launchRefresh(token: number) {
  if (fleet && surface === "home" && foreground) startAgents();
  void refresh(token).catch((error) => {
    if (stopped || request !== token) return;
    homePhase = "unavailable";
    status =
      error instanceof DaemonCompatibilityError ||
      error instanceof DaemonDiscoveryError ||
      error instanceof CatalogStageError ||
      error instanceof RemoteRouteError ||
      error instanceof FleetSelectionError ||
      error instanceof MachineRegistryError
        ? error.message
        : "Connection unavailable — start the daemon and refresh";
    // Observation can publish synchronously; install the failure guidance first.
    if (fleet && surface === "home") startAgents();
    publish();
  });
}
// One bounded command at a time; discovery results are fenced by request and route.
try {
  if (process.argv[2] === "--local") {
    fleet = createNativeFleetRuntime(publish, retireMachineRoute);
    machines = createNativeMachineRegistry(machinesChanged);
    machines.start();
    fleet.start();
  }
  launchRefresh(0);
  let buffer = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      if (end > MAX_INPUT_LINE) throw new Error("Oversized browser command");
      const line = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      try {
        await command(JSON.parse(line));
      } catch (error) {
        sessionHistory.cancel();
        sessionTabs.cancel();
        sessionCatalogComplete = true;
        initialPane = null;
        snapshot = null;
        inputReady = false;
        if (surface === "home") {
          homePhase = "unavailable";
          retireAgents();
        }
        status =
          error instanceof DaemonCompatibilityError ||
          error instanceof DaemonDiscoveryError ||
          error instanceof CatalogStageError ||
          error instanceof RemoteRouteError ||
          error instanceof MachineRegistryError
            ? error.message
            : "Connection or selection unavailable — refresh the catalog";
        publish();
      }
    }
    if (buffer.length > MAX_INPUT_LINE) throw new Error("Oversized browser command");
  }
} catch (error) {
  // Destroying stdin during an intentional signal shutdown rejects its async
  // iterator. Preserve failure reporting for every other command/stream error.
  const expectedClose =
    shutdownRequested &&
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_STREAM_PREMATURE_CLOSE";
  if (!expectedClose) {
    process.stderr.write("Native browser connection failed\n");
    process.exitCode = 1;
  }
} finally {
  await stop();
}
