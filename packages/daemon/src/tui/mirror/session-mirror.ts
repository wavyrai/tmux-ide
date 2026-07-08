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
import { execFileSync } from "node:child_process";
import { ControlModeClient } from "./control-client.ts";
import { InputCoalescer } from "./input-coalescer.ts";
import {
  PaneMirror,
  type MirrorSnapshot,
  type BlitOptions,
  type CursorState,
} from "./pane-mirror.ts";
import type { CellArrays } from "./blit.ts";
import { tapInputOutput, tapRepin } from "./perf-tap.ts";

/** One pane's geometry inside the window, in cells (tmux coordinates). */
export interface PaneGeometry {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  active: boolean;
  /** The pane's APP turned mouse reporting on (forward real SGR events). */
  appMouse: boolean;
  /** The pane's WINDOW is zoomed (`#{window_zoomed_flag}`). A window property, so
   *  every pane of the same window reports the same value; the app reads it off
   *  the focused pane to tint the zoom button and show the `[Z]` chip. */
  zoomed: boolean;
}

/** PURE — parse `list-panes -F "#{pane_id} #{pane_left} …"` reply lines. The
 *  trailing `window_zoomed_flag` field is optional (absent lines parse as not
 *  zoomed) so older format strings and fixtures stay valid. */
export function parsePaneGeometry(lines: string[]): PaneGeometry[] {
  const panes: PaneGeometry[] = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const [
      id = "",
      left = "",
      top = "",
      width = "",
      height = "",
      active = "",
      mouse = "",
      zoomed = "",
    ] = parts;
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
      appMouse: mouse === "1",
      zoomed: zoomed === "1",
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

/** A live pane: geometry + its mirror snapshot. */
export interface LivePane extends PaneGeometry {
  snapshot: MirrorSnapshot;
  /** Lines available above the live viewport (scrollback budget). */
  scrollbackDepth: number;
  /** Per-pane content version (M21.4) — the `<pane_surface>` gates its walk on
   *  this, so an unchanged pane never re-reads its grid. */
  version: number;
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
  "window-renamed",
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
  /** Size policy (M22.8). "auto" (default): we pin our virtual client size via
   *  `refresh-client -C` and let tmux's `window-size latest` cooperate — a
   *  co-attached terminal may win, which we surface honestly rather than fight.
   *  "manual": the user asked us to reclaim the window ({@link resizeToFit}), so
   *  we set `window-size manual` + `resize-window` (the ONLY mechanism that holds
   *  against a bigger real client — measured; plain `refresh-client -C` does not
   *  re-win once another client is latest). Manual is a WINDOW option that
   *  lingers past our detach, so {@link dispose} reverts it. */
  private sizeMode: "auto" | "manual" = "auto";
  private readonly opts: SessionMirrorOptions;
  /** The input fast path (M21.5): literals coalesce per pane and flush on a
   *  microtask (same macrotask as the keystroke — no added latency); named
   *  keys flush pending literals first so ordering is preserved; everything
   *  leaves via the control client's fire-and-forget write. */
  private readonly input = new InputCoalescer(
    (a) => {
      if (a.kind === "literal") this.client.sendText(a.pane, a.text);
      else this.client.sendKey(a.pane, a.key);
    },
    (flush) => queueMicrotask(flush),
  );

  constructor(opts: SessionMirrorOptions) {
    this.opts = opts;
    this.client = new ControlModeClient({
      attachTarget: opts.target,
      onOutput: (pane, data) => {
        tapInputOutput(pane); // t1: first echo back for a key we just forwarded
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

  /**
   * The current panes with fresh grid snapshots, render-ready.
   *
   * @param scrollOffsets Per-pane scrollback offsets (lines above live view);
   *   panes absent from the map render live. The focused pane gets its cursor
   *   painted.
   * @param includeRows Serialize each pane's styled rows. `false` (the
   *   framebuffer-blit path, M21.3) returns geometry + cursor/offset only and
   *   skips the run rebuild — the `<pane_surface>` reads cells via {@link blitPane}.
   */
  panes(scrollOffsets?: ReadonlyMap<string, number>, includeRows = true): LivePane[] {
    const focused = this.focusedPane();
    return this.geometry.map((g) => {
      const mirror = this.mirrors.get(g.id);
      const offset = scrollOffsets?.get(g.id) ?? 0;
      return {
        ...g,
        active: g.id === this.focused || (this.focused === "" && g.active),
        scrollbackDepth: mirror?.scrollbackDepth() ?? 0,
        version: mirror?.contentVersion() ?? 0,
        snapshot:
          mirror?.snapshot(offset, g.id === focused, includeRows) ??
          ({ rows: [], cursorX: 0, cursorY: 0, scrollOffset: 0 } as const),
      };
    });
  }

  /** Blit a pane's visible grid into a framebuffer's packed arrays (M21.3) — the
   *  `<pane_surface>` render path. No-op for an unknown pane. See
   *  {@link PaneMirror.blit}. */
  blitPane(
    id: string,
    buffers: CellArrays,
    width: number,
    height: number,
    scrollOffset: number,
    defaultFg: number,
    defaultBg: number,
    opts: BlitOptions,
  ): void {
    this.mirrors.get(id)?.blit(buffers, width, height, scrollOffset, defaultFg, defaultBg, opts);
  }

  /** A pane's visible rows as plain text — the on-demand OSC52 copy read for the
   *  blit path (which omits styled rows). Empty for an unknown pane. */
  visibleRowTexts(id: string, scrollOffset = 0): string[] {
    return this.mirrors.get(id)?.visibleRowTexts(scrollOffset) ?? [];
  }

  /** A pane's live cursor state (position + DECTCEM/DECSCUSR), for the hardware
   *  cursor (M21.6). Null for an unknown pane. */
  cursorState(id: string): CursorState | null {
    return this.mirrors.get(id)?.cursorState() ?? null;
  }

  focusedPane(): string {
    return this.focused || this.geometry.find((g) => g.active)?.id || "";
  }

  /** The whole mirror buffer (scrollback + viewport) of a pane as plain text
   *  lines — the corpus for scrollback search. Empty for an unknown pane. */
  bufferLines(paneId: string): string[] {
    return this.mirrors.get(paneId)?.bufferLines() ?? [];
  }

  /** Focus a pane locally AND in tmux (so splits/new panes open where expected). */
  focus(id: string): void {
    if (!this.geometry.some((g) => g.id === id)) return;
    this.focused = id;
    void this.command(`select-pane -t ${id}`).catch(() => {});
    this.opts.onDirty?.();
  }

  /** Type literal text into the focused pane — coalesced, fire-and-forget. */
  sendText(text: string): void {
    const pane = this.focusedPane();
    if (pane) this.input.literal(pane, text);
  }

  /** Send a named tmux key to the focused pane — fire-and-forget, after any
   *  pending literal batch (ordering invariant). */
  sendKey(key: string): void {
    const pane = this.focusedPane();
    if (pane) this.input.key(pane, key);
  }

  /** Run any tmux command over the control channel (splits, zoom, …).
   *  Pending coalesced input flushes FIRST so a structural command can never
   *  overtake keystrokes typed before it. */
  command(cmd: string): Promise<string[]> {
    this.input.flush();
    return this.client.command(cmd);
  }

  /** Windows (tabs) of the mirrored session, for the app's tab strip. `sync` is
   *  the window's `synchronize-panes` option (`#{?synchronize-panes,1,0}`) — a
   *  window property, so it rides here alongside index/name/active and the app
   *  reads the active window's value to drive the `[SYNC]` chip. */
  async windows(): Promise<Array<{ index: number; name: string; active: boolean; sync: boolean }>> {
    const lines = await this.client
      .command(
        `list-windows -t ${this.opts.target} -F "#{window_index}\t#{window_name}\t#{window_active}\t#{?synchronize-panes,1,0}"`,
      )
      .catch(() => [] as string[]);
    return lines
      .map((l) => l.split("\t"))
      .filter((p) => p.length >= 3)
      .map(([i = "", name = "", active = "", sync = ""]) => ({
        index: Number(i),
        name,
        active: active === "1",
        sync: sync === "1",
      }))
      .filter((w) => Number.isInteger(w.index));
  }

  /** Switch the mirrored session's active window (the tab click). */
  switchWindow(index: number): void {
    void this.command(`select-window -t ${this.opts.target}:${index}`).catch(() => {});
    this.queueSync();
  }

  /** Type raw text (incl. escape sequences — mouse SGR, paste chunks) into a
   *  SPECIFIC pane — coalesced with typed literals, fire-and-forget. */
  sendTextTo(pane: string, text: string): void {
    this.input.literal(pane, text);
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.opts.cols = cols;
    this.opts.rows = rows;
    tapRepin(cols, rows); // debug tap: assert one re-pin per settled size change
    await this.client.command(`refresh-client -C ${cols}x${rows}`).catch(() => {});
    // Under the manual policy `refresh-client -C` no longer drives the window
    // size, so a terminal/sidebar resize after a reclaim must resize the window
    // directly to keep it matched to our canvas.
    if (this.sizeMode === "manual") {
      await this.client
        .command(`resize-window -t ${this.opts.target} -x ${cols} -y ${rows}`)
        .catch(() => {});
    }
    this.queueSync();
  }

  /**
   * Reclaim the window at our current canvas size (M22.8 — the palette's "Resize
   * to fit this window"). A co-attached smaller terminal wins `window-size
   * latest`; the ONLY mechanism that overrides it and HOLDS is `window-size
   * manual` + `resize-window` (measured — a bare `refresh-client -C` re-issue
   * does not re-win). We flip to the manual policy so subsequent resizes keep the
   * window matched, and {@link dispose} reverts the option on detach.
   */
  async resizeToFit(): Promise<void> {
    const { cols, rows } = this.opts;
    this.sizeMode = "manual";
    await this.client.command(`refresh-client -C ${cols}x${rows}`).catch(() => {});
    await this.client
      .command(`set-window-option -t ${this.opts.target} window-size manual`)
      .catch(() => {});
    await this.client
      .command(`resize-window -t ${this.opts.target} -x ${cols} -y ${rows}`)
      .catch(() => {});
    this.queueSync();
  }

  dispose(): void {
    this.input.flush(); // last typed bytes leave before the detach
    // Detach cleanliness (M22.8): a `window-size manual` override we set to
    // reclaim the window lingers on the session past our client's death — it
    // would leave a still-attached real terminal permanently letterboxed. Revert
    // it out-of-band (a plain tmux call, independent of the control client we are
    // about to tear down) so the remaining clients reclaim their own size. The
    // "auto" policy needs no cleanup: tmux drops our size vote when the control
    // client dies (measured). Sync + guarded — dispose runs at shutdown/re-attach,
    // not the render loop, and correctness here outranks the brief block.
    if (this.sizeMode === "manual") {
      try {
        execFileSync("tmux", ["set-window-option", "-t", this.opts.target, "-u", "window-size"], {
          stdio: "ignore",
        });
      } catch {
        // best-effort revert; the session may already be gone
      }
      this.sizeMode = "auto";
    }
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
      `list-panes -t ${this.opts.target} -F "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_active} #{mouse_any_flag} #{window_zoomed_flag}"`,
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
      // Dirty must re-arm when bytes have PARSED, not just when they were
      // enqueued (onOutput) — with ack-paced writes an enqueue-time dirty can
      // be consumed by the tick before the grid changed, dropping the frame.
      mirror.onParsed = () => this.opts.onDirty?.();
      this.mirrors.set(pane.id, mirror);
      // Seed with history + current screen (-e keeps colors, -S reaches back
      // into tmux's scrollback, 2000 lines. The old 300 cap guarded a SYNC seed
      // write that blocked the event loop; with ack-paced writes (M21.5) the
      // write just enqueues (~0.01ms) and xterm parses async — 2000 lines parse
      // in ~8ms off the render loop (measured), so the deeper history is free.
      // -J joins wrapped lines so re-wrapping stays sane.
      const seed = await this.client
        .command(`capture-pane -p -e -J -S -2000 -t ${pane.id}`)
        .catch(() => []);
      // The control client reads replies as latin1 (one JS char per byte —
      // required for the protocol), so the seed is a byte string in disguise:
      // re-encode latin1 → bytes before feeding the VT parser, or every
      // multibyte glyph shatters into mojibake (…→â¦, ⇡→â¡ — user-reported,
      // "weird a's with a roof"). The live %output path already decodes bytes.
      if (seed.length > 0) {
        mirror.write(Buffer.from(seed.join("\r\n") + "\r\n", "latin1"));
      }
    }
    for (const pane of resized) {
      this.mirrors.get(pane.id)?.resize(pane.width, pane.height);
    }

    this.geometry = next;
    this.opts.onStatus?.(`${next.length} panes`);
    this.opts.onDirty?.();
  }
}
