/**
 * SessionChannel — one control-mode channel serving every pane subscription
 * of one tmux session (m43 card 1).
 *
 * Responsibilities, in the order the bytes see them:
 *
 *  - ROUTING: `%output`/`%extended-output` bytes are keyed by runtime `%N`
 *    and fanned out to that pane's subscribers through their {@link PaneFeed}
 *    gates. Runtime ids never leave this module — the public surface
 *    (subscribe, describe, layout events) speaks semantic ids only.
 *  - IDENTITY: the descriptor discovery ({@link SessionDescriptorDiscovery})
 *    feeds the workspace-tmux-adapter reconciliation; stamps are untrusted
 *    until verified, generated ids become real only after their pane-local
 *    stamp-back succeeds, and duplicate stamps are ALL restamped.
 *  - SEED/RESEED: the atomic recipe (capture + cursor probe back-to-back on
 *    the control channel, discard-until-reply) via `commandInline`, whose
 *    callbacks fire synchronously in channel read order.
 *  - FLOW: `%pause` bookkeeping in the {@link FlowLedger}; sticky-pause
 *    recovery continues+reseeds EVERY backpressure-paused pane that still has
 *    an unfrozen subscriber; explicit freeze/thaw parks one pane without
 *    touching siblings.
 *  - LAYOUT: `%layout-change`/`%window-pane-changed`/`%session-window-changed`
 *    are applied synchronously in notification order (ahead of any output the
 *    server emitted after the layout), joined to semantic window/pane ids.
 *  - INPUT: literals coalesce per pane (measured 256-byte chunks) and named
 *    keys flush pending literals first — the shared {@link InputCoalescer}
 *    discipline — leaving fire-and-forget via the channel.
 */
import { randomBytes } from "node:crypto";
import {
  WORKSPACE_SEMANTIC_PANE_OPTION,
  WORKSPACE_SEMANTIC_WINDOW_OPTION,
  WorkspaceIdSchemaZ,
  type WorkspacePaneRect,
} from "@tmux-ide/contracts";
import { textToHexKeys } from "../protocol/control.ts";
import { InputCoalescer } from "../protocol/input-coalescer.ts";
import {
  parseLayout,
  parseLayoutChange,
  parseSessionWindowChanged,
  parseWindowPaneChanged,
  type ParsedLayout,
} from "../protocol/layout-parse.ts";
import {
  SESSION_PANE_DESCRIPTOR_FORMAT,
  SessionDescriptorDiscovery,
  decodeTmuxArgument,
  type SessionPaneDescriptor,
} from "../protocol/session-descriptor-discovery.ts";
import {
  finalizeWorkspaceTmuxReconciliation,
  planWorkspaceTmuxReconciliation,
  type WorkspaceTmuxPaneSnapshot,
  type WorkspaceTmuxStampOutcome,
} from "../protocol/workspace-tmux-adapter.ts";
import type { MirrorChannelHandlers, MirrorChannelIo } from "./control-channel.ts";
import type {
  MirrorDiagnostic,
  MirrorLayoutEvent,
  MirrorPaneEvent,
  MirrorSessionDescription,
} from "./events.ts";
import { FlowLedger } from "./flow-ledger.ts";
import { PaneFeed } from "./pane-feed.ts";

/** Notifications whose payload cannot be applied directly — fall back to the
 *  debounced truth sync (same set the TUI SessionMirror uses). */
const STRUCTURAL_NOTIFICATIONS = new Set([
  "window-add",
  "window-close",
  "window-renamed",
  "unlinked-window-close",
]);

const DEFAULT_HISTORY_LINES = 2000;
const SYNC_DEBOUNCE_MS = 40;

export interface SessionChannelOptions {
  session: string;
  createIo: (handlers: MirrorChannelHandlers) => MirrorChannelIo;
  historyLines?: number;
  generatePaneId?: () => string;
  generateWindowId?: () => string;
  /** Debounce scheduler for the truth sync — injectable for tests. Returns a
   *  cancel function. */
  scheduleSync?: (callback: () => void, delayMs: number) => () => void;
  /** The channel died underneath us (tmux exited or detached the client). */
  onExit?: () => void;
}

