/**
 * MirrorService — the daemon-side shared mirror layer (m43 card 1).
 *
 * One {@link SessionChannel} (one tmux control-mode client) per session with
 * at least one subscription, refcounted: the first subscriber spawns the
 * channel, the last one's departure disposes it (detach-client, drain, then
 * signals — never signals first). The public API speaks semantic pane ids
 * only; runtime `%N` addresses live and die inside the channel.
 *
 * Non-goals here (next cards): the wire/WS endpoint, renderers, leases and
 * ownership, PTY-path changes.
 */
import {
  MirrorControlChannel,
  type MirrorChannelHandlers,
  type MirrorChannelIo,
  type MirrorOutputTiming,
} from "./control-channel.ts";
import type { MirrorLayoutEvent, MirrorPaneEvent, MirrorSessionDescription } from "./events.ts";
import { SessionChannel, type SessionChannelOptions } from "./session-channel.ts";
import type { InputAction } from "../protocol/input-coalescer.ts";
import {
  controlModeAuthorityKey,
  processControlModeOwnershipRegistry,
  type ControlModeOwnershipRegistry,
} from "./control-mode-ownership.ts";

export interface MirrorServiceOptions {
  /** `tmux -L <name>` for every channel — isolated servers in tests. */
  socketName?: string;
  /** `tmux -S <path>` for every channel — the daemon's socket authority. */
  socketPath?: string;
  /** Absolute tmux executable; defaults to `tmux` on PATH. */
  executable?: string;
  /** `tmux -f <file>` — tests pass /dev/null. */
  configFile?: string;
  pauseAfterSeconds?: number;
  historyLines?: number;
  /** Test seam: replace the spawned control channel per session. */
  createIo?: (session: string, handlers: MirrorChannelHandlers) => MirrorChannelIo;
  generatePaneId?: () => string;
  generateWindowId?: () => string;
  /** Test seam; production uses the daemon-generation process registry. */
  controlModeOwnershipRegistry?: ControlModeOwnershipRegistry;
  /** Emitted only after an event-triggered list-clients proof of a native client. */
  onNativeClientActivity?: (session: string) => void;
  onInputWrite?: (
    session: string,
    action: InputAction,
    startedAtMicros: number,
    endedAtMicros: number,
    pendingBeforeSend: number,
  ) => void;
  onInputAccepted?: (session: string, action: InputAction, acceptedAtMicros: number) => void;
  onOutputObserved?: (
    session: string,
    semanticPaneId: string,
    ageMs: number | null,
    timing?: MirrorOutputTiming,
  ) => void;
  /** Qualification-only clock; absent from production's disabled observer. */
  nowMicros?: () => number;
}

export interface MirrorSubscribeRequest {
  session: string;
  semanticPaneId: string;
  onEvent: (event: MirrorPaneEvent) => void;
  onLayout?: (event: MirrorLayoutEvent) => void;
}

export interface MirrorSubscription {
  readonly session: string;
  readonly semanticPaneId: string;
  /** Park delivery for this subscriber (offscreen freeze). Siblings and other
   *  subscribers of the same pane are untouched. */
  freeze(): void;
  /** Resume after a freeze: continue + a fresh atomic seed batch. */
  thaw(): void;
  sendText(text: string): void;
  sendKey(key: string): void;
  close(): Promise<void>;
}

export interface MirrorLayoutSubscription {
  readonly session: string;
  close(): Promise<void>;
}

export interface MirrorSessionRetention {
  readonly session: string;
  close(): Promise<void>;
}

interface ChannelEntry {
  channel: SessionChannel;
  started: Promise<void>;
  refs: number;
  releaseAuthority: () => void;
  retired: boolean;
}

export class MirrorService {
  private readonly opts: MirrorServiceOptions;
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly pendingDisposals = new Set<Promise<void>>();
  private readonly drainingChannels = new Map<string, Promise<void>>();
  private readonly sessionExitListeners = new Set<(session: string) => void>();
  private readonly owner = Symbol("MirrorService control-mode owner");
  private disposed = false;

  constructor(opts: MirrorServiceOptions = {}) {
    this.opts = opts;
  }

