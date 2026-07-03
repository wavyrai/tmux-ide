/**
 * The unified-app SPIKE (M17.1) — a whole tmux window rendered as ONE OpenTUI
 * application.
 *
 * SessionMirror attaches a control client, pins the virtual client size to
 * our render area, and mirrors every pane of the active window; this app
 * draws each pane at its exact tmux geometry (absolute positioning — tmux
 * remains the layout engine), routes keystrokes to the focused pane, and
 * click-focuses panes. Layout changes (splits, kills, resizes made by
 * anything, anywhere) flow in live via control-mode notifications.
 *
 * Run (repo-root bunfig preload):
 *   bun packages/daemon/src/tui/mirror/app.tsx --target <session>
 * ctrl+q quits · ctrl+o cycles focus · everything else goes to the pane.
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

const PALETTE: Array<[number, number, number]> = [
  [40, 40, 48],
  [220, 90, 90],
  [110, 200, 130],
  [220, 200, 100],
  [110, 150, 240],
  [190, 120, 220],
  [100, 200, 210],
  [200, 200, 210],
  [120, 120, 140],
  [250, 120, 120],
  [140, 230, 160],
  [240, 220, 130],
  [140, 180, 250],
  [220, 150, 250],
  [130, 230, 240],
  [240, 240, 250],
];
const fgFor = (idx: number | null): RGBA => {
  if (idx === null || idx < 0) return RGBA.fromInts(200, 200, 210, 255);
  if (idx <= 15) {
    const [r, g, b] = PALETTE[idx]!;
    return RGBA.fromInts(r, g, b, 255);
  }
  return RGBA.fromInts(200, 200, 210, 255);
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

const BG = RGBA.fromInts(14, 14, 20, 255);
const ACCENT = RGBA.fromInts(130, 170, 255, 255);
const MUTED = RGBA.fromInts(110, 110, 130, 255);

render(() => {
  const dims = useTerminalDimensions();
  // Header takes row 0; the pane canvas gets the rest.
  const canvasCols = () => dims().width;
  const canvasRows = () => Math.max(4, dims().height - 1);

  const [panes, setPanes] = createSignal<LivePane[]>([]);
  const [status, setStatus] = createSignal(`attaching ${target}…`);
  let dirty = false;

  const mirror = new SessionMirror({
    target,
    cols: canvasCols(),
    rows: canvasRows(),
    onDirty: () => {
      dirty = true;
    },
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
      setPanes(mirror.panes());
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
    <box flexDirection="column" flexGrow={1} backgroundColor={BG}>
      <box paddingLeft={1} flexDirection="row" gap={1}>
        <text fg={ACCENT}>tmux-ide app</text>
        <text fg={MUTED}>{headerLine()}</text>
        <text fg={MUTED}>· ^o focus · ^q quit</text>
      </box>
      <box position="relative" flexGrow={1}>
        <For each={panes()}>
          {(pane) => (
            <box
              position="absolute"
              left={pane.left}
              top={pane.top}
              width={pane.width}
              height={pane.height}
              flexDirection="column"
              onMouseDown={() => mirror.focus(pane.id)}
              backgroundColor={pane.active ? RGBA.fromInts(20, 22, 30, 255) : BG}
            >
              <For each={pane.snapshot.rows}>
                {(runs, y) => (
                  <box flexDirection="row" height={1}>
                    <Show when={pane.active && y() === pane.snapshot.cursorY && runs.length === 0}>
                      <text fg={ACCENT}>▏</text>
                    </Show>
                    <For each={runs}>
                      {(run) => (
                        <text fg={fgFor(run.fg)} attributes={run.bold ? 1 : 0}>
                          {run.text}
                        </text>
                      )}
                    </For>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
    </box>
  );
});
