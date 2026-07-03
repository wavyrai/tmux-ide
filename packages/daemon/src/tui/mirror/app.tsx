/**
 * The unified app (M17.2) — tmux as the engine, tmux-ide as the screen.
 *
 * Sidebar (live fleet, click to switch session) · window tab strip · pane
 * canvas at exact tmux geometry with full color/attribute fidelity, local
 * scrollback (wheel; ↑n/depth badge; any key snaps live), real SGR mouse
 * forwarding into panes whose app enabled mouse mode, 60fps coalesced
 * rendering, ^o pane focus cycle, ^t window cycle, ^q quits (session
 * untouched).
 *
 * MOUSE ARCHITECTURE (hard-won): ALL pointer events are received by the two
 * top-level REGION CONTAINERS (sidebar box / main column box) and routed by
 * coordinate math (routeMouse) against geometry we render ourselves.
 * Two OpenTUI landmines dictate this design — measured empirically, see
 * M17.2 notes:
 *  1. `onMouse` handlers on LATE-MOUNTED nodes (children created by a <For>
 *     AFTER initial render) break dispatch for hits on those nodes entirely;
 *     handler-less late nodes bubble correctly to early-mounted ancestors.
 *     So: handlers ONLY on the always-present containers.
 *  2. Event-prop values must be INLINE ARROWS — a bare function reference is
 *     invoked as a reactive getter during prop wiring.
 * Known residue: hits precisely ON late-mounted tab-strip boxes still swallow
 * (even handler-less) — the ^t cycle covers window switching until the
 * upstream quirk is fixed.
 *
 * Fleet data arrives via an async `tmux-ide team --json` subprocess: the
 * in-process data layer is a synchronous exec chain that blocks the event
 * loop and eats input. Seeds are capped at 300 history lines for the same
 * reason (deeper seeds froze input for ~15s per attach).
 *
 * Run (repo-root bunfig preload):
 *   bun packages/daemon/src/tui/mirror/app.tsx --target <session>
 */
import { parseArgs } from "node:util";
import { appendFileSync } from "node:fs";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { SessionMirror, type LivePane } from "./session-mirror.ts";
import { execFile } from "node:child_process";
import type { AgentStatus } from "../detect/classify.ts";

const { values } = parseArgs({ options: { target: { type: "string" } } });
const target = values.target ?? "";
const zzlog = (m: string) => {
  if (!process.env.TMUX_IDE_ZZ_LOG) return;
  try {
    appendFileSync("/tmp/zz-route.log", m + "\n");
  } catch {}
};

const SIDEBAR_BG = RGBA.fromInts(22, 22, 30, 255);
const ACCENT = RGBA.fromInts(130, 170, 255, 255);
const MUTED = RGBA.fromInts(110, 110, 130, 255);
const BADGE_BG = RGBA.fromInts(60, 66, 92, 255);
const TAB_ACTIVE_BG = RGBA.fromInts(40, 46, 66, 255);
const STATUS_COLOR: Record<AgentStatus, RGBA> = {
  blocked: RGBA.fromInts(240, 100, 100, 255),
  working: RGBA.fromInts(235, 200, 100, 255),
  done: RGBA.fromInts(120, 170, 250, 255),
  idle: RGBA.fromInts(120, 200, 140, 255),
  unknown: RGBA.fromInts(110, 110, 130, 255),
};
const STATUS_GLYPH: Record<AgentStatus, string> = {
  blocked: "●",
  working: "●",
  done: "●",
  idle: "○",
  unknown: "·",
};
const KEYMAP: Record<string, string> = {
  return: "Enter",
  backspace: "BSpace",
  tab: "Tab",
  escape: "Escape",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  delete: "DC",
  space: "Space",
};
const SCROLL_STEP = 3;
const sgrMouse = (button: number, col: number, row: number, release: boolean): string =>
  `\x1b[<${button};${col + 1};${row + 1}${release ? "m" : "M"}`;
interface WindowTab {
  index: number;
  name: string;
  active: boolean;
}

const DEFAULT_FG = RGBA.fromInts(212, 212, 216, 255);
const DEFAULT_BG = RGBA.fromInts(16, 16, 22, 255);
const GUTTER_BG = RGBA.fromInts(38, 40, 52, 255);
const SIDEBAR_W = 24;
const HEADER_ROWS = 2;
const rgbaCache = new Map<number, RGBA>();
const packedToRgba = (packed: number | null, fallback: RGBA): RGBA => {
  if (packed === null) return fallback;
  let c = rgbaCache.get(packed);
  if (!c) {
    c = RGBA.fromInts((packed >> 16) & 0xff, (packed >> 8) & 0xff, packed & 0xff, 255);
    rgbaCache.set(packed, c);
  }
  return c;
};