export interface PaneSubscriptionHandle {
  readonly semanticPaneId: string;
  freeze(): void;
  thaw(): void;
  sendText(text: string): void;
  sendKey(key: string): void;
  close(): void;
}

interface SubRecord {
  readonly feed: PaneFeed;
  readonly onEvent: (event: MirrorPaneEvent) => void;
  readonly onLayout: ((event: MirrorLayoutEvent) => void) | null;
  pane: PaneRecord;
  frozen: boolean;
  closed: boolean;
}

interface PaneRecord {
  runtimeId: string;
  semanticId: string;
  descriptor: SessionPaneDescriptor | null;
  active: boolean;
  windowRuntimeId: string | null;
  readonly subs: Set<SubRecord>;
}

interface WindowRecord {
  runtimeId: string;
  semanticId: string | null;
  name: string | null;
}

export function defaultMirrorPaneId(): string {
  return `pane.mirror.${randomBytes(8).toString("hex")}`;
}

export function defaultMirrorWindowId(): string {
  return `window.mirror.${randomBytes(8).toString("hex")}`;
}

export class SessionChannel {
  private readonly opts: SessionChannelOptions;
  private readonly io: MirrorChannelIo;
  private readonly ledger = new FlowLedger();
  private readonly discovery: SessionDescriptorDiscovery;
  private readonly panesByRuntime = new Map<string, PaneRecord>();
  private readonly panesBySemantic = new Map<string, PaneRecord>();
  private readonly windowsByRuntime = new Map<string, WindowRecord>();
  private readonly layoutByWindow = new Map<string, ParsedLayout & { zoomed: boolean }>();
  private readonly activePaneByWindow = new Map<string, string>();
  private readonly truthActive = new Map<string, boolean>();
  private readonly truthWindow = new Map<string, string>();
  private currentWindow = "";
  private diagnostics: MirrorDiagnostic[] = [];
  private degraded = false;
  private readonly ageByRuntime = new Map<string, number>();
  private maxAgeMs = 0;
  private cancelSync: (() => void) | null = null;
  private disposed = false;
  /** Settles once the FIRST identity join lands (or is proven impossible), so
   *  `start()` returns a channel whose semantic ids are subscribable. */
  private resolveFirstJoin: (() => void) | null = null;
  private readonly firstJoin = new Promise<void>((resolve) => {
    this.resolveFirstJoin = resolve;
  });
  private readonly input = new InputCoalescer(
    (action) => {
      if (action.kind === "literal") {
        this.io.send(`send-keys -t ${action.pane} -H ${textToHexKeys(action.text).join(" ")}`);
      } else {
        this.io.send(`send-keys -t ${action.pane} ${action.key}`);
      }
    },
    (flush) => queueMicrotask(flush),
  );

  constructor(opts: SessionChannelOptions) {
    this.opts = opts;
    this.io = opts.createIo({
      onOutput: (pane, data, ageMs) => this.onOutput(pane, data, ageMs),
      onNotify: (name, rest) => this.onNotify(name, rest),
      onExit: () => this.onChannelExit(),
    });
    this.discovery = new SessionDescriptorDiscovery({
      query: () =>
        this.io.request(
          `list-panes -s -t "${this.opts.session}" -F "${SESSION_PANE_DESCRIPTOR_FORMAT}"`,
        ),
      onDescriptors: (descriptors, listed) => {
        void this.reconcileIdentity(descriptors, listed).catch(() => {});
      },
      onStatus: (status) => {
        if (status) {
          this.pushDiagnostic({
            code: `DESCRIPTOR_${status.status.toUpperCase()}`,
            message: status.message,
            degraded: status.degraded,
          });
          // Discovery gave up: identity will not improve on its own — let
          // start() return the (degraded) channel rather than hang.
          if (status.status === "failed") this.settleFirstJoin();
        }
      },
    });
  }