  /** Enumerate a session's panes under semantic identity (spinning the
   *  channel up if needed; it is released again when no subscription holds it). */
  async describeSession(session: string): Promise<MirrorSessionDescription> {
    const entry = await this.acquire(session);
    try {
      return entry.channel.describe();
    } finally {
      this.release(session, entry);
    }
  }

  async subscribe(request: MirrorSubscribeRequest): Promise<MirrorSubscription> {
    const entry = await this.acquire(request.session);
    let handle;
    try {
      handle = entry.channel.subscribePane(
        request.semanticPaneId,
        request.onEvent,
        request.onLayout,
      );
    } catch (cause) {
      this.release(request.session, entry);
      throw cause;
    }
    let closed = false;
    return {
      session: request.session,
      semanticPaneId: request.semanticPaneId,
      freeze: () => handle.freeze(),
      thaw: () => handle.thaw(),
      sendText: (text) => handle.sendText(text),
      sendKey: (key) => handle.sendKey(key),
      close: async () => {
        if (closed) return;
        closed = true;
        handle.close();
        this.release(request.session, entry);
        await Promise.allSettled([...this.pendingDisposals]);
      },
    };
  }

  /** Retain one session channel for layout only; no pane feed or seed is created. */
  async subscribeLayout(
    session: string,
    onLayout: (event: MirrorLayoutEvent) => void,
  ): Promise<MirrorLayoutSubscription> {
    const entry = await this.acquire(session);
    let handle;
    try {
      handle = entry.channel.subscribeLayout(onLayout);
    } catch (cause) {
      this.release(session, entry);
      throw cause;
    }
    let closed = false;
    return {
      session,
      close: async () => {
        if (closed) return;
        closed = true;
        handle.close();
        this.release(session, entry);
        await Promise.allSettled([...this.pendingDisposals]);
      },
    };
  }

  /** Synchronous hot input on an already-retained SessionRuntime channel. */
  sendText(
    session: string,
    semanticPaneId: string,
    text: string,
    performanceTraceId?: string,
  ): void {
    const entry = this.channels.get(session);
    if (!entry || entry.retired) throw new Error(`Mirror session ${session} is unavailable`);
    entry.channel.sendText(semanticPaneId, text, performanceTraceId);
  }

  sendKey(session: string, semanticPaneId: string, key: string, performanceTraceId?: string): void {
    const entry = this.channels.get(session);
    if (!entry || entry.retired) throw new Error(`Mirror session ${session} is unavailable`);
    entry.channel.sendKey(semanticPaneId, key, performanceTraceId);
  }

  fitViewport(session: string, cols: number, rows: number): void {
    const entry = this.channels.get(session);
    if (!entry || entry.retired) throw new Error(`Mirror session ${session} is unavailable`);
    entry.channel.fitViewport(cols, rows);
  }

  /** Keep the retained control client passive unless the arbiter elects it. */
  setGeometryParticipation(session: string, active: boolean): void {
    const entry = this.channels.get(session);
    if (!entry || entry.retired) return;
    entry.channel.setGeometryParticipation(active);
  }

  /**
   * Keep one session channel alive independently of renderer subscriptions.
   * The daemon SessionRuntime registry owns this retention; clients never do.
   */
  async retainSession(session: string): Promise<MirrorSessionRetention> {
    const entry = await this.acquire(session);
    let closed = false;
    return {
      session,
      close: async () => {
        if (closed) return;
        closed = true;
        this.release(session, entry);
        await Promise.allSettled([...this.pendingDisposals]);
      },
    };
  }

  /** SessionRuntime's reconnect seam; runtime addresses never cross it. */
  onSessionExit(listener: (session: string) => void): () => void {
    if (this.disposed) throw new Error("MirrorService is disposed");
    this.sessionExitListeners.add(listener);
    return () => this.sessionExitListeners.delete(listener);
  }

  /** Fall-behind telemetry for an ACTIVE session channel; null when no
   *  channel is running for the session. */
  ageTelemetry(session: string): { maxAgeMs: number; byPane: Record<string, number> } | null {
    return this.channels.get(session)?.channel.ageTelemetry() ?? null;
  }