render(() => {
  const dims = useTerminalDimensions();
  const canvasCols = () => Math.max(20, dims().width - SIDEBAR_W);
  const canvasRows = () => Math.max(4, dims().height - HEADER_ROWS);
  const [curTarget, setCurTarget] = createSignal(target);
  const [panes, setPanes] = createSignal<LivePane[]>([]);
  const [windowTabs, setWindowTabs] = createSignal<WindowTab[]>([]);
  const [fleet, setFleet] = createSignal<Array<{ name: string; status: AgentStatus }>>([]);
  const [status, setStatus] = createSignal("attaching…");
  const scrollOffsets = new Map<string, number>();
  let dirty = false;
  const markDirty = () => {
    dirty = true;
  };

  let mirror: SessionMirror | null = null;
  const attach = (name: string) => {
    mirror?.dispose();
    scrollOffsets.clear();
    setPanes([]);
    setStatus(`attaching ${name}…`);
    const m = new SessionMirror({
      target: name,
      cols: canvasCols(),
      rows: canvasRows(),
      onDirty: markDirty,
      onStatus: () => {
        markDirty();
        void m.windows().then(setWindowTabs);
      },
      onExit: () => setStatus("control client exited"),
    });
    mirror = m;
    void m
      .start()
      .then(() => {
        setStatus("live");
        void m.windows().then(setWindowTabs);
      })
      .catch((e) => setStatus(`error: ${(e as Error).message}`));
  };
  const switchTarget = (name: string) => {
    if (name === curTarget()) return;
    setCurTarget(name);
    attach(name);
  };

  onMount(() => {
    attach(curTarget());
    const t = setInterval(() => {
      if (!dirty || !mirror) return;
      dirty = false;
      setPanes(mirror.panes(scrollOffsets));
    }, 16);
    // Fleet via an ASYNC subprocess — the in-process data layer is a chain of
    // synchronous execs that blocks the event loop for seconds and swallows
    // input (mouse events die during the storm). The child does the work.
    const cliPath = new URL("../../../../../bin/cli.js", import.meta.url).pathname;
    let fleetInFlight = false;
    const refreshFleet = () => {
      if (fleetInFlight) return;
      fleetInFlight = true;
      execFile("node", [cliPath, "team", "--json"], { timeout: 10_000 }, (err, stdout) => {
        fleetInFlight = false;
        if (err) return;
        try {
          const data = JSON.parse(stdout) as {
            projects?: Array<{ sessions?: Array<{ name: string; status: AgentStatus }> }>;
          };
          const sessions = (data.projects ?? [])
            .flatMap((p) => p.sessions ?? [])
            .filter((x, i, a) => a.findIndex((y) => y.name === x.name) === i);
          setFleet(sessions);
        } catch {
          // keep the previous fleet on parse trouble
        }
      });
    };
    refreshFleet();
    const fleetTimer = setInterval(refreshFleet, 3000);
    let lastW = canvasCols();
    let lastH = canvasRows();
    const sizeTimer = setInterval(() => {
      if (canvasCols() !== lastW || canvasRows() !== lastH) {
        lastW = canvasCols();
        lastH = canvasRows();
        void mirror?.resize(lastW, lastH);
      }
    }, 200);
    onCleanup(() => {
      clearInterval(t);
      clearInterval(fleetTimer);
      clearInterval(sizeTimer);
      mirror?.dispose();
    });
  });

  const snapLive = (paneId: string) => {
    if (scrollOffsets.get(paneId)) {
      scrollOffsets.set(paneId, 0);
      markDirty();
    }
  };

  const paneCell = (pane: LivePane, gx: number, gy: number) => ({
    col: Math.max(0, Math.min(pane.width - 1, gx - SIDEBAR_W - pane.left)),
    row: Math.max(0, Math.min(pane.height - 1, gy - HEADER_ROWS - pane.top)),
  });
  const forwardPress = (pane: LivePane, gx: number, gy: number, release: boolean) => {
    const { col, row } = paneCell(pane, gx, gy);
    void mirror?.sendTextTo(pane.id, sgrMouse(0, col, row, release)).catch(() => {});
  };
  const wheel = (pane: LivePane, direction: "up" | "down", col: number, row: number) => {
    if (pane.appMouse) {
      void mirror
        ?.sendTextTo(pane.id, sgrMouse(direction === "up" ? 64 : 65, col, row, false))
        .catch(() => {});
      return;
    }
    const cur = scrollOffsets.get(pane.id) ?? 0;
    const next =
      direction === "up"
        ? Math.min(cur + SCROLL_STEP, pane.scrollbackDepth)
        : Math.max(cur - SCROLL_STEP, 0);
    scrollOffsets.set(pane.id, next);
    markDirty();
  };

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "q") {
      mirror?.dispose();
      process.exit(0);
    }
    if (evt.ctrl && evt.name === "t") {
      const tabs = windowTabs();
      if (tabs.length > 1 && mirror) {
        const cur = tabs.findIndex((w) => w.active);
        mirror.switchWindow(tabs[(cur + 1) % tabs.length]!.index);
      }
      return;
    }
    if (evt.ctrl && evt.name === "o") {
      const ps = panes();
      if (ps.length > 1 && mirror) {
        const cur = ps.findIndex((p) => p.id === mirror!.focusedPane());
        mirror.focus(ps[(cur + 1) % ps.length]!.id);
      }
      return;
    }
    if (!mirror) return;
    snapLive(mirror.focusedPane());
    if (evt.ctrl && evt.name.length === 1) {
      void mirror.sendKey(`C-${evt.name}`).catch(() => {});
      return;
    }
    const named = KEYMAP[evt.name];
    if (named) {
      void mirror.sendKey(named).catch(() => {});
      return;
    }
    if (evt.name.length === 1 && !evt.meta) {
      void mirror.sendText(evt.shift ? evt.name.toUpperCase() : evt.name).catch(() => {});
    }
  });

  /** One router, fed by the two region containers; geometry is ours. */
  const route = (e: { type: string; x: number; y: number; scroll?: { direction: string } }) => {
    const { type, x, y } = e;
    zzlog(`${type} ${x},${y}`);
    if (x < SIDEBAR_W) {
      if (type !== "down") return;
      const s = fleet()[y - 2];
      if (s) switchTarget(s.name);
      return;
    }
    if (y === 1) {
      if (type !== "down") return;
      let col = SIDEBAR_W + 1;
      for (const w of windowTabs()) {
        const width = ` ${w.index}:${w.name} `.length;
        if (x >= col && x < col + width) {
          mirror?.switchWindow(w.index);
          return;
        }
        col += width + 1;
      }
      return;
    }
    const cx = x - SIDEBAR_W;
    const cy = y - HEADER_ROWS;
    const pane = panes().find(
      (p) => cx >= p.left && cx < p.left + p.width && cy >= p.top && cy < p.top + p.height,
    );
    if (!pane) return;
    if (type === "down") {
      mirror?.focus(pane.id);
      if (pane.appMouse) forwardPress(pane, x, y, false);
    } else if (type === "up") {
      if (pane.appMouse) forwardPress(pane, x, y, true);
    } else if (type === "scroll") {
      const dir = e.scroll?.direction;
      if (dir === "up" || dir === "down") {
        const { col, row } = paneCell(pane, x, y);
        wheel(pane, dir, col, row);
      }
    }
  };

  return (
    <box flexDirection="row" flexGrow={1} backgroundColor={DEFAULT_BG}>
      <box
        width={SIDEBAR_W}
        flexDirection="column"
        backgroundColor={SIDEBAR_BG}
        paddingLeft={1}
        onMouse={(e: { type: string; x: number; y: number; scroll?: { direction: string } }) =>
          route(e)
        }
      >
        <text fg={ACCENT} attributes={1}>
          tmux-ide
        </text>
        <text fg={MUTED}>{"─".repeat(SIDEBAR_W - 2)}</text>
        <box flexDirection="column">
          <For each={fleet()}>
            {(s) => (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={s.name === curTarget() ? TAB_ACTIVE_BG : SIDEBAR_BG}
              >
                <text fg={STATUS_COLOR[s.status]}>{STATUS_GLYPH[s.status]}</text>
                <text fg={s.name === curTarget() ? DEFAULT_FG : MUTED}>
                  {s.name.slice(0, SIDEBAR_W - 5)}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexGrow={1} />
        <text fg={MUTED}>{"^o pane · ^t tab · ^q quit"}</text>
      </box>
      <box
        flexDirection="column"
        flexGrow={1}
        onMouse={(e: { type: string; x: number; y: number }) => route(e)}
      >
        <box paddingLeft={1} flexDirection="row" gap={1}>
          <text fg={DEFAULT_FG} attributes={1}>
            {curTarget()}
          </text>
          <text fg={MUTED}>{status()}</text>
        </box>
        <box paddingLeft={1} flexDirection="row" gap={1}>
          <For each={windowTabs()}>
            {(w) => (
              <box backgroundColor={w.active ? TAB_ACTIVE_BG : DEFAULT_BG}>
                <text fg={w.active ? ACCENT : MUTED}>{` ${w.index}:${w.name} `}</text>
              </box>
            )}
          </For>
        </box>
        <box position="relative" flexGrow={1} backgroundColor={GUTTER_BG}>
          <For each={panes()}>
            {(pane) => (
              <box
                position="absolute"
                left={pane.left}
                top={pane.top}
                width={pane.width}
                height={pane.height}
                flexDirection="column"
                backgroundColor={DEFAULT_BG}
              >
                <For each={pane.snapshot.rows}>
                  {(runs) => (
                    <box flexDirection="row" height={1}>
                      <For each={runs}>
                        {(run) => (
                          <text
                            fg={packedToRgba(run.fg, DEFAULT_FG)}
                            bg={packedToRgba(run.bg, DEFAULT_BG)}
                            attributes={run.attributes}
                          >
                            {run.text}
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                </For>
                <Show when={pane.snapshot.scrollOffset > 0}>
                  <box position="absolute" right={1} top={0} backgroundColor={BADGE_BG}>
                    <text fg={DEFAULT_FG}>
                      {` ↑${pane.snapshot.scrollOffset}/${pane.scrollbackDepth} `}
                    </text>
                  </box>
                </Show>
              </box>
            )}
          </For>
        </box>
      </box>
    </box>
  );
});
