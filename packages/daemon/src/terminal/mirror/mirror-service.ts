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
} from "./control-channel.ts";
import type { MirrorLayoutEvent, MirrorPaneEvent, MirrorSessionDescription } from "./events.ts";
import { SessionChannel } from "./session-channel.ts";

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

interface ChannelEntry {
  channel: SessionChannel;
  started: Promise<void>;
  refs: number;
}

export class MirrorService {
  private readonly opts: MirrorServiceOptions;
  private readonly channels = new Map<string, ChannelEntry>();
  private readonly pendingDisposals = new Set<Promise<void>>();
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
    const entries = [...this.channels.values()];
    this.channels.clear();
    await Promise.allSettled(entries.map((entry) => entry.channel.dispose()));
    await Promise.allSettled([...this.pendingDisposals]);
  }

  private async acquire(session: string): Promise<ChannelEntry> {
    if (this.disposed) throw new Error("MirrorService is disposed");
    let entry = this.channels.get(session);
    if (!entry) {
      const channel = new SessionChannel({
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
          }),
        historyLines: this.opts.historyLines,
        generatePaneId: this.opts.generatePaneId,
        generateWindowId: this.opts.generateWindowId,
        onExit: () => {
          // The channel died underneath its subscribers (tmux exit/detach):
          // drop the entry so the next acquire starts fresh; open handles
          // already received their `closed` events.
          if (this.channels.get(session)?.channel === channel) this.channels.delete(session);
        },
      });
      entry = { channel, started: channel.start(), refs: 0 };
      this.channels.set(session, entry);
    }
    entry.refs += 1;
    try {
      await entry.started;
    } catch (cause) {
      this.release(session, entry);
      throw cause;
    }
    return entry;
  }

  private release(session: string, entry: ChannelEntry): void {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    if (this.channels.get(session) === entry) this.channels.delete(session);
    const disposal = entry.channel.dispose().catch(() => {});
    this.pendingDisposals.add(disposal);
    void disposal.finally(() => this.pendingDisposals.delete(disposal));
  }
}
