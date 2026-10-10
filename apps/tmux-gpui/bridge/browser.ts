import { splitRefreshGuard, refreshSplitInventory } from "./pane-split-refresh.ts";
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
import { paneResizeSchema, resizePresentationMatches } from "./pane-resize.ts";
import { CatalogStageError } from "./catalog-errors.ts";
import { createAppearanceOwner } from "./appearance.ts";
import {
  discoverPreviewHost,
  DaemonCompatibilityError,
  DaemonDiscoveryError,
} from "./discovery.ts";
import { scrollSchema } from "./history.ts";
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
import { hostSchema, readPrivateConfig, connectionSchema } from "./config.ts";

const commandSchema = z.union([
  openWorkspaceAgentSchema,
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
      input: z.union([previewInputSchema, resizeSchema, scrollSchema]),
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
async function readHost() {
  try {
    if (process.argv.length !== 3) throw new Error("Invalid browser arguments");
    return process.argv[2] === "--local"
      ? await discoverPreviewHost()
      : hostSchema.parse(readPrivateConfig(process.argv[2]!));
  } catch (error) {
    if (error instanceof DaemonCompatibilityError || error instanceof DaemonDiscoveryError)
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
let paneActions: z.infer<typeof paneActionsSchema> | null = null;
let snapshot: unknown = null;
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

let agentOwner: ReturnType<typeof createHomeAgentObserver> | undefined;
let agentPublication: ReturnType<typeof homeAgentPublication> | null = null;
let agentRevision = 0;
let agentTimer: ReturnType<typeof setTimeout> | undefined;
function retireAgents() {
  clearTimeout(agentTimer);
  agentTimer = undefined;
  agentOwner?.dispose();
  agentOwner = undefined;
  agentPublication = null;
}
function startAgents() {
  retireAgents();
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

function publish() {
  // Home has no terminal helper or authority to await; its presence applies locally.
  if (surface === "home" && !active) appliedPresenceRevision = presenceRevision;
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
      createSession: sessionCreate.publication(),
      homeAgents: surface === "home" ? agentPublication : null,
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
      status,
      snapshot,
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
  const old = active;
  active = undefined;
  pendingPaneSplit = null;
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
async function stop() {
  if (stopped) return;
  stopped = true;
  retireAgents();
  catalog?.dispose();
  await retire();
  process.stdin.destroy();
  process.stdout.end();
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.stdout.on("error", () => void stop());
async function refresh(token: number) {
  const discovered = await readHost();
  if (stopped || request !== token) return;
  const fresh = createPreviewCatalog(discovered);
  sessionCreate.reset();
  catalog?.dispose();
  catalog = fresh;
  const list = await catalog.sessions();
  if (stopped || request !== token) return;
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
  splitConfirmation?: { window: string; createdPane: string; current: () => boolean },
  requiredCurrent?: () => boolean,
) {
  const directory = await mkdtemp(join(tmpdir(), "tmux-gpui-pane-"));
  let handedOff = false;
  const presentation = createWindowPresentation(config.semanticPaneId);
  try {
    const path = join(directory, "connection.json");
    await writeFile(path, JSON.stringify(config), { mode: 0o600 });
    if (stopped || token !== request || (requiredCurrent && !requiredCurrent())) return;
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
      { stdio: ["pipe", "pipe", "ignore"] },
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
    const unavailable = () => {
      if (stopped || request !== token || active?.child !== child) return;
      retireAgents();
      snapshot = null;
      inputReady = false;
      initialPane = null;
      if (catalogOnly) sessionCatalogComplete = true;
      status = catalogOnly
        ? "Session layout unavailable — refresh, then select the session again"
        : "Pane unavailable — select again or refresh";
      publish();
    };
    child.on("error", unavailable);
    child.on("exit", unavailable);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped || request !== token || active?.child !== child) return;
      try {
        buffer = Buffer.concat([buffer, chunk]);
        let end;
        while ((end = buffer.indexOf(10)) >= 0) {
          if (end > MAX_FRAME) throw new Error("Oversized child publication");
          const event = JSON.parse(buffer.subarray(0, end).toString("utf8"));
          buffer = buffer.subarray(end + 1);
          if (
            typeof event.connection !== "string" ||
            !Number.isSafeInteger(event.sequence) ||
            event.sequence <= childSequence ||
            (childConnection && event.connection !== childConnection)
          )
            throw new Error("Invalid child publication");
          childConnection = event.connection;
          childSequence = event.sequence;
          layouts = topologySchema.parse(event.layouts ?? []);
          if (catalogOnly) {
            if (event.catalogReady !== true) throw new Error("Layout catalog unavailable");
            if (splitConfirmation) {
              const matching = layouts.filter(
                (layout) => layout.semanticWindowId === splitConfirmation.window,
              );
              if (
                matching.length !== 1 ||
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
            status = "Choose a pane or window";
            publish();
            void retire();
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
              attach: async (original, choices) => {
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
          const epoch = z.number().int().nonnegative().safe().parse(event.presentationEpoch);
          if (childPresentationEpoch !== epoch) presentation.update(undefined, [], false);
          childPresentationEpoch = epoch;
          const layout = layouts.find((l) => l.panes.some((p) => p.pane === config.semanticPaneId));
          const surfaces = surfacesSchema.parse(event.surfaces ?? []);
          const scrollOffset = z
            .number()
            .int()
            .min(0)
            .max(1000)
            .parse(event.scrollOffset ?? 0);
          appliedPresenceRevision = event.presenceRevision;
          const hasAuthority =
            foreground &&
            appliedPresenceRevision === presenceRevision &&
            event.inputReady === true &&
            scrollOffset === 0;
          const coherent = presentation.update(
            event.snapshot ? layout : undefined,
            surfaces,
            hasAuthority,
          );
          snapshot = coherent?.snapshot ?? null;
          copyRegion = coherent?.copyRegion ?? null;
          regions = coherent?.regions ?? [];
          inputReady = hasAuthority && !!snapshot;
          resizeToken = resizePresentationMatches(layout, coherent?.regions ?? [])
            ? z
                .string()
                .uuid()
                .nullable()
                .parse(event.resizeToken ?? null)
            : null;
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
          const offeredSplitGesture = splitGesturePublicationSchema
            .nullable()
            .parse(event.splitGesture ?? null);
          splitGesture =
            offeredSplitGesture?.gesture === activeSplitGesture ? offeredSplitGesture : null;
          resizeGestureSupported = event.resizeGestureSupported === true;
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
            event.paneActionError === "Pane action unavailable — reselect pane to retry"
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
                  : "Pane unavailable — select again or refresh";
          publish();
        }
        if (buffer.length > MAX_FRAME) throw new Error("Oversized child publication");
      } catch {
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
    // Deliberately do not await: navigation/presence remain responsive while the
    // single mutation is pending; its captured request/catalog fence owns results.
    void sessionCreate.start({
      name: cmd.name,
      current,
      create: (operationId, name) => owner.createSession(operationId, name),
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
      initialPane = null;
      pendingPaneSplit = null;
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
  if (cmd.type === "pane-action") {
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
    if (cmd.action === "split") {
      const window = layouts.find((layout) =>
        layout.panes.some((pane) => pane.pane === cmd.id),
      )?.semanticWindowId;
      if (!window) throw new Error("Split window unavailable");
      pendingPaneSplit = { ...cmd, window, presenceRevision };
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
      (!inputReady && cmd.input.kind !== "scroll") ||
      !foreground ||
      !snapshot ||
      !active?.child.stdin
    )
      return; // Discard stale/focus-lost input, never reinterpret it for another pane.
    if (cmd.input.kind === "scroll") active.presentation.update(undefined, [], false);
    const line = JSON.stringify(cmd.input) + "\n";
    if (
      Buffer.byteLength(line) > MAX_INPUT_LINE ||
      active.child.stdin.writableLength > MAX_INPUT_LINE * 2
    )
      throw new Error("Input queue full");
    active.child.stdin.write(line);
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
    if (cmd.request <= request) throw new Error("Stale workspace agent command");
    request = cmd.request;
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
    if (cmd.request <= request) throw new Error("Stale agent command");
    request = cmd.request;
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
  if (cmd.request <= request) throw new Error("Stale browser command");
  retireAgents();
  request = cmd.request;
  sessionCatalogComplete = false;
  initialPane = null;
  const token = request;
  snapshot = null;
  inputReady = false;
  selectedPane = null;
  paneActions = null;
  status = "Loading";
  surface = cmd.type === "home" || cmd.type === "refresh" ? "home" : "workspace";
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
  if (cmd.type === "refresh" || cmd.type === "home") return refresh(token);
  if (cmd.type === "session") {
    if (!sessions.some((s) => s.id === cmd.id)) throw new Error("Unknown session");
    if (!catalog) throw new Error("Catalog unavailable");
    const choices = await catalog.panes(cmd.id);
    if (stopped || token !== request) return;
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
// One command at a time and a bounded partial line; stdin backpressure bounds work.
try {
  try {
    await refresh(0);
  } catch (error) {
    homePhase = "unavailable";
    status =
      error instanceof DaemonCompatibilityError ||
      error instanceof DaemonDiscoveryError ||
      error instanceof CatalogStageError
        ? error.message
        : "Connection unavailable — start the daemon and refresh";
    publish();
  }
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
          error instanceof CatalogStageError
            ? error.message
            : "Connection or selection unavailable — refresh the catalog";
        publish();
      }
    }
    if (buffer.length > MAX_INPUT_LINE) throw new Error("Oversized browser command");
  }
} catch {
  process.stderr.write("Native browser connection failed\n");
  process.exitCode = 1;
} finally {
  await stop();
}