  async start(): Promise<void> {
    await this.io.start();
    await this.syncNow();
    await this.firstJoin;
  }

  // ── Public surface (semantic ids only) ──────────────────────────────────

  describe(): MirrorSessionDescription {
    const panes = [...this.panesBySemantic.values()].map((pane) => ({
      semanticPaneId: pane.semanticId,
      semanticWindowId: pane.windowRuntimeId
        ? (this.windowsByRuntime.get(pane.windowRuntimeId)?.semanticId ?? null)
        : null,
      role: pane.descriptor?.role ?? null,
      paneType: pane.descriptor?.type ?? null,
      currentCommand: pane.descriptor?.currentCommand ?? null,
      cwd: pane.descriptor?.cwd ?? null,
      title: pane.descriptor?.title ?? null,
      windowName: pane.descriptor?.windowName ?? null,
      active: pane.active,
    }));
    return {
      session: this.opts.session,
      panes,
      diagnostics: [...this.diagnostics],
      degraded: this.degraded,
    };
  }

  subscribePane(
    semanticPaneId: string,
    onEvent: (event: MirrorPaneEvent) => void,
    onLayout?: (event: MirrorLayoutEvent) => void,
  ): PaneSubscriptionHandle {
    const pane = this.panesBySemantic.get(semanticPaneId);
    if (!pane) {
      throw new Error(`unknown semantic pane ${semanticPaneId} in session ${this.opts.session}`);
    }
    const sub: SubRecord = {
      feed: new PaneFeed(),
      onEvent,
      onLayout: onLayout ?? null,
      pane,
      frozen: false,
      closed: false,
    };
    pane.subs.add(sub);
    // A paused pane gains an unfrozen watcher: release the park before the
    // seed so the capture reflects a flowing pane.
    if (this.ledger.isRequested(pane.runtimeId)) this.ledger.clearRequest(pane.runtimeId);
    if (this.ledger.isBackpressured(pane.runtimeId)) this.continuePane(pane.runtimeId);
    this.reseed(sub);
    return {
      semanticPaneId,
      freeze: () => this.freeze(sub),
      thaw: () => this.thaw(sub),
      sendText: (text) => {
        if (!sub.closed) this.input.literal(sub.pane.runtimeId, text);
      },
      sendKey: (key) => {
        if (!sub.closed) this.input.key(sub.pane.runtimeId, key);
      },
      close: () => this.closeSub(sub),
    };
  }

  subscriberCount(): number {
    let count = 0;
    for (const pane of this.panesByRuntime.values()) count += pane.subs.size;
    return count;
  }

  /** Fall-behind telemetry from the `%extended-output` age field. */
  ageTelemetry(): { maxAgeMs: number; byPane: Record<string, number> } {
    const byPane: Record<string, number> = {};
    for (const [runtime, age] of this.ageByRuntime) {
      const semantic = this.panesByRuntime.get(runtime)?.semanticId;
      if (semantic) byPane[semantic] = age;
    }
    return { maxAgeMs: this.maxAgeMs, byPane };
  }