  /** Flow-ledger snapshot (semantic ids) for an ACTIVE session channel. */
  flowSnapshot(session: string): { backpressured: string[]; requested: string[] } | null {
    return this.channels.get(session)?.channel.flowSnapshot() ?? null;
  }

  activeChannelCount(): number {
    return this.channels.size;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.sessionExitListeners.clear();
    const entries = [...this.channels.values()];
    this.channels.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        entry.retired = true;
        try {
          await entry.channel.dispose();
        } finally {
          entry.releaseAuthority();
        }
      }),
    );
    await Promise.allSettled([...this.pendingDisposals]);
  }

  private async acquire(session: string): Promise<ChannelEntry> {
    if (this.disposed) throw new Error("MirrorService is disposed");
    await this.drainingChannels.get(session);
    if (this.disposed) throw new Error("MirrorService is disposed");
    let entry = this.channels.get(session);
    if (!entry) {
      const releaseAuthority = (
        this.opts.controlModeOwnershipRegistry ?? processControlModeOwnershipRegistry
      ).claim(
        controlModeAuthorityKey(session, {
          socketName: this.opts.socketName,
          socketPath: this.opts.socketPath,
        }),
        this.owner,
      );
      let channel: SessionChannel;
      try {
        const channelOptions: SessionChannelOptions = {
          session,
          createIo: (handlers) =>
            this.opts.createIo?.(session, handlers) ??
            new MirrorControlChannel({
              session,
              handlers,
              socketName: this.opts.socketName,
              socketPath: this.opts.socketPath,
              executable: this.opts.executable,
              configFile: this.opts.configFile,
              pauseAfterSeconds: this.opts.pauseAfterSeconds,
              nowMicros: this.opts.nowMicros,
            }),
          historyLines: this.opts.historyLines,
          generatePaneId: this.opts.generatePaneId,
          generateWindowId: this.opts.generateWindowId,
          onExit: () => {
            // The channel died underneath its subscribers (tmux exit/detach):
            // drop the entry so the next acquire starts fresh; open handles
            // already received their `closed` events.
            const active = this.channels.get(session);
            if (active?.channel === channel) {
              this.retire(session, active);
              for (const listener of this.sessionExitListeners) listener(session);
            }
          },
          onNativeClientActivity: () => this.opts.onNativeClientActivity?.(session),
          onInputWrite: (action, startedAtMicros, endedAtMicros, pendingBeforeSend) =>
            this.opts.onInputWrite?.(
              session,
              action,
              startedAtMicros,
              endedAtMicros,
              pendingBeforeSend,
            ),
          onInputAccepted: (action, acceptedAtMicros) =>
            this.opts.onInputAccepted?.(session, action, acceptedAtMicros),
          onOutputObserved: (semanticPaneId, ageMs, timing) =>
            this.opts.onOutputObserved?.(session, semanticPaneId, ageMs, timing),
        };
        channel = new SessionChannel(channelOptions);
      } catch (cause) {
        releaseAuthority();
        throw cause;
      }
      entry = {
        channel,
        started: channel.start(),
        refs: 0,
        releaseAuthority,
        retired: false,
      };
      this.channels.set(session, entry);
    }
    entry.refs += 1;
    try {
      await entry.started;
    } catch (cause) {
      this.release(session, entry);
      throw cause;
    }
    // A control client can exit after its start promise settles but before this
    // continuation runs. Never hand that retired entry to a caller as ready:
    // release its provisional ref, wait for the drain, and acquire the single
    // successor through the same ownership path.
    if (entry.retired) {
      this.release(session, entry);
      return await this.acquire(session);
    }
    return entry;
  }

  private release(session: string, entry: ChannelEntry): void {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.retire(session, entry);
  }

  private retire(session: string, entry: ChannelEntry): void {
    if (entry.retired) return;
    entry.retired = true;
    if (this.channels.get(session) === entry) this.channels.delete(session);
    const disposal = entry.channel
      .dispose()
      .catch(() => {})
      .finally(() => entry.releaseAuthority());
    this.drainingChannels.set(session, disposal);
    this.pendingDisposals.add(disposal);
    void disposal.finally(() => {
      this.pendingDisposals.delete(disposal);
      if (this.drainingChannels.get(session) === disposal) this.drainingChannels.delete(session);
    });
  }
}
