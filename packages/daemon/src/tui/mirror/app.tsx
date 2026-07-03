/**
 * The unified app (M17.1+) — a whole tmux window rendered as ONE OpenTUI
 * application, at terminal fidelity.
 *
 * SessionMirror attaches a control client, pins the virtual client size to
 * our render area, and mirrors every pane of the active window. This app
 * draws each pane at its exact tmux geometry (tmux stays the layout engine)
 * with full color (truecolor + 256-palette + defaults), text attributes,
 * wide-glyph alignment, and a real block cursor in the focused pane.
 *
 * Interaction:
 *   type            → focused pane (shift-aware)
 *   click a pane    → focus it            ctrl+o → cycle focus
 *   mouse wheel     → scroll that pane's local scrollback (badge shows depth;
 *                     wheel back down or press any key → snap back live)
 *   ctrl+q          → quit (the session is untouched)
 *
 * Run (repo-root bunfig preload):
 *   bun packages/daemon/src/tui/mirror/app.tsx --target <session>
 */
import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { SessionMirror, type LivePane } from "./session-mirror.ts";

const { values } = parseArgs({ options: { target: { type: "string" } } });
const target = values.target ?? "";
if (!target) {
  console.error("usage: app.tsx --target <session>");
  process.exit(1);
}

// Terminal default colors (panes render on this when SGR says "default").
const DEFAULT_FG = RGBA.fromInts(212, 212, 216, 255);
const DEFAULT_BG = RGBA.fromInts(16, 16, 22, 255);
// The canvas behind panes — one shade lighter, so the 1-cell tmux gutters
// between panes read as thin separator lines without drawing anything.
const GUTTER_BG = RGBA.fromInts(38, 40, 52, 255);
const ACCENT = RGBA.fromInts(130, 170, 255, 255);
const MUTED = RGBA.fromInts(110, 110, 130, 255);
const BADGE_BG = RGBA.fromInts(60, 66, 92, 255);

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

render(() => {
  const dims = useTerminalDimensions();
  const canvasCols = () => dims().width;
  const canvasRows = () => Math.max(4, dims().height - 1);

  const [panes, setPanes] = createSignal<LivePane[]>([]);
  const [status, setStatus] = createSignal(`attaching ${target}…`);
  const scrollOffsets = new Map<string, number>();
  let dirty = false;
  const markDirty = () => {
    dirty = true;
  };

  const mirror = new SessionMirror({
    target,
    cols: canvasCols(),
    rows: canvasRows(),
    onDirty: markDirty,
    onStatus: (s) => setStatus(s),
    onExit: () => setStatus("control client exited (session gone?)"),
  });

  onMount(() => {
    void mirror
      .start()
      .then(() => setStatus("live"))
      .catch((e) => setStatus(`error: ${(e as Error).message}`));

    // Coalesce %output bursts to ~30fps redraws.
    const timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      setPanes(mirror.panes(scrollOffsets));
    }, 33);

    let lastW = canvasCols();
    let lastH = canvasRows();
    const sizeTimer = setInterval(() => {
      if (canvasCols() !== lastW || canvasRows() !== lastH) {
        lastW = canvasCols();
        lastH = canvasRows();
        void mirror.resize(lastW, lastH);
      }
    }, 200);

    onCleanup(() => {
      clearInterval(timer);
      clearInterval(sizeTimer);
      mirror.dispose();
    });
  });

  const snapLive = (paneId: string) => {
    if (scrollOffsets.get(paneId)) {
      scrollOffsets.set(paneId, 0);
      markDirty();
    }
  };

  const wheel = (pane: LivePane, direction: "up" | "down") => {
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
      mirror.dispose();
      process.exit(0);
    }
    if (evt.ctrl && evt.name === "o") {
      const ps = panes();
      if (ps.length > 1) {
        const cur = ps.findIndex((p) => p.id === mirror.focusedPane());
        mirror.focus(ps[(cur + 1) % ps.length]!.id);
      }
      return;
    }
    // Any real keystroke snaps the focused pane back to the live view.
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
      // OpenTUI lowercases evt.name; the shift flag recovers uppercase.
      void mirror.sendText(evt.shift ? evt.name.toUpperCase() : evt.name).catch(() => {});
    }
  });

  const headerLine = () => {
    const ps = panes();
    const focused = mirror.focusedPane();
    const chips = ps.map((p) => `${p.id === focused ? "▣" : "▢"} ${p.id}`).join("  ");
    return `${target} · ${status()}  ${chips}`;
  };

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={DEFAULT_BG}>
      <box paddingLeft={1} flexDirection="row" gap={1}>
        <text fg={ACCENT}>tmux-ide</text>
        <text fg={MUTED}>{headerLine()}</text>
        <text fg={MUTED}>· wheel scrolls · ^o focus · ^q quit</text>
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
              onMouseDown={() => {
                mirror.focus(pane.id);
              }}
              onMouseScroll={(evt: { scroll?: { direction: string } }) => {
                const dir = evt.scroll?.direction;
                if (dir === "up" || dir === "down") wheel(pane, dir);
              }}
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
                  <text
                    fg={DEFAULT_FG}
                  >{` ↑${pane.snapshot.scrollOffset}/${pane.scrollbackDepth} `}</text>
                </box>
              </Show>
            </box>
          )}
        </For>
      </box>
    </box>
  );
});