  flowSnapshot(): { backpressured: string[]; requested: string[] } {
    const toSemantic = (runtime: string): string =>
      this.panesByRuntime.get(runtime)?.semanticId ?? "(unidentified)";
    const snapshot = this.ledger.snapshot();
    return {
      backpressured: snapshot.backpressured.map(toSemantic),
      requested: snapshot.requested.map(toSemantic),
    };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.settleFirstJoin();
    this.cancelSync?.();
    this.cancelSync = null;
    this.discovery.dispose();
    this.input.flush();
    for (const pane of this.panesByRuntime.values()) {
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.onEvent({ type: "closed" });
        }
      }
      pane.subs.clear();
    }
    await this.io.dispose();
  }

  // ── Byte routing ─────────────────────────────────────────────────────────

  private onOutput(runtimePane: string, data: Uint8Array, ageMs: number | null): void {
    if (ageMs !== null) {
      this.ageByRuntime.set(runtimePane, ageMs);
      if (ageMs > this.maxAgeMs) this.maxAgeMs = ageMs;
    }
    const pane = this.panesByRuntime.get(runtimePane);
    if (!pane) return;
    for (const sub of pane.subs) {
      if (sub.frozen || sub.closed) continue;
      for (const event of sub.feed.delta(data)) sub.onEvent(event);
    }
  }

  // ── Seed / reseed (the atomic recipe) ────────────────────────────────────

  private reseed(sub: SubRecord): void {
    if (sub.closed || this.disposed) return;
    const runtime = sub.pane.runtimeId;
    const epoch = sub.feed.beginReseed();
    // Keystroke ordering: pending coalesced input leaves before the probes.
    this.input.flush();
    const history = this.opts.historyLines ?? DEFAULT_HISTORY_LINES;
    // Both probes ride one write burst; the FIFO reply order is the seam.
    this.io.commandInline(`capture-pane -p -e -J -S -${history} -t ${runtime}`, (reply) => {
      if (!reply.ok) {
        sub.feed.abort(epoch);
        return;
      }
      sub.feed.captureReply(epoch, reply.lines);
    });
    this.io.commandInline(
      `display-message -p -t ${runtime} "#{cursor_x} #{cursor_y} #{pane_width} #{pane_height}"`,
      (reply) => {
        if (!reply.ok) {
          sub.feed.abort(epoch);
          return;
        }
        const events = sub.feed.cursorReply(
          epoch,
          reply.lines[0] ?? "",
          this.layoutSizeFor(runtime),
        );
        for (const event of events) {
          if (!sub.closed) sub.onEvent(event);
        }
      },
    );
  }

  private layoutSizeFor(runtime: string): { cols: number; rows: number } | null {
    for (const layout of this.layoutByWindow.values()) {
      const leaf = layout.leaves.find((candidate) => candidate.id === runtime);
      if (leaf) return { cols: leaf.width, rows: leaf.height };
    }
    return null;
  }

  // ── Flow control ─────────────────────────────────────────────────────────

  private freeze(sub: SubRecord): void {
    if (sub.frozen || sub.closed) return;
    sub.frozen = true;
    sub.onEvent({ type: "flow", state: "paused", reason: "requested" });
    const pane = sub.pane;
    const allFrozen = [...pane.subs].every((candidate) => candidate.frozen || candidate.closed);
    if (allFrozen) {
      this.ledger.requestPause(pane.runtimeId);
      this.io.send(`refresh-client -A '${pane.runtimeId}:pause'`);
    }
  }

  private thaw(sub: SubRecord): void {
    if (!sub.frozen || sub.closed) return;
    sub.frozen = false;
    const runtime = sub.pane.runtimeId;
    if (this.ledger.isRequested(runtime) || this.ledger.isBackpressured(runtime)) {
      this.ledger.clearRequest(runtime);
      this.continuePane(runtime);
    }
    sub.onEvent({ type: "flow", state: "resumed", reason: "requested" });
    this.reseed(sub);
    // Any recovery recovers every sticky-paused sibling (spike policy).
    this.recoverSticky();
  }

  private continuePane(runtime: string): void {
    this.io.send(`refresh-client -A '${runtime}:continue'`);
    this.ledger.noteContinued(runtime);
  }

  /** Continue + reseed EVERY backpressure-paused pane that still has an
   *  unfrozen subscriber. %pause is sticky and hits quiet panes after any
   *  stall — recovering only the noisy pane leaves siblings dark. */
  private recoverSticky(): void {
    for (const runtime of this.ledger.stickyRecoverySet()) {
      const pane = this.panesByRuntime.get(runtime);
      const live = pane ? [...pane.subs].filter((sub) => !sub.frozen && !sub.closed) : [];
      if (live.length === 0) continue; // nobody watching: staying paused is free
      this.continuePane(runtime);
      for (const sub of live) {
        sub.onEvent({ type: "flow", state: "resumed", reason: "backpressure" });
        this.reseed(sub);
      }
    }
  }

  private closeSub(sub: SubRecord): void {
    if (sub.closed) return;
    sub.closed = true;
    const pane = sub.pane;
    pane.subs.delete(sub);
    // Ticket return on departure: a pane parked by a now-gone subscriber must
    // not stay paused forever.
    if (pane.subs.size === 0 && this.ledger.isRequested(pane.runtimeId)) {
      this.ledger.clearRequest(pane.runtimeId);
      this.continuePane(pane.runtimeId);
    }
  }

  // ── Notifications (channel order is the invariant) ──────────────────────

  private onNotify(name: string, rest: string): void {
    if (name === "pause") {
      const runtime = rest.trim().split(/\s+/)[0] ?? "";
      if (!runtime.startsWith("%")) return;
      this.ledger.notePause(runtime);
      const pane = this.panesByRuntime.get(runtime);
      if (pane) {
        for (const sub of pane.subs) {
          if (!sub.frozen && !sub.closed) {
            sub.onEvent({ type: "flow", state: "paused", reason: "backpressure" });
          }
        }
      }
      this.recoverSticky();
      return;
    }
    if (name === "continue") {
      const runtime = rest.trim().split(/\s+/)[0] ?? "";
      if (runtime.startsWith("%")) this.ledger.noteContinued(runtime);
      return;
    }
    if (name === "layout-change") {
      const change = parseLayoutChange(rest);
      if (!change) return;
      const parsed = parseLayout(change.visible);
      if (!parsed) {
        this.scheduleSync(); // never guess from a failed parse
        return;
      }
      this.layoutByWindow.set(change.windowId, { ...parsed, zoomed: change.zoomed });
      // Resync on BOTH structural deltas: an unknown leaf (new pane) and a
      // known pane of this window missing from the leaves (a killed pane in a
      // surviving window emits only %layout-change — without this, its
      // subscribers never receive `closed`). Closure itself still comes only
      // from the truth reply; a probe failure never reads as absence.
      const leafIds = new Set(parsed.leaves.map((leaf) => leaf.id));
      const knownPaneVanished = [...this.panesByRuntime.values()].some(
        (pane) => pane.windowRuntimeId === change.windowId && !leafIds.has(pane.runtimeId),
      );
      if (parsed.leaves.some((leaf) => !this.panesByRuntime.has(leaf.id)) || knownPaneVanished) {
        this.scheduleSync();
      }
      this.emitLayout(change.windowId);
      return;
    }
    if (name === "window-pane-changed") {
      const change = parseWindowPaneChanged(rest);
      if (!change) return;
      this.activePaneByWindow.set(change.windowId, change.paneId);
      for (const pane of this.panesByRuntime.values()) {
        if (pane.windowRuntimeId === change.windowId)
          pane.active = pane.runtimeId === change.paneId;
      }
      this.emitLayout(change.windowId);
      return;
    }
    if (name === "session-window-changed") {
      const change = parseSessionWindowChanged(rest);
      if (change) this.currentWindow = change.windowId;
      return;
    }
    if (STRUCTURAL_NOTIFICATIONS.has(name)) this.scheduleSync();
  }

  private emitLayout(windowRuntimeId: string): void {
    const layout = this.layoutByWindow.get(windowRuntimeId);
    if (!layout) return;
    const windowRecord = this.windowsByRuntime.get(windowRuntimeId) ?? null;
    const activePane = this.activePaneByWindow.get(windowRuntimeId) ?? "";
    const event: MirrorLayoutEvent = {
      type: "layout",
      session: this.opts.session,
      semanticWindowId: windowRecord?.semanticId ?? null,
      windowName: windowRecord?.name ?? null,
      currentWindow: windowRuntimeId === this.currentWindow,
      cols: layout.width,
      rows: layout.height,
      zoomed: layout.zoomed,
      panes: layout.leaves.map((leaf) => ({
        semanticPaneId: this.panesByRuntime.get(leaf.id)?.semanticId ?? null,
        left: leaf.left,
        top: leaf.top,
        width: leaf.width,
        height: leaf.height,
        active: leaf.id === activePane,
      })),
    };
    for (const pane of this.panesByRuntime.values()) {
      for (const sub of pane.subs) {
        if (!sub.closed && sub.onLayout) sub.onLayout(event);
      }
    }
  }

  // ── Truth sync + identity join ───────────────────────────────────────────

  private scheduleSync(): void {
    if (this.cancelSync || this.disposed) return;
    const schedule =
      this.opts.scheduleSync ??
      ((callback: () => void, delayMs: number) => {
        const timer = setTimeout(callback, delayMs);
        return () => clearTimeout(timer);
      });
    this.cancelSync = schedule(() => {
      this.cancelSync = null;
      void this.syncNow().catch(() => {});
    }, SYNC_DEBOUNCE_MS);
  }

  private async syncNow(): Promise<void> {
    if (this.disposed) return;
    const lines = await this.io.request(
      `list-panes -s -t "${this.opts.session}" -F "#{pane_id}\t#{pane_active}\t#{window_id}\t#{?window_active,1,0}"`,
    );
    const listed = new Set<string>();
    this.truthActive.clear();
    this.truthWindow.clear();
    for (const line of lines) {
      const [runtime = "", active = "", windowId = "", windowActive = ""] = line.split("\t");
      if (!/^%[0-9]+$/u.test(runtime)) continue;
      listed.add(runtime);
      this.truthActive.set(runtime, active === "1");
      this.truthWindow.set(runtime, windowId);
      if (windowActive === "1" && windowId.startsWith("@")) this.currentWindow = windowId;
    }
    // Closure is decided ONLY by a successful truth reply that omits the pane
    // (probe failure never reads as absence — a thrown request skips all this).
    for (const [runtime, pane] of [...this.panesByRuntime]) {
      if (listed.has(runtime)) {
        pane.active = this.truthActive.get(runtime) ?? pane.active;
        pane.windowRuntimeId = this.truthWindow.get(runtime) ?? pane.windowRuntimeId;
        continue;
      }
      this.panesByRuntime.delete(runtime);
      this.panesBySemantic.delete(pane.semanticId);
      this.ledger.forget(runtime);
      this.ageByRuntime.delete(runtime);
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.onEvent({ type: "closed" });
        }
      }
      pane.subs.clear();
    }
    await this.syncWindows();
    this.discovery.discover(listed);
  }

  private async syncWindows(): Promise<void> {
    const lines = await this.io.request(
      `list-windows -t "${this.opts.session}" -F "#{window_id}\t#{qa:@tmux_ide_window_id}\t#{qa:window_name}\t#{window_active}\t#{window_visible_layout}\t#{?window_zoomed_flag,1,0}"`,
    );
    interface Row {
      runtimeId: string;
      stamp: string | null;
      name: string | null;
      active: boolean;
      visible: string;
      zoomed: boolean;
    }
    const rows: Row[] = [];
    for (const raw of lines) {
      // Replies are latin1 byte strings; recover UTF-8 window names first.
      const line = Buffer.from(raw, "latin1").toString("utf8");
      const parts = line.split("\t");
      if (parts.length < 6) continue;
      const [runtimeId = "", stampRaw = "", nameRaw = "", active = "", visible = "", zoomed = ""] =
        parts;
      if (!/^@[0-9]+$/u.test(runtimeId)) continue;
      const stamp = decodeTmuxArgument(stampRaw);
      const name = decodeTmuxArgument(nameRaw);
      rows.push({
        runtimeId,
        stamp: stamp.length > 0 ? stamp : null,
        name: name.length > 0 ? name : null,
        active: active === "1",
        visible,
        zoomed: zoomed === "1",
      });
    }
    // Valid unique stamps are identity; missing/invalid/duplicated stamps are
    // ALL regenerated and stamped back (the pane policy, applied to windows).
    const stampCounts = new Map<string, number>();
    for (const row of rows) {
      if (row.stamp && WorkspaceIdSchemaZ.safeParse(row.stamp).success) {
        stampCounts.set(row.stamp, (stampCounts.get(row.stamp) ?? 0) + 1);
      }
    }
    const claimed = new Set(stampCounts.keys());
    const generateWindowId = this.opts.generateWindowId ?? defaultMirrorWindowId;
    const next = new Map<string, WindowRecord>();
    for (const row of rows) {
      if (row.active) this.currentWindow = row.runtimeId;
      const parsed = parseLayout(row.visible);
      if (parsed) this.layoutByWindow.set(row.runtimeId, { ...parsed, zoomed: row.zoomed });
      let semanticId: string | null = null;
      if (row.stamp && stampCounts.get(row.stamp) === 1) {
        semanticId = row.stamp;
      } else {
        let candidate: string | null = null;
        for (let attempt = 0; attempt < 32 && !candidate; attempt += 1) {
          const generated = generateWindowId();
          if (WorkspaceIdSchemaZ.safeParse(generated).success && !claimed.has(generated)) {
            candidate = generated;
          }
        }
        if (candidate) {
          claimed.add(candidate);
          const ok = await this.io
            .request(
              `set-option -w -t ${row.runtimeId} ${WORKSPACE_SEMANTIC_WINDOW_OPTION} "${candidate}"`,
            )
            .then(
              () => true,
              () => false,
            );
          if (ok) semanticId = candidate;
          else {
            this.pushDiagnostic({
              code: "WINDOW_STAMP_BACK_FAILED",
              message: `Could not stamp semantic window identity ${candidate}.`,
              degraded: true,
            });
          }
        }
      }
      next.set(row.runtimeId, { runtimeId: row.runtimeId, semanticId, name: row.name });
    }
    this.windowsByRuntime.clear();
    for (const [key, value] of next) this.windowsByRuntime.set(key, value);
  }

  private async reconcileIdentity(
    descriptors: readonly SessionPaneDescriptor[],
    listed: ReadonlySet<string>,
  ): Promise<void> {
    if (this.disposed) return;
    const snapshots: WorkspaceTmuxPaneSnapshot[] = descriptors
      .filter((descriptor) => listed.has(descriptor.runtimePaneId))
      .map((descriptor) => ({
        runtimePaneId: descriptor.runtimePaneId,
        semanticPaneId: descriptor.semanticPaneId,
        role: descriptor.role,
        type: descriptor.type,
        currentCommand: descriptor.currentCommand,
        cwd: descriptor.cwd,
        title: descriptor.title,
        rect: this.rectFor(descriptor.runtimePaneId),
        active: this.truthActive.get(descriptor.runtimePaneId) ?? false,
      }));
    const plan = planWorkspaceTmuxReconciliation({
      panes: snapshots,
      generateSemanticPaneId: this.opts.generatePaneId ?? defaultMirrorPaneId,
    });
    const outcomes: WorkspaceTmuxStampOutcome[] = await Promise.all(
      plan.stampEffects.map((effect) =>
        this.io
          .request(
            `set-option -p -t ${effect.runtimePaneId} ${WORKSPACE_SEMANTIC_PANE_OPTION} "${effect.value}"`,
          )
          .then(
            () => ({ runtimePaneId: effect.runtimePaneId, ok: true }),
            (cause: unknown) => ({
              runtimePaneId: effect.runtimePaneId,
              ok: false,
              error: cause instanceof Error ? cause.message : String(cause),
            }),
          ),
      ),
    );
    if (this.disposed) return;
    const reconciliation = finalizeWorkspaceTmuxReconciliation(plan, outcomes);
    const descriptorByRuntime = new Map(descriptors.map((d) => [d.runtimePaneId, d]));
    for (const verified of reconciliation.panes) {
      if (!listed.has(verified.runtimePaneId)) continue;
      const descriptor = descriptorByRuntime.get(verified.runtimePaneId) ?? null;
      const windowRuntimeId =
        this.truthWindow.get(verified.runtimePaneId) ?? descriptor?.windowId ?? null;
      const existingBySemantic = this.panesBySemantic.get(verified.semanticPaneId);
      const existingByRuntime = this.panesByRuntime.get(verified.runtimePaneId);
      if (existingBySemantic && existingBySemantic.runtimeId !== verified.runtimePaneId) {
        // The semantic identity moved to a different runtime address (respawn/
        // restore). Follow it and reseed every live subscriber — the old
        // address's bytes are a different pane's now.
        this.panesByRuntime.delete(existingBySemantic.runtimeId);
        this.ledger.forget(existingBySemantic.runtimeId);
        existingBySemantic.runtimeId = verified.runtimePaneId;
        existingBySemantic.descriptor = descriptor;
        existingBySemantic.active = verified.active;
        existingBySemantic.windowRuntimeId = windowRuntimeId;
        this.panesByRuntime.set(verified.runtimePaneId, existingBySemantic);
        for (const sub of existingBySemantic.subs) {
          if (!sub.closed && !sub.frozen) this.reseed(sub);
        }
        continue;
      }
      if (existingByRuntime && existingByRuntime.semanticId === verified.semanticPaneId) {
        existingByRuntime.descriptor = descriptor;
        existingByRuntime.active = verified.active;
        existingByRuntime.windowRuntimeId = windowRuntimeId;
        continue;
      }
      if (existingByRuntime) {
        // The runtime address was restamped to a new identity (duplicate
        // resolution). The old semantic id is gone.
        this.panesBySemantic.delete(existingByRuntime.semanticId);
        existingByRuntime.semanticId = verified.semanticPaneId;
        existingByRuntime.descriptor = descriptor;
        existingByRuntime.active = verified.active;
        existingByRuntime.windowRuntimeId = windowRuntimeId;
        this.panesBySemantic.set(verified.semanticPaneId, existingByRuntime);
        continue;
      }
      const record: PaneRecord = {
        runtimeId: verified.runtimePaneId,
        semanticId: verified.semanticPaneId,
        descriptor,
        active: verified.active,
        windowRuntimeId,
        subs: new Set(),
      };
      this.panesByRuntime.set(record.runtimeId, record);
      this.panesBySemantic.set(record.semanticId, record);
    }
    // Diagnostics cross the semantic boundary too: rewrite runtime addresses
    // to the joined semantic id (or an honest placeholder for panes that never
    // verified) so `%N` never leaves the service.
    const semanticByRuntime = new Map(
      reconciliation.panes.map((pane) => [pane.runtimePaneId, pane.semanticPaneId]),
    );
    this.diagnostics = reconciliation.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message.replace(
        /%[0-9]+/gu,
        (runtime) => semanticByRuntime.get(runtime) ?? "(unidentified pane)",
      ),
      degraded: diagnostic.degraded,
    }));
    this.degraded = reconciliation.degraded;
    this.settleFirstJoin();
  }

  private settleFirstJoin(): void {
    this.resolveFirstJoin?.();
    this.resolveFirstJoin = null;
  }

  private rectFor(runtime: string): WorkspacePaneRect {
    for (const layout of this.layoutByWindow.values()) {
      const leaf = layout.leaves.find((candidate) => candidate.id === runtime);
      if (leaf) return { left: leaf.left, top: leaf.top, width: leaf.width, height: leaf.height };
    }
    return { left: 0, top: 0, width: 1, height: 1 };
  }

  private pushDiagnostic(diagnostic: MirrorDiagnostic): void {
    this.diagnostics = [...this.diagnostics.slice(-31), diagnostic];
    if (diagnostic.degraded) this.degraded = true;
  }

  private onChannelExit(): void {
    if (this.disposed) return;
    this.settleFirstJoin();
    for (const pane of this.panesByRuntime.values()) {
      for (const sub of pane.subs) {
        if (!sub.closed) {
          sub.closed = true;
          sub.onEvent({ type: "closed" });
        }
      }
      pane.subs.clear();
    }
    this.opts.onExit?.();
  }
}
