/**
 * SessionMirror — a whole tmux window rendered through one control client.
 *
 * The multi-pane composition of the proven single-pane pipeline: one
 * {@link ControlModeClient} attaches to the session, `refresh-client -C`
 * pins the virtual client size to our render area (so tmux computes pane
 * layout for OUR grid), and every pane of the active window gets a
 * {@link PaneMirror} fed by routed `%output` bytes. Layout notifications
 * (`%layout-change`, `%window-pane-changed`, …) trigger a re-sync that
 * diffs geometry and creates/resizes/disposes mirrors incrementally.
 *
 * tmux remains the multiplexer, PTY owner, and source of layout truth —
 * this class owns nothing but mirrors and routing. The pure helpers
 * ({@link parsePaneGeometry}, {@link diffPanes}) carry the logic and are
 * unit-tested without tmux.
 */
import { appendFileSync } from "node:fs";
import { ControlModeClient } from "./control-client.ts";
import { PaneMirror, type MirrorSnapshot } from "./pane-mirror.ts";

/** One pane's geometry inside the window, in cells (tmux coordinates). */
export interface PaneGeometry {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  active: boolean;
}

/** PURE — parse `list-panes -F "#{pane_id} #{pane_left} …"` reply lines. */
export function parsePaneGeometry(lines: string[]): PaneGeometry[] {
  const panes: PaneGeometry[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [id = "", left = "", top = "", width = "", height = "", active = ""] = parts;
    if (!id.startsWith("%")) continue;
    const nums = [left, top, width, height].map(Number);
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) continue;
    panes.push({
      id,
      left: nums[0]!,
      top: nums[1]!,
      width: nums[2]!,
      height: nums[3]!,
      active: active === "1",
    });
  }
  return panes;
}

/** PURE — what changed between two layouts, keyed by pane id. */
export function diffPanes(
  prev: PaneGeometry[],
  next: PaneGeometry[],
): { added: PaneGeometry[]; removed: string[]; resized: PaneGeometry[]; moved: PaneGeometry[] } {
  const prevById = new Map(prev.map((p) => [p.id, p]));
  const nextIds = new Set(next.map((p) => p.id));
  const added: PaneGeometry[] = [];
  const resized: PaneGeometry[] = [];
  const moved: PaneGeometry[] = [];
  for (const pane of next) {
    const was = prevById.get(pane.id);
    if (!was) {
      added.push(pane);
    } else if (was.width !== pane.width || was.height !== pane.height) {
      resized.push(pane);
    } else if (was.left !== pane.left || was.top !== pane.top) {
      moved.push(pane);
    }
  }
  const removed = prev.filter((p) => !nextIds.has(p.id)).map((p) => p.id);
  return { added, removed, resized, moved };
}

/** A live pane: geometry + its mirror. */
export interface LivePane extends PaneGeometry {
  snapshot: MirrorSnapshot;
}

export interface SessionMirrorOptions {
  target: string;
  /** Render-area size in cells (the control client is pinned to this). */
  cols: number;
  rows: number;
  /** Called whenever any pane's content or the layout changed (coalesce upstream). */
  onDirty?: () => void;
  onStatus?: (msg: string) => void;
  onExit?: () => void;
}

/** Control-mode notifications (sans `%`) that mean "the layout changed". */
const STRUCTURAL_NOTIFICATIONS = new Set([
  "layout-change",
  "window-add",
  "window-close",
  "window-pane-changed",
  "session-window-changed",
  "unlinked-window-close",
]);

export class SessionMirror {
  private readonly client: ControlModeClient;
  private readonly mirrors = new Map<string, PaneMirror>();
  private geometry: PaneGeometry[] = [];
  private focused = "";
  private syncQueued = false;
  private readonly opts: SessionMirrorOptions;

