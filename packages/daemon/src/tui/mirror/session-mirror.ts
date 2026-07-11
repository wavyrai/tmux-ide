/**
 * SessionMirror — a whole tmux window rendered through one control client.
 *
 * The multi-pane composition of the proven single-pane pipeline: one
 * {@link ControlModeClient} attaches to the session, `refresh-client -C`
 * pins the virtual client size to our render area (so tmux computes pane
 * layout for OUR grid), and every pane of the active window gets a
 * {@link PaneMirror} fed by routed `%output` bytes.
 *
 * GEOMETRY IS EVENT-DRIVEN (M23.5). `%layout-change` arrives sub-ms after the
 * server applies a layout and ALWAYS precedes the first new-size `%output`
 * (measured on 3.7b: as little as 0.2ms ahead) — so the notification PAYLOAD
 * itself (the visible-layout string, parsed by layout-parse.ts) resizes the
 * PaneMirrors SYNCHRONOUSLY in the same event-loop turn. The old 40ms-debounced
 * `list-panes` hop let new-size redraws parse into stale-sized xterms, which
 * corrupted redraw-once apps (vim/less/shells) PERMANENTLY. A slow list-panes
 * `sync` remains as the attach seed, the reconciler behind uncertain events,
 * the flag source, and the ONLY owner of mirror disposal. `%window-pane-changed`
 * drives the active pane; one `refresh-client -B` subscription pushes per-pane
 * `mouse_any_flag` (~1s cadence, `%subscription-changed`).
 *
 * tmux remains the multiplexer, PTY owner, and source of layout truth —
 * this class owns nothing but mirrors and routing. The pure helpers
 * ({@link parsePaneGeometry}, {@link geometryFromLeaves}, layout-parse.ts)
 * carry the logic and are unit-tested without tmux.
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
import { tapInputOutput, tapRepin, tapResize } from "./perf-tap.ts";
import {
  parseLayout,
  parseLayoutChange,
  parseWindowPaneChanged,
  parseSessionWindowChanged,
  parseMouseSubscription,
  type LayoutLeaf,
} from "./layout-parse.ts";
import { effectiveWindowSize, type Size } from "./size-truth.ts";

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
 *  zoomed) so older format strings and fixtures stay valid; any further
 *  trailing fields (sync appends `window_id`) are ignored here. */
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

/** PURE — visible geometry from parsed layout leaves (M23.5). A layout string
 *  carries rects only, so the flags it can't encode merge in from elsewhere:
 *  `active` from the tracked active pane (falling back to the previous
 *  geometry's flag while it is still unknown), `appMouse` from the
 *  subscription-fed map (then the previous flag, then false for a brand-new
 *  pane), `zoomed` from the notification's flags field. */
