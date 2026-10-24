import {
  createDirectTerminalHandoff,
  nativePaneSelectedSchema,
  type DirectTerminalEvent,
} from "./direct-terminal-handoff.ts";
import { issueDirectTerminal } from "./direct-terminal.ts";
import { createDirectHistory, type DirectHistoryResult } from "./direct-history.ts";
import { createDirectEditor, type EditorResult } from "./direct-editor.ts";
import { createDirectSplitLayout, type SplitLayoutResult } from "./direct-split-layout.ts";
import { createDirectNativePreview } from "./direct-native-preview.ts";
import {
  createDirectOwnerActions,
  type OwnerActionBinding,
  type OwnerActionResult,
} from "./direct-owner-actions.ts";
import { readDirectInventory, refreshDirectTerminal } from "./direct-terminal-refresh.ts";
import {
  acceptsNativeReady,
  acceptNativeCatalog,
  acceptsNativeInterrupted,
} from "./direct-terminal-ready.ts";
import { encodeBinaryFrame } from "./binary-framing.ts";
import { resolveLocalSetup, runLocalSetup } from "./local-setup.ts";
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
import { confirmsClosedPane } from "./close-pane.ts";
import { confirmsNewWindow } from "./new-window.ts";
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
import { createHomeAgentObserver } from "./home-agents.ts";
import {
  homeAgentPublication,
  agentAvailable,
  openAgentSchema,
  openWorkspaceAgentSchema,
} from "./home-agent-publication.ts";
import { createSessionOwner, sessionCreateSchema } from "./session-create.ts";
import {
  proveLocalSessionCreate,
  createLocalSession,
  verifyLocalSessionCreateOwner,
  type LocalSessionCreateProof,
} from "./local-session-create.ts";
import { CatalogStageError } from "./catalog-errors.ts";
import { createAppearanceOwner } from "./appearance.ts";
import {
  discoverPreviewDaemon,
  DaemonCompatibilityError,
  DaemonDiscoveryError,
} from "./discovery.ts";
import { paneChoices, preferredPane, type Layout } from "./topology.ts";
import { MAX_INPUT_LINE } from "./input.ts";
import { randomUUID } from "node:crypto";
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
  nativePaneSelectedSchema,
  z
    .object({ type: z.literal("local-setup"), request: z.number().int().nonnegative().safe() })
    .strict(),
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
  openWorkspaceAgentSchema,
  homeAgentRecoverySchema,
  homeAgentFilterSchema,
  openAgentSchema,
  sessionCreateSchema,
  sessionCreateSchema
    .extend({ type: z.literal("create-local-session"), action: z.uuid() })
    .strict(),
  z.object({ type: z.literal("theme"), id: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal("appearance"), system: z.enum(["dark", "light"]) }).strict(),
  z
    .object({
      type: z.literal("presence"),
      active: z.boolean(),
      revision: z.number().int().nonnegative().safe().default(0),
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
// Image chunk lines are ordered ahead of publications and never coalesced.
const orderedLines: (string | Buffer)[] = [];
let orderedBytes = 0;
const MAX_ORDERED_BYTES = 64 * 1024 * 1024;
let layouts: Layout[] = [];
let foreground = true;
let sessionCatalogComplete = false;
let initialPane: string | null = null;
let presenceRevision = 0;
let appliedPresenceRevision = 0;
let surface: "home" | "workspace" = "home";
let homePhase: "loading" | "live" | "unavailable" = "loading";
let status = "Loading sessions";
const nativeEncoding = process.env.TMUX_IDE_GUI_NATIVE_ENCODING;
function writeNativeControl(
  event:
    | DirectTerminalEvent
    | DirectHistoryResult
    | OwnerActionResult
    | SplitLayoutResult
    | EditorResult,
) {
  const payload = Buffer.from(JSON.stringify(event));
  const frame =
    nativeEncoding === "binary-rle-v1"
      ? encodeBinaryFrame(1, payload)
      : Buffer.concat([payload, Buffer.from("\n")]);
  // A lost one-use capability or close changes ownership; never drop it like an image.
  if (blocked && orderedBytes + frame.length > MAX_ORDERED_BYTES) {
    process.stdout.destroy();
    void stop();
    throw new Error("Native terminal handoff transport overflow");
  }
  writeOrdered(frame);
}
const directHistory = createDirectHistory(writeNativeControl);
const directEditor = createDirectEditor(writeNativeControl);
const directOwner = createDirectOwnerActions(writeNativeControl);
const directSplitLayout = createDirectSplitLayout(writeNativeControl);
let currentDirectScope: OwnerActionBinding | null = null;
let nativeReady: { id: string; request: number; pane: string; presence: number } | null = null;
let acceptDirectCatalog: ((layouts: Layout[]) => Promise<void>) | null = null;
const directTerminal = createDirectTerminalHandoff(
  writeNativeControl,
  (config, mode, signal) =>
    issueDirectTerminal(config, mode, signal, fetch, catalog?.localProof ?? null),
  (scope) => {
    currentDirectScope = scope;
    nativeReady = null;
    directEditor.retire();
    if (scope) {
      const owner = catalog;
      if (owner && !scope.catalogOnly)
        directEditor.bind({
          ...scope,
          proof: owner.localProof,
          read: (signal) =>
            owner.paneEditorContext(
              scope.config.workspaceName,
              scope.config.liveSessionId,
              scope.config.semanticPaneId,
              signal,
            ),
          current: (revision) =>
            !stopped &&
            foreground &&
            surface === "workspace" &&
            currentDirectScope === scope &&
            catalog === owner &&
            request === scope.request &&
            selectedSession === scope.config.liveSessionId &&
            selectedPane === scope.config.semanticPaneId &&
            presenceRevision === revision,
        });
      directHistory.bind(scope);
      directOwner.bind(scope);
      directSplitLayout.bind(scope);
    } else {
      directHistory.retire();
      directOwner.retire();
      directSplitLayout.retire();
      acceptDirectCatalog = null;
    }
  },
);
type QueuedPublication = { json: string };
let lastPublication: string | null = null;
let pending: QueuedPublication | null = null,
  blocked = false;
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
    status = "Reconnecting terminal";
    publish();
    await openPane(pane, target.request, false, undefined, live);
    const deadline = Date.now() + 5000;
    while (live() && Date.now() < deadline) {
      if (
        nativeReady?.request === target.request &&
        nativeReady.pane === target.pane &&
        nativeReady.presence === presenceRevision &&
        nativeReady.id === currentDirectScope?.id
      ) {
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
  status = "Reconnecting terminal";
  terminalRecovery.start();
  publish();
}
let retainedPreviewTimer: ReturnType<typeof setTimeout> | undefined;
function frameProof(key: string): string | null {
  const route = fleet?.retainedFrameProof(key);
  return route ? JSON.stringify([route, appearance.publication()?.theme]) : null;
}
const nativePreviews = createDirectNativePreview(frameProof);
function clearRetainedPreview() {
  nativePreviews.clear();
  if (retainedPreviewTimer) clearTimeout(retainedPreviewTimer);
  retainedPreviewTimer = undefined;
}
function beginRetainedPreview(key: string) {
  clearRetainedPreview();
  nativePreviews.begin(key, request);
  retainedPreviewTimer = setTimeout(() => {
    nativePreviews.clear();
    if (!stopped) publish();
  }, 5000);
}
type LocalSetupPhase =
  | "available"
  | "running"
  | "missing"
  | "unsupported"
  | "failed"
  | "stopped-waiting";
let localSetup: { phase: LocalSetupPhase } | null = null;
let setupOperation: AbortController | null = null;
let setupRevision = 0;
let localCreateProof: LocalSessionCreateProof | null = null;
let localCreateProbe: AbortController | null = null;
let localCreateOperation: AbortController | null = null;
function revokeLocalCreateOffer() {
  localCreateProbe?.abort();
  localCreateProbe = null;
  localCreateProof = null;
}
function cancelLocalCreate() {
  if (localCreateProof && !catalog) homePhase = "unavailable";
  revokeLocalCreateOffer();
  localCreateOperation?.abort();
  localCreateOperation = null;
}
async function offerLocalCreation(token: number) {
  if (!localSetupContext() || request !== token || localCreateOperation || currentDirectScope)
    return;
  revokeLocalCreateOffer();
  const controller = new AbortController();
  localCreateProbe = controller;
  const route = machineRouteRevision,
    presence = presenceRevision;
  const current = () =>
    localCreateProbe === controller &&
    !controller.signal.aborted &&
    localSetupContext() &&
    request === token &&
    machineRouteRevision === route &&
    presenceRevision === presence &&
    !currentDirectScope &&
    !localCreateOperation;
  const result = await proveLocalSessionCreate({ current, signal: controller.signal });
  if (!current()) return;
  localCreateProbe = null;
  if (result.kind !== "available") return;
  localCreateProof = result.proof;
  localSetup = null;
  sessions = [];
  selectedSession = null;
  selectedPane = null;
  homePhase = "live";
  sessionCreate.reset();
  status = "No local sessions yet — create a session to get started";
  publish();
}
function startLocalSessionCreation(cmd: { request: number; action: string; name: string }) {
  const proof = localCreateProof;
  if (
    !proof ||
    cmd.action !== proof.action ||
    cmd.request !== request ||
    !localSetupContext() ||
    currentDirectScope ||
    homePhase !== "live" ||
    localCreateOperation ||
    sessionCreate.publication().phase !== "idle"
  )
    return;
  const controller = new AbortController();
  localCreateOperation = controller;
  const token = request,
    route = machineRouteRevision,
    presence = presenceRevision;
  const current = () =>
    localCreateOperation === controller &&
    !controller.signal.aborted &&
    localSetupContext() &&
    request === token &&
    machineRouteRevision === route &&
    presenceRevision === presence &&
    !currentDirectScope;
  let receipt:
    | Extract<Awaited<ReturnType<typeof createLocalSession>>, { kind: "created" }>["receipt"]
    | undefined;
  const operation = sessionCreate.start({
    name: cmd.name,
    current,
    create: async (_operationId, name) => {
      // Consume only the displayed capability; the in-flight proof has its own lifetime.
      revokeLocalCreateOffer();
      publish();
      const result = await createLocalSession(
        proof,
        { displayName: name },
        { current, signal: controller.signal },
      );
      if (result.kind !== "created") throw new Error("Local creation unconfirmed");
      receipt = result.receipt;
    },
    refresh: async () => {
      if (!receipt || !current()) return;
      const ownerCurrent = () =>
        verifyLocalSessionCreateOwner(proof, { current, signal: controller.signal });
      if (!(await ownerCurrent())) throw new Error("Creation owner changed");
      const discovered = await readHost();
      if (!current()) return;
      const fresh = createPreviewCatalog(discovered);
      let admitted = false;
      try {
        const list = await fresh.sessions();
        if (!(await ownerCurrent())) throw new Error("Creation owner changed");
        if (!current()) return;
        if (list.length > 512) throw new Error("Too many sessions for preview");
        const matches = list.filter(
          (session) =>
            session.workspaceName === receipt!.workspaceName &&
            (!receipt!.liveSessionId || session.liveSessionId === receipt!.liveSessionId),
        );
        if (matches.length !== 1) throw new Error("Created session is not yet discoverable");
        catalog?.dispose();
        catalog = fresh;
        admitted = true;
        sessions = list.map(sessionChoice);
        homePhase = "live";
        status = "Session created — choose it to open";
        startAgents();
      } finally {
        if (!admitted) fresh.dispose();
      }
    },
    changed: publish,
  });
  if (!operation) localCreateOperation = null;
  else
    void operation.finally(() => {
      if (localCreateOperation === controller) {
        localCreateOperation = null;
        publish();
      }
    });
}
function cancelLocalSetup() {
  cancelLocalCreate();
  setupRevision++;
  setupOperation?.abort();
  setupOperation = null;
  localSetup = null;
}
function localSetupContext() {
  return (
    !stopped && foreground && surface === "home" && !selectedFleet && hostSource?.isLocal() === true
  );
}
async function offerLocalSetup(token: number) {
  if (!localSetupContext() || request !== token || setupOperation) return;
  const route = machineRouteRevision,
    revision = setupRevision;
  const resolution = await resolveLocalSetup();
  if (
    !localSetupContext() ||
    request !== token ||
    route !== machineRouteRevision ||
    revision !== setupRevision ||
    setupOperation
  )
    return;
  localSetup = {
    phase:
      resolution.kind === "available"
        ? "available"
        : resolution.kind === "missing"
          ? "missing"
          : "unsupported",
  };
  publish();
}
function startLocalSetup() {
  if (
    !localSetupContext() ||
    setupOperation ||
    !localSetup ||
    !["available", "failed", "stopped-waiting"].includes(localSetup.phase)
  )
    return;
  const controller = new AbortController();
  setupRevision++;
  setupOperation = controller;
  localSetup = { phase: "running" };
  const token = request,
    route = machineRouteRevision;
  const current = () =>
    setupOperation === controller &&
    !controller.signal.aborted &&
    localSetupContext() &&
    request === token &&
    route === machineRouteRevision;
  publish();
  void (async () => {
    const resolution = await resolveLocalSetup();
    if (!current()) return;
    if (resolution.kind !== "available") {
      localSetup = { phase: resolution.kind === "missing" ? "missing" : "unsupported" };
      return;
    }
    const result = await runLocalSetup(resolution.installation, { signal: controller.signal });
    if (!current()) return;
    if (result.kind !== "ready") {
      localSetup = { phase: result.kind === "stopped-waiting" ? "stopped-waiting" : "failed" };
      return;
    }
    await discoverPreviewDaemon();
    if (!current()) return;
    localSetup = null;
    homePhase = "loading";
    status = "Finding local sessions";
    launchRefresh(token);
  })()
    .catch(() => {
      if (current()) localSetup = { phase: "failed" };
    })
    .finally(() => {
      if (setupOperation === controller) {
        setupOperation = null;
        publish();
      }
    });
}
let highestNavigationAttempt = 0;
const admitNavigationAttempt = (attempt: number) => {
  if (attempt <= request || attempt <= highestNavigationAttempt) return false;

  cancelLocalSetup();
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
      sessionHistory.cancel();
      sessionTabs.cancel();
      status = "Fleet session unavailable — return Home and select it again";
      publish();
    });
}

function diagnosticTmuxVersion() {
  const owner = catalog,
    token = request;
  return (
    owner?.diagnosticTmuxVersion(() => {
      if (owner === catalog && request === token) publish();
    }) ?? null
  );
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
  if (
    localCreateProof &&
    fleet
      ?.publication()
      .groups.some(
        (group) =>
          group.id === "local" && group.servers.some((server) => server.state === "online"),
      )
  ) {
    revokeLocalCreateOffer();
    homePhase = "unavailable";
    status = "Local sessions changed — refresh sessions to continue";
  }
  // A session may remain selectable beyond the server display cap, but Home
  // must not offer creation without a visible exact destination.
  if (surface === "home" && homePhase === "live" && selectedFleet && !fleet?.selectedServer()) {
    homePhase = "unavailable";
    status = "Selected server is not available in this fleet view — select a server again.";
  }
  // Terminal-free navigation surfaces apply presence locally. Rust owns terminal ACKs.
  if (
    !currentDirectScope &&
    (surface === "home" ||
      (surface === "workspace" &&
        catalog &&
        selectedSession !== null &&
        sessionCatalogComplete &&
        selectedPane === null))
  )
    appliedPresenceRevision = presenceRevision;
  if (stopped) return;
  const nativeFrameKey =
    currentDirectScope?.request === request &&
    currentDirectScope.config.liveSessionId === selectedSession
      ? fleet?.attachmentKey(currentDirectScope.config)
      : null;
  const nativeFrameScope = nativeFrameKey ? nativePreviews.scope(nativeFrameKey) : null;
  const nativeRetainedPreview = nativePreviews.publication({
    request,
    foreground,
    workspace: surface === "workspace",
    liveAvailable: false,
  });
  const prefix = {
    nativeFrameScope,
    nativeRetainedPreview,
    version: 1,
    connection,
    sequence: ++sequence,
    request,
    sessions,
    surface,
    home: { phase: homePhase },
    diagnostics: null,
    nativeDiagnostics:
      foreground &&
      surface === "workspace" &&
      currentDirectScope &&
      nativeReady?.id === currentDirectScope.id &&
      nativeReady.request === request &&
      nativeReady.pane === selectedPane &&
      nativeReady.presence === presenceRevision
        ? {
            id: currentDirectScope.id,
            request,
            pane: selectedPane,
            generation: currentDirectScope.config.scope.generation,
            presenceRevision,
            versions: {
              daemonVersion: catalog?.diagnosticVersion() ?? null,
              tmuxVersion: diagnosticTmuxVersion(),
            },
          }
        : null,
    localSetup: localSetupContext() ? localSetup : null,
    localSessionCreate:
      localSetupContext() && homePhase === "live" && !currentDirectScope ? localCreateProof : null,
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
  };
  const metadata = {
    ...prefix,
    inputTargetRejected: false,
    inputTargets: [],
    selectionIdentity: null,
    status: historySaveFailed
      ? status + " — Session visit could not be saved; refresh local preferences."
      : surface === "home" && machineMessage
        ? status + " · " + machineMessage
        : status,
    snapshot: null,
    historyOffset: 0,
    copyRegion: null,
    regions: [],
    graphics: [],
    inputReady: false,
    resizeToken: null,
    splitLayout: null,
    splitGesture: null,
    resizeGestureSupported: false,
    resizeGesture: null,
    paneActions: null,
    presenceRevision: appliedPresenceRevision,
    appearance: appearance.publication(),
    fleet: fleet?.publication() ?? null,
    machines: machines ? { ...machines.publication(), message: machineMessage } : null,
  };
  const comparison = JSON.stringify({ ...metadata, sequence: 0 });
  if (comparison === lastPublication) return;
  lastPublication = comparison;
  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json) > MAX_FRAME)
    throw new Error("Browser publication metadata too large");
  const publication = { json };
  if (blocked) pending = publication;
  else writePublication(publication);
}
function writePublication(publication: QueuedPublication) {
  const payload = Buffer.from(publication.json);
  blocked = !process.stdout.write(
    nativeEncoding === "binary-rle-v1"
      ? encodeBinaryFrame(1, payload)
      : Buffer.concat([payload, Buffer.from("\n")]),
  );
}
// Capability and owner-result messages stay ordered ahead of coalesced catalog metadata.
function writeOrdered(line: string | Buffer) {
  if (!blocked) {
    blocked = !process.stdout.write(line);
    return;
  }
  if (orderedBytes + line.length > MAX_ORDERED_BYTES) return;
  orderedLines.push(line);
  orderedBytes += line.length;
}
process.stdout.on("drain", () => {
  blocked = false;
  while (orderedLines.length > 0 && !blocked) {
    const line = orderedLines.shift()!;
    orderedBytes -= line.length;
    blocked = !process.stdout.write(line);
  }
  if (blocked) return;
  if (pending) {
    const publication = pending;
    pending = null;
    writePublication(publication);
  }
});
async function retire() {
  directTerminal.retire();
  attentionSelectionRejected = null;
  paletteSelectionRejected = null;
  attention.cancel();
  palette.cancel();
  nativeReady = null;
}
function retireMachineRoute() {
  if (stopped) return;
  cancelLocalSetup();
  clearRetainedPreview();

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
  homePhase = "unavailable";
  status = recoveryTarget
    ? "Reconnecting terminal"
    : "Machine connection changed — refresh sessions to reconnect";
  void retire();
  publish();
}
async function stop() {
  if (stopped) return;
  cancelLocalSetup();
  cancelTerminalRecovery();
  sessionHistory.cancel();
  sessionTabs.cancel();
  acceptSessionVisit = null;
  stopped = true;
  stopTabObservation?.();
  stopTabObservation = undefined;
  observingTabs = false;
  sessionTabs.dispose();
  clearRetainedPreview();

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
  revokeLocalCreateOffer();
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
  ___recoveryNotice?: string,
) {
  const owningCatalog = catalog;
  if (
    stopped ||
    token !== request ||
    !owningCatalog ||
    catalog !== owningCatalog ||
    (requiredCurrent && !requiredCurrent())
  )
    return;
  status = "Connecting native terminal";
  publish();
  await directTerminal.open(config, token, catalogOnly);
  if (catalogOnly) {
    const bound = currentDirectScope;
    if (
      !bound ||
      bound.request !== token ||
      bound.config.semanticPaneId !== config.semanticPaneId ||
      bound.config.scope.generation !== config.scope.generation ||
      catalog !== owningCatalog
    )
      return;
    acceptDirectCatalog = async (nativeLayouts) => {
      const current = () =>
        !stopped &&
        request === token &&
        catalog === owningCatalog &&
        currentDirectScope === bound &&
        (!requiredCurrent || requiredCurrent());
      if (!current()) return;
      layouts = nativeLayouts;
      if (closeConfirmation) {
        if (
          !closeConfirmation.current() ||
          !confirmsClosedPane(
            layouts.flatMap((layout) =>
              layout.panes.map((pane) => pane.pane).filter((id): id is string => !!id),
            ),
            closeConfirmation.killed,
          )
        )
          throw new Error("Closed pane still present");
        const preferred = preferredPane(
          panes.map((pane) => pane.semanticPaneId),
          layouts,
        );
        const survivor = panes.find((pane) => pane.semanticPaneId === preferred) ?? panes[0];
        directTerminal.retire();
        if (survivor && closeConfirmation.current()) {
          selectedPane = survivor.semanticPaneId;
          await openPane(survivor, token, false, undefined, closeConfirmation.current);
        }
        return;
      }
      if (splitConfirmation) {
        const matching = layouts.filter(
          (layout) => layout.semanticWindowId === splitConfirmation.window,
        );
        if (
          !splitConfirmation.current() ||
          (splitConfirmation.originalPane
            ? !confirmsNewWindow(
                layouts,
                splitConfirmation.originalPane,
                splitConfirmation.window,
                splitConfirmation.createdPane,
              )
            : matching.length !== 1 ||
              !matching[0].panes.some((pane) => pane.pane === config.semanticPaneId) ||
              !matching[0].panes.some((pane) => pane.pane === splitConfirmation.createdPane))
        )
          throw new Error("Split layout did not confirm panes");
        directTerminal.retire();
        await openPane(config, token, false, undefined, splitConfirmation.current);
        return;
      }
      sessionCatalogComplete = true;
      initialPane = preferredPane(
        panes.map((pane) => pane.semanticPaneId),
        layouts,
      );
      const historyKey = foreground ? fleet?.attachmentKey(config) : null;
      if (historyKey) {
        sessionHistory.catalogReady(token, historyKey, owningCatalog, presenceRevision);
        sessionTabs.catalogReady(token, historyKey, owningCatalog, presenceRevision);
      }
      status = "Choose a pane or window";
      directTerminal.retire();
      publish();
    };
  }
  return;
}
async function command(value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "type" in value &&
    (value.type === "native-editor-open" || value.type === "native-editor-cancel")
  ) {
    if (!stopped) void directEditor.handle(value).catch(() => void stop());
    return;
  }
  if (typeof value === "object" && value !== null && "type" in value) {
    if (value.type === "native-split-layout") {
      void directSplitLayout.handle(value).catch(() => void stop());
      return;
    }
    if (value.type === "native-owner-action") {
      if (!stopped && foreground && surface === "workspace")
        void directOwner.handle(value).catch(() => {
          process.stdout.destroy();
          void stop();
        });
      return;
    }
    if (value.type === "native-terminal-catalog") {
      const callback = acceptDirectCatalog,
        bound = currentDirectScope,
        owner = catalog,
        capturedPresence = presenceRevision;
      const nativeLayouts = acceptNativeCatalog(currentDirectScope, value, presenceRevision);
      if (
        !stopped &&
        surface === "workspace" &&
        bound &&
        !bound.catalogOnly &&
        request === bound.request &&
        selectedSession === bound.config.liveSessionId &&
        selectedPane === bound.config.semanticPaneId &&
        nativeLayouts
      ) {
        layouts = nativeLayouts;
        sessionCatalogComplete = true;
        publish();
        return;
      }
      if (!stopped && surface === "workspace" && callback && nativeLayouts)
        void callback(nativeLayouts).catch(() => {
          if (
            !stopped &&
            bound &&
            request === bound.request &&
            catalog === owner &&
            selectedSession === bound.config.liveSessionId &&
            presenceRevision === capturedPresence
          ) {
            status = "Native layout catalog unavailable — refresh";
            publish();
          }
        });
      return;
    }
    if (value.type === "native-terminal-interrupted") {
      if (
        !stopped &&
        surface === "workspace" &&
        acceptsNativeInterrupted(currentDirectScope, value, presenceRevision)
      ) {
        nativeReady = null;
        recoverTerminal("native-connection-interrupted");
      }
      return;
    }
    if (value.type === "native-terminal-ready") {
      const bound = currentDirectScope,
        owner = catalog;
      if (
        stopped ||
        !foreground ||
        surface !== "workspace" ||
        !owner ||
        !bound ||
        request !== bound.request ||
        selectedSession !== bound.config.liveSessionId ||
        selectedPane !== bound.config.semanticPaneId ||
        !acceptsNativeReady(bound, value, presenceRevision)
      )
        return;
      const capturedPresence = presenceRevision;
      const current = () =>
        !stopped &&
        foreground &&
        catalog === owner &&
        currentDirectScope === bound &&
        request === bound.request &&
        selectedSession === bound.config.liveSessionId &&
        selectedPane === bound.config.semanticPaneId &&
        presenceRevision === capturedPresence;
      const key = fleet?.attachmentKey(bound.config);
      if (key) {
        sessionHistory.catalogReady(request, key, owner, presenceRevision);
        sessionTabs.catalogReady(request, key, owner, presenceRevision);
        acceptSessionVisit = () => {
          if (!current()) return;
          const resolve = fleet?.recoveryRoute(key);
          if (resolve)
            recoveryTarget = {
              resolve,
              key,
              pane: bound.config.semanticPaneId,
              request: bound.request,
            };
          const tabTarget = fleet?.retainedTarget(key);
          if (tabTarget) sessionTabs.accept(bound.request, tabTarget);
          const visit = sessionHistory.accept(bound.request, key),
            fleetOwner = fleet;
          if (visit && fleetOwner)
            void fleetOwner.recordVisit(visit.key).then((saved) => {
              if (!current() || fleet !== fleetOwner) return;
              historySaveFailed = !saved;
              publish();
            });
        };
      }
      nativeReady = {
        id: bound.id,
        request: bound.request,
        pane: bound.config.semanticPaneId,
        presence: presenceRevision,
      };
      nativePreviews.clear();
      status = "Live";
      publish();
      return;
    }
    if (value.type === "native-terminal-refresh") {
      const bound = currentDirectScope,
        owner = catalog,
        capturedPresence = presenceRevision;
      if (
        stopped ||
        !foreground ||
        surface !== "workspace" ||
        !bound ||
        !owner ||
        request !== bound.request ||
        selectedSession !== bound.config.liveSessionId
      )
        return;
      const current = () =>
        !stopped &&
        foreground &&
        catalog === owner &&
        request === bound.request &&
        selectedSession === bound.config.liveSessionId &&
        presenceRevision === capturedPresence;
      void refreshDirectTerminal(bound, value, {
        current,
        retire: () => directTerminal.retire(),
        read: () =>
          readDirectInventory({
            current,
            panes: () =>
              owner.workspacePanes(bound.config.liveSessionId, bound.config.workspaceName),
            sessions: () => owner.sessions(),
            publishSessions: (fresh) => {
              sessions = fresh;
            },
          }),
        open: async (choice, choices, token) => {
          if (!current()) return;
          panes = choices;
          selectedPane = choice.semanticPaneId;
          sessionCatalogComplete = true;
          await openPane(choice, token, false, undefined, current);
        },
      }).catch(() => {
        if (current()) {
          status = "Native terminal inventory unavailable — refresh";
          publish();
        }
      });
      return;
    }
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "native-history"
  ) {
    if (!stopped) {
      // Keep owner HTTP off the ordered command loop so navigation can cancel it immediately.
      void directHistory.handle(value).catch(() => {
        process.stdout.destroy();
        void stop();
      });
    }
    return;
  }
  const cmd = commandSchema.parse(value);
  if (cmd.type === "native-pane-selected") {
    if (
      stopped ||
      surface !== "workspace" ||
      cmd.fromRequest !== request ||
      cmd.request <= highestNavigationAttempt ||
      !directTerminal.advanceSelection(cmd)
    )
      return;
    // Native completed navigation: either an ACK-fenced selection or a refusal
    // retaining the current pane. Mirror its request scope without granting authority.
    highestNavigationAttempt = cmd.request;
    request = cmd.request;
    selectedPane = cmd.pane;
    status = "Live";
    publish();
    return;
  }
  if (cmd.type === "create-local-session") {
    startLocalSessionCreation(cmd);
    return;
  }
  if (cmd.type === "local-setup") {
    if (cmd.request === request) startLocalSetup();
    return;
  }
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
      !currentDirectScope;
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
    clearRetainedPreview();

    if (cmd.type === "theme") appearance.select(cmd.id);
    else appearance.setSystem(cmd.system);
    publish();
    return;
  }
  if (cmd.type === "presence") {
    foreground = cmd.active;
    if (!foreground) {
      cancelLocalSetup();
      clearRetainedPreview();

      workspaceFleetAgents.cancel();
      sessionHistory.cancel();
      sessionTabs.cancel();
      attention.cancel();
      palette.cancel();
      initialPane = null;
    }
    if (foreground) {
      startAgents();
      if (localSetupContext() && homePhase === "unavailable") launchRefresh(request);
    } else retireAgents();
    presenceRevision = cmd.revision;
    nativeReady = null;
    publish();
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
    selectedPane = null;
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
    selectedPane = null;
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
    if (admitted.kind !== "close") beginRetainedPreview(admitted.key);
    else clearRetainedPreview();
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
    selectedPane = null;
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
    selectedPane = null;
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
    selectedPane = null;
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
    selectedPane = null;
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
    selectedPane = null;
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
  // Only the proved catalog and exact displayed pane may carry a pending traversal
  // into the newer native connection request.
  const continuationPane =
    cmd.type === "pane" && catalog && sessionCatalogComplete
      ? panes.find(
          (pane) => pane.semanticPaneId === cmd.id && pane.liveSessionId === selectedSession,
        )
      : undefined;
  const continuationKey =
    continuationPane && foreground ? fleet?.attachmentKey(continuationPane) : null;
  if (continuationKey) nativePreviews.continue(continuationKey, cmd.request);
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
  selectedPane = null;
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
    if (
      error instanceof DaemonCompatibilityError ||
      (error instanceof DaemonDiscoveryError &&
        ["no-daemon", "unavailable"].includes(error.category))
    )
      void offerLocalSetup(token);
    if (error instanceof DaemonDiscoveryError && error.category === "no-server")
      void offerLocalCreation(token);
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