  constructor(opts: SessionMirrorOptions) {
    this.opts = opts;
    this.client = new ControlModeClient({
      attachTarget: opts.target,
      onOutput: (pane, data) => {
        this.mirrors.get(pane)?.write(data);
        opts.onDirty?.();
      },
      onNotify: (name) => {
        if (process.env.TMUX_IDE_MIRROR_DEBUG) {
          try {
            appendFileSync("/tmp/zz-notify.log", name + "\n");
          } catch {
            // debug tap only
          }
        }
        // Any structural notification re-syncs the layout; the debounce keeps
        // bursts (e.g. a resize storm) to one list-panes round-trip. NOTE:
        // parseControlLine strips the leading `%` from notification names.
        if (STRUCTURAL_NOTIFICATIONS.has(name)) {
          this.queueSync();
        }
      },
      onExit: () => opts.onExit?.(),
    });
  }

  async start(): Promise<void> {
    await this.client.start();
    await this.client.command(`refresh-client -C ${this.opts.cols}x${this.opts.rows}`);
    await this.sync();
  }

  /** The current panes with fresh grid snapshots, render-ready. */
  panes(): LivePane[] {
    return this.geometry.map((g) => ({
      ...g,
      active: g.id === this.focused || (this.focused === "" && g.active),
      snapshot:
        this.mirrors.get(g.id)?.snapshot() ?? ({ rows: [], cursorX: 0, cursorY: 0 } as const),
    }));
  }

  focusedPane(): string {
    return this.focused || this.geometry.find((g) => g.active)?.id || "";
  }

  /** Focus a pane locally AND in tmux (so splits/new panes open where expected). */
  focus(id: string): void {
    if (!this.geometry.some((g) => g.id === id)) return;
    this.focused = id;
    void this.client.command(`select-pane -t ${id}`).catch(() => {});
    this.opts.onDirty?.();
  }

  sendText(text: string): Promise<unknown> {
    const pane = this.focusedPane();
    return pane ? this.client.sendText(pane, text) : Promise.resolve();
  }

  sendKey(key: string): Promise<unknown> {
    const pane = this.focusedPane();
    return pane ? this.client.sendKey(pane, key) : Promise.resolve();
  }

  /** Run any tmux command over the control channel (splits, zoom, …). */
  command(cmd: string): Promise<string[]> {
    return this.client.command(cmd);
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.opts.cols = cols;
    this.opts.rows = rows;
    await this.client.command(`refresh-client -C ${cols}x${rows}`).catch(() => {});
    this.queueSync();
  }

  dispose(): void {
    this.client.dispose();
    for (const m of this.mirrors.values()) m.dispose();
    this.mirrors.clear();
  }

  private queueSync(): void {
    if (this.syncQueued) return;
    this.syncQueued = true;
    setTimeout(() => {
      this.syncQueued = false;
      void this.sync().catch(() => {});
    }, 40);
  }

  private async sync(): Promise<void> {
    const lines = await this.client.command(
      `list-panes -t ${this.opts.target} -F "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_active}"`,
    );
    const next = parsePaneGeometry(lines);
    const { added, removed, resized } = diffPanes(this.geometry, next);

    for (const id of removed) {
      this.mirrors.get(id)?.dispose();
      this.mirrors.delete(id);
      if (this.focused === id) this.focused = "";
    }
    for (const pane of added) {
      const mirror = new PaneMirror(pane.width, pane.height);
      this.mirrors.set(pane.id, mirror);
      // Seed with current content (-e keeps colors) so panes never pop blank.
      const seed = await this.client.command(`capture-pane -p -e -t ${pane.id}`).catch(() => []);
      if (seed.length > 0) mirror.write(seed.join("\r\n") + "\r\n");
    }
    for (const pane of resized) {
      this.mirrors.get(pane.id)?.resize(pane.width, pane.height);
    }

    this.geometry = next;
    this.opts.onStatus?.(`${next.length} panes`);
    this.opts.onDirty?.();
  }
}
