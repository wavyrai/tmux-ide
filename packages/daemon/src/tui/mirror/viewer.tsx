/**
 * SPIKE viewer — renders ONE live tmux pane inside an OpenTUI app.
 *
 * The proof for the unified-TUI architecture: a control-mode client streams
 * the pane's bytes into a headless terminal (PaneMirror), this app draws the
 * grid, and keystrokes are forwarded back through `send-keys`. tmux stays the
 * multiplexer underneath; tmux-ide owns the screen.
 *
 * Run (needs the repo-root bunfig preload):
 *   bun packages/daemon/src/tui/mirror/viewer.tsx --target <session>
 * Exit with ctrl+q (everything else is forwarded to the pane).
 */
import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, onMount, onCleanup, For } from "solid-js";
import { ControlModeClient } from "./control-client.ts";
import { PaneMirror, type MirrorSnapshot } from "./pane-mirror.ts";

const { values } = parseArgs({ options: { target: { type: "string" } } });
const target = values.target ?? "_spike-target";

// The 16 base ANSI palette colors, mapped for OpenTUI. Higher palette
// entries fall back to the default foreground — fine for a spike.
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

/** Map named OpenTUI key events to tmux send-keys names. */
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

render(() => {
  const dims = useTerminalDimensions();
  const cols = Math.max(20, dims().width - 2);
  const rows = Math.max(5, dims().height - 3);

  const mirror = new PaneMirror(cols, rows);
  const [snap, setSnap] = createSignal<MirrorSnapshot>(mirror.snapshot());
  const [status, setStatus] = createSignal(`attaching to ${target}…`);
  let pane = "";
  let dirty = false;

  const client = new ControlModeClient({
    attachTarget: target,
    onOutput: (p, data) => {
      if (p === pane || pane === "") {
        mirror.write(data);
        dirty = true;
      }
    },
    onExit: () => {
      setStatus("control client exited");
    },
  });

  onMount(() => {
    (async () => {
      try {
        await client.start();
        // Pin our control client's size so tmux lays the window out to match
        // the mirror grid, then seed with the pane's current content (-e keeps
        // colors) so we don't start from a blank screen.
        await client.command(`refresh-client -C ${cols}x${rows}`);
        const panes = await client.command(`list-panes -t ${target} -F "#{pane_id}"`);
        pane = panes[0] ?? "";
        const seed = await client.command(`capture-pane -p -e -t ${pane}`);
        mirror.write(seed.join("\r\n") + "\r\n");
        dirty = true;
        setStatus(`live: ${target} ${pane}  (ctrl+q to quit)`);
      } catch (e) {
        setStatus(`error: ${(e as Error).message}`);
      }
    })();

    // Coalesce bursts: redraw at most ~30fps instead of per %output event.
    const timer = setInterval(() => {
      if (!dirty) return;
      dirty = false;
      setSnap(mirror.snapshot());
    }, 33);
    onCleanup(() => {
      clearInterval(timer);
      client.dispose();
      mirror.dispose();
    });
  });

  useKeyboard((evt) => {
    if (evt.ctrl && evt.name === "q") {
      client.dispose();
      process.exit(0);
    }
    if (!pane) return;
    if (evt.ctrl && evt.name.length === 1) {
      void client.sendKey(pane, `C-${evt.name}`).catch(() => {});
      return;
    }
    const named = KEYMAP[evt.name];
    if (named) {
      void client.sendKey(pane, named).catch(() => {});
      return;
    }
    if (evt.name.length === 1 && !evt.meta && !evt.alt) {
      void client.sendText(pane, evt.name).catch(() => {});
    }
  });

  const fgFor = (idx: number | null): RGBA => {
    if (idx === null || idx < 0 || idx > 15) return RGBA.fromInts(200, 200, 210, 255);
    const [r, g, b] = PALETTE[idx]!;
    return RGBA.fromInts(r, g, b, 255);
  };

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={RGBA.fromInts(18, 18, 24, 255)}>
      <box paddingLeft={1} flexDirection="row" gap={1}>
        <text fg={RGBA.fromInts(130, 170, 255, 255)}>tmux-ide mirror</text>
        <text fg={RGBA.fromInts(120, 120, 140, 255)}>{status()}</text>
      </box>
      <box flexDirection="column" flexGrow={1} paddingLeft={1}>
        <For each={snap().rows}>
          {(runs) => (
            <box flexDirection="row">
              <For each={runs}>{(run) => <text fg={fgFor(run.fg)}>{run.text}</text>}</For>
            </box>
          )}
        </For>
      </box>
      <box paddingLeft={1}>
        <text fg={RGBA.fromInts(120, 120, 140, 255)}>
          {`cursor ${snap().cursorX},${snap().cursorY} · keys forwarded · ctrl+q quits`}
        </text>
      </box>
    </box>
  );
});