export function geometryFromLeaves(
  leaves: readonly LayoutLeaf[],
  prev: readonly PaneGeometry[],
  activePane: string,
  appMouse: ReadonlyMap<string, boolean>,
  zoomed: boolean,
): PaneGeometry[] {
  const prevById = new Map(prev.map((p) => [p.id, p]));
  return leaves.map((l) => {
    const was = prevById.get(l.id);
    return {
      id: l.id,
      left: l.left,
      top: l.top,
      width: l.width,
      height: l.height,
      active: activePane ? l.id === activePane : (was?.active ?? false),
      appMouse: appMouse.get(l.id) ?? was?.appMouse ?? false,
      zoomed,
    };
  });
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

/** Control-mode notifications (sans `%`) that still fall back to the slow
 *  re-sync — structure changed but the notification body doesn't carry enough
 *  to apply it directly (layout-change / window-pane-changed /
 *  session-window-changed have their own push handlers now). */
const STRUCTURAL_NOTIFICATIONS = new Set([
  "window-add",
  "window-close",
  "window-renamed",
  "unlinked-window-close",
]);

export class SessionMirror {
  private readonly client: ControlModeClient;
  private readonly mirrors = new Map<string, PaneMirror>();
  private geometry: PaneGeometry[] = [];
  private focused = "";
  private syncQueued = false;
  // ── Push-geometry state (M23.5) ─────────────────────────────────────────
  /** The mirrored session's active window id (`@N`) — gates which
   *  `%layout-change` events apply. Learned by sync, updated by
   *  `%session-window-changed`. Empty until the first sync lands. */
  private activeWindow = "";
  /** tmux's active pane (`%N`) — from `%window-pane-changed` and sync. */
  private activePane = "";
  /** The active window is zoomed (flags `*Z` / `window_zoomed_flag`). */
  private zoomedNow = false;
  /** Last APPLIED visible-layout string — dedupes notification bursts (every
   *  payload of a burst carries the final layout; the checksum differs iff the
   *  layout does). Reset on window switch so the new window's first layout
   *  always applies. */
  private lastVisibleLayout = "";
  /** The window's authoritative size: the latest layout root's WxH
   *  (event-driven), seeded/reconciled by sync's pane bounding box. */
  private winSize: Size | null = null;
  /** Per-pane `mouse_any_flag`, pushed by the control-mode subscription and
   *  reconciled by sync — the fix for the latent missed-toggle (a pane
   *  flipping mouse mode between two syncs was never re-read). */
  private readonly appMouseByPane = new Map<string, boolean>();
  /** Mirrors created (at correct size) whose CONTENT seed (capture-pane
   *  history + screen + cursor) hasn't run yet — sync drains this. */
  private readonly unseeded = new Set<string>();
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
        const mirror = this.mirrors.get(pane);
        if (process.env.TMUX_IDE_ZZ_RESIZE_TAP && mirror) {
          tapResize("output", `${pane} ${mirror.cols}x${mirror.rows} ${data.length}b`);
        }
        mirror?.write(data);
        opts.onDirty?.();
      },
      onNotify: (name, rest) => {
        if (process.env.TMUX_IDE_MIRROR_DEBUG) {
          try {
            appendFileSync("/tmp/zz-notify.log", name + "\n");
          } catch {
            // debug tap only
          }
        }
        // NOTE: parseControlLine strips the leading `%` from notification
        // names. Geometry-bearing notifications apply DIRECTLY from their
        // payload (the M23.5 push path — see each handler); everything else
        // structural falls back to the debounced re-sync.
        if (name === "layout-change") this.onLayoutChange(rest);
        else if (name === "window-pane-changed") this.onWindowPaneChanged(rest);
        else if (name === "subscription-changed") this.onSubscriptionChanged(rest);
        else if (name === "session-window-changed") this.onSessionWindowChanged(rest);
        else if (STRUCTURAL_NOTIFICATIONS.has(name)) this.queueSync();
      },
      onExit: () => opts.onExit?.(),
    });
  }

  async start(): Promise<void> {
    await this.client.start();
    await this.client.command(`refresh-client -C ${this.opts.cols}x${this.opts.rows}`);
    // ONE control-mode subscription (M23.5): tmux re-evaluates the format on
    // its ~1s tick and pushes `%subscription-changed` per pane on change — the
    // push source for appMouse. The argument is DOUBLE-QUOTED on the control
    // channel (the measured working form; see layout-parse.ts for the reply
    // shape). Best-effort: an old tmux without -B just degrades to sync-only.
    await this.client.command(`refresh-client -B "mouse:%*:#{mouse_any_flag}"`).catch(() => {});
    await this.sync();
  }

  /** The mirrored window's authoritative size (layout root WxH), or null
   *  before the first layout/sync — the app's event-driven size truth. */
  windowSize(): Size | null {
    return this.winSize;
  }

  // ── The push-geometry handlers (M23.5) ─────────────────────────────────

  /**
   * `%layout-change` → parse the VISIBLE layout and resize mirrors NOW —
   * synchronously, in the same event-loop turn, BEFORE the control client
   * feeds any subsequent `%output` line (resize-first is safe: bytes emitted
   * for the OLD size clamp into the new grid, exactly as a native terminal
   * treats a process writing across a resize; the app repaints on its own
   * SIGWINCH an instant later).
   *
   * AckWriter interaction: {@link PaneMirror.write} is ack-PACED, so `%output`
   * bytes that arrived BEFORE this notification may still sit unparsed in the
   * writer's queue while `term.resize()` applies immediately — those old-size
   * bytes then parse into the new grid and clamp, which is the same
   * native-terminal behavior as above. The invariant that matters is that the
   * resize is ordered by the CONTROL-CLIENT READ ORDER (never held for
   * content): everything the server sent for the new size parses at the new
   * size.
   */
  private onLayoutChange(rest: string): void {
    const ev = parseLayoutChange(rest);
    if (!ev) return;
    tapResize("notify", `${ev.windowId} ${ev.visible}`);
    // Before the first sync the active window is unknown — reconcile slowly.
    if (!this.activeWindow) {
      this.queueSync();
      return;
    }
    if (ev.windowId !== this.activeWindow) return; // a background window
    if (ev.visible === this.lastVisibleLayout) return; // burst dedupe
    const parsed = parseLayout(ev.visible);
    if (!parsed) {
      this.queueSync(); // never guess from a failed parse
      return;
    }
    this.lastVisibleLayout = ev.visible;
    this.zoomedNow = ev.zoomed;
    this.winSize = { cols: parsed.width, rows: parsed.height };
    this.applyLayout(parsed.leaves, ev.zoomed);
    tapResize(
      "geometry-applied",
      `${parsed.width}x${parsed.height} panes=${parsed.leaves.length}${ev.zoomed ? " Z" : ""}`,
    );
  }

  /** Create/resize mirrors for the visible leaves and swap the geometry — all
   *  synchronous. Mirror DISPOSAL stays with sync: a pane missing from the
   *  visible layout is hidden under zoom (keep it warm — unzoom is instant and
   *  scrollback survives), or genuinely closed (the queued sync checks against
   *  list-panes truth and disposes there). */
  private applyLayout(leaves: readonly LayoutLeaf[], zoomed: boolean): void {
    let needSync = false;
    for (const leaf of leaves) {
      const mirror = this.mirrors.get(leaf.id);
      if (!mirror) {
        // A brand-new pane (split) in the layout: create the mirror at the
        // right size NOW so its very first %output parses into correct
        // geometry; the content seed rides the queued slow sync.
        const created = new PaneMirror(leaf.width, leaf.height);
        // Dirty must re-arm when bytes have PARSED, not just when they were
        // enqueued (onOutput) — with ack-paced writes an enqueue-time dirty can
        // be consumed by the tick before the grid changed, dropping the frame.
        created.onParsed = () => this.opts.onDirty?.();
        this.mirrors.set(leaf.id, created);
        this.unseeded.add(leaf.id);
        needSync = true;
      } else if (mirror.cols !== leaf.width || mirror.rows !== leaf.height) {
        mirror.resize(leaf.width, leaf.height);
        tapResize("pane-resize", `${leaf.id} ${leaf.width}x${leaf.height}`);
      }
    }
    if (!zoomed) {
      const visible = new Set(leaves.map((l) => l.id));
      for (const id of this.mirrors.keys()) {
        if (!visible.has(id)) {
          needSync = true; // a pane closed — let sync dispose against truth
          break;
        }
      }
    }
    this.geometry = geometryFromLeaves(
      leaves,
      this.geometry,
      this.activePane,
      this.appMouseByPane,
      zoomed,
    );
    this.opts.onDirty?.();
    if (needSync) this.queueSync();
  }

  /** `%window-pane-changed` — tmux's active pane moved (fires immediately,
   *  ahead of any sync). Track it and re-flag the geometry in place. */
  private onWindowPaneChanged(rest: string): void {
    const ev = parseWindowPaneChanged(rest);
    if (!ev || (this.activeWindow && ev.windowId !== this.activeWindow)) return;
    this.activePane = ev.paneId;
    // Converge the LOCAL focus to tmux truth too: a select-pane we issued
    // echoes back as this notification, and an external change (menu verb,
    // another client) should move our focus the same way.
    if (this.geometry.some((g) => g.id === ev.paneId)) this.focused = ev.paneId;
    let changed = false;
    this.geometry = this.geometry.map((g) => {
      if (g.active === (g.id === ev.paneId)) return g;
      changed = true;
      return { ...g, active: g.id === ev.paneId };
    });
    if (changed) this.opts.onDirty?.();
  }

  /** `%subscription-changed` for the `mouse` subscription — a pane's app
   *  turned mouse reporting on/off (~1s cadence; see {@link start}). */
  private onSubscriptionChanged(rest: string): void {
    const ev = parseMouseSubscription(rest);
    if (!ev || this.appMouseByPane.get(ev.paneId) === ev.on) return;
    this.appMouseByPane.set(ev.paneId, ev.on);
    let changed = false;
    this.geometry = this.geometry.map((g) => {
      if (g.id !== ev.paneId || g.appMouse === ev.on) return g;
      changed = true;
      return { ...g, appMouse: ev.on };
    });
    if (changed) this.opts.onDirty?.();
  }

  /** `%session-window-changed` — the mirrored session switched windows: a new
   *  pane set, so the slow path reseeds everything. */
  private onSessionWindowChanged(rest: string): void {
    const ev = parseSessionWindowChanged(rest);
    if (!ev) return;
    this.activeWindow = ev.windowId;
    this.lastVisibleLayout = "";
    this.queueSync();
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
    tapResize("repin", `${cols}x${rows}`);
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

  /** Queue the SLOW path (M23.5: reconciler, flag source, seed driver, sole
   *  mirror disposer — geometry itself is pushed by {@link onLayoutChange}).
   *  The 40ms debounce coalesces notification bursts to one round-trip; it no
   *  longer gates any resize. */
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
      `list-panes -t ${this.opts.target} -F "#{pane_id} #{pane_left} #{pane_top} #{pane_width} #{pane_height} #{pane_active} #{mouse_any_flag} #{window_zoomed_flag} #{window_id}"`,
    );
    // `list-panes` on a session target lists the CURRENT window — every pane
    // of it, including the ones zoom hides. The trailing window id is the
    // active-window gate for %layout-change (parsePaneGeometry ignores it).
    const all = parsePaneGeometry(lines);
    const win = lines[0]?.trim().split(/\s+/)[8];
    if (win?.startsWith("@")) this.activeWindow = win;

    // Everything from here to the geometry swap is SYNCHRONOUS. The reply
    // reflects server state at least as new as any notification already
    // processed (control mode serializes both on one channel), and nothing
    // interleaves before the swap — so a sync can never clobber a NEWER
    // pushed layout with stale rects.
    const listed = new Set(all.map((p) => p.id));
    for (const [id, mirror] of this.mirrors) {
      if (listed.has(id)) continue;
      mirror.dispose();
      this.mirrors.delete(id);
      this.unseeded.delete(id);
      this.appMouseByPane.delete(id);
      if (this.focused === id) this.focused = "";
    }
    for (const pane of all) {
      const mirror = this.mirrors.get(pane.id);
      if (!mirror) {
        const created = new PaneMirror(pane.width, pane.height);
        // Dirty must re-arm when bytes have PARSED, not just when they were
        // enqueued (onOutput) — with ack-paced writes an enqueue-time dirty can
        // be consumed by the tick before the grid changed, dropping the frame.
        created.onParsed = () => this.opts.onDirty?.();
        this.mirrors.set(pane.id, created);
        this.unseeded.add(pane.id);
      } else if (mirror.cols !== pane.width || mirror.rows !== pane.height) {
        mirror.resize(pane.width, pane.height);
        tapResize("pane-resize", `${pane.id} ${pane.width}x${pane.height} sync`);
      }
      this.appMouseByPane.set(pane.id, pane.appMouse);
    }
    this.zoomedNow = all.some((p) => p.zoomed);
    const active = all.find((p) => p.active);
    if (active) this.activePane = active.id;
    // Visible geometry: under zoom list-panes still reports the HIDDEN panes
    // at their unzoomed rects (measured on 3.7b: they overlap the zoomed pane
    // and would steal first-match hit-tests — D3). Only the active (= zoomed)
    // pane is visible, and its listed rect is the full window.
    this.geometry = this.zoomedNow ? all.filter((p) => p.active) : all;
    this.winSize = effectiveWindowSize(all) ?? this.winSize;
    this.opts.onStatus?.(`${this.geometry.length} panes`);
    this.opts.onDirty?.();

    // CONTENT seeds last — the awaits below can span chunks, so nothing after
    // this point touches geometry. Seed with history + current screen (-e
    // keeps colors, -S reaches back into tmux's scrollback, 2000 lines. The
    // old 300 cap guarded a SYNC seed write that blocked the event loop; with
    // ack-paced writes (M21.5) the write just enqueues (~0.01ms) and xterm
    // parses async — 2000 lines parse in ~8ms off the render loop (measured),
    // so the deeper history is free. -J joins wrapped lines so re-wrapping
    // stays sane.)
    for (const pane of all) {
      if (!this.unseeded.has(pane.id)) continue;
      this.unseeded.delete(pane.id);
      const mirror = this.mirrors.get(pane.id);
      if (!mirror) continue;
      const seedReply = this.client
        .command(`capture-pane -p -e -J -S -2000 -t ${pane.id}`)
        .catch(() => [] as string[]);
      // The pane's REAL cursor (D2): the seed replay leaves xterm's cursor
      // wherever the last captured byte fell — and the trailing CRLF the seed
      // used to append scrolled one extra row on a full viewport, drifting
      // the whole grid up. Dropped now; instead read tmux's cursor and CUP it
      // home (CUP is viewport-relative — the same coordinates
      // #{cursor_x}/#{cursor_y} report). Issued back-to-back with the capture
      // so both ride one round-trip.
      const cursorReply = this.client
        .command(`display-message -p -t ${pane.id} "#{cursor_x} #{cursor_y}"`)
        .catch(() => [] as string[]);
      const seed = await seedReply;
      // The control client reads replies as latin1 (one JS char per byte —
      // required for the protocol), so the seed is a byte string in disguise:
      // re-encode latin1 → bytes before feeding the VT parser, or every
      // multibyte glyph shatters into mojibake (…→â¦, ⇡→â¡ — user-reported,
      // "weird a's with a roof"). The live %output path already decodes bytes.
      if (seed.length > 0) {
        mirror.write(Buffer.from(seed.join("\r\n"), "latin1"));
      }
      const [cx, cy] = ((await cursorReply)[0] ?? "").trim().split(/\s+/).map(Number);
      if (Number.isInteger(cx) && Number.isInteger(cy)) {
        mirror.write(`\x1b[${cy! + 1};${cx! + 1}H`);
      }
    }
  }
}
