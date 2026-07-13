/**
 * The demo scene: the app's REAL sidebar beside a team of agents handing work to
 * each other.
 *
 * What is real here: the sidebar (packages/daemon's own component), its
 * hit-router (`sidebarHit`), the pane chips (`chipLabel`), the glyph/color
 * grammar (`status-grammar`), and the theme tokens. What is staged: the panes'
 * frames (the terminal app renders those from live tmux output, which has no
 * browser twin) and the fleet itself (timeline.ts).
 *
 * The panes are deliberately thin — a title chip and lines of text — because the
 * point of the scene is the HANDOFF, not a terminal emulator.
 */
import { For, Show, createSignal, onCleanup } from "solid-js";
import {
  Sidebar,
  type SidebarHoverRegion,
  type SidebarMouseEvent,
} from "@daemon/tui/mirror/sidebar.tsx";
import { sidebarHit } from "@daemon/tui/mirror/agent-rows.ts";
import { chipLabel } from "@daemon/tui/mirror/agent-chip.ts";
import { STATUS_COLOR, STATUS_GLYPH } from "@daemon/tui/mirror/status-grammar.ts";
import {
  ACCENT,
  DEFAULT_BG,
  DEFAULT_FG,
  MUTED,
  SIDEBAR_BG,
  TAB_ACTIVE_BG,
} from "@daemon/tui/mirror/theme.ts";
import { CYCLE, SESSION, sceneAt, type ScenePane } from "./timeline.ts";

// 32 cells: the footer hint (F1-4 tabs · F5 palette · ^q quit) needs 31 plus
// the column's 1-cell left padding. At 30 it truncated to "^q q".
const SIDEBAR_W = 32;
const PANE_W = 62;
const PANE_H = 9;
/** No tab bar above the column here, so a cell row IS the sidebar's `gy`. */
const TABBAR_H = 0;

type Hover = { region: SidebarHoverRegion; index: number } | null;

/** One agent's pane: a chip header, then its output. */
function Pane(props: { pane: ScenePane; nowMs: number; focused: boolean }) {
  const chip = () =>
    chipLabel(
      {
        paneId: props.pane.paneId,
        kind: props.pane.kind,
        state: props.pane.state,
        since: Math.floor(props.nowMs / 1000),
        statusText: props.pane.statusText,
      },
      STATUS_GLYPH[props.pane.state],
      props.nowMs,
      PANE_W - 4,
    ) ?? props.pane.kind;

  return (
    <box width={PANE_W} height={PANE_H} flexDirection="column" backgroundColor={DEFAULT_BG}>
      <box flexDirection="row" gap={1} backgroundColor={props.focused ? TAB_ACTIVE_BG : SIDEBAR_BG}>
        <text
          fg={STATUS_COLOR[props.pane.state]}
          attributes={props.pane.state === "blocked" ? 1 : 0}
        >
          {chip()}
        </text>
      </box>
      <box flexDirection="column" paddingLeft={1}>
        <For each={props.pane.lines.slice(-(PANE_H - 2))}>
          {(line) => (
            // A `$` line is a command the agent RAN — the send that hands work
            // to the next agent. It gets the accent so the handoff is the thing
            // your eye lands on.
            <text fg={line.startsWith("$") ? ACCENT : line.startsWith("›") ? DEFAULT_FG : MUTED}>
              {line.slice(0, PANE_W - 2)}
            </text>
          )}
        </For>
      </box>
    </box>
  );
}

export function Scene() {
  const start = Date.now();
  const [t, setT] = createSignal(0);
  const [hover, setHover] = createSignal<Hover>(null);
  const [current, setCurrent] = createSignal(SESSION);

  // 10Hz: fast enough for the typing caret, cheap enough to leave the page alone.
  const tick = setInterval(() => setT((Date.now() - start) / 1000), 100);
  onCleanup(() => clearInterval(tick));

  const nowSec = () => Math.floor(Date.now() / 1000);
  const scene = () => sceneAt(t(), nowSec());
  const agents = () => scene().agents;
  const sessions = () => {
    const seen = new Map<string, ReturnType<typeof scene>["agents"][number]["state"]>();
    const RANK = ["blocked", "working", "done", "idle", "unknown"] as const;
    for (const a of agents()) {
      const cur = seen.get(a.session);
      const better =
        cur === undefined || RANK.indexOf(a.state) < RANK.indexOf(cur as (typeof RANK)[number]);
      if (better) seen.set(a.session, a.state);
    }
    return [...seen].map(([name, status]) => ({ name, status }));
  };

  const onMouse = (e: SidebarMouseEvent) => {
    const hit = sidebarHit(e.y - TABBAR_H, sessions().length, agents().length);
    if (hit?.kind === "session") {
      setHover({ region: "sidebar", index: hit.index });
      if (e.type === "down") setCurrent(sessions()[hit.index]!.name);
    } else if (hit?.kind === "agent") {
      setHover({ region: "sidebaragent", index: hit.index });
    } else if (hit?.kind === "agents-header") {
      setHover({ region: "agentshdr", index: 0 });
    } else {
      setHover(null);
    }
  };

  // The row is sized to the panes so the sidebar's flexGrow spacer parks its
  // footer hint on the last row — as it does in the app — instead of stretching
  // to meet the events strip and colliding with it.
  const ROW_H = PANE_H * 3;

  return (
    <box flexDirection="column" backgroundColor={DEFAULT_BG}>
      <box flexDirection="row" height={ROW_H}>
        <Sidebar
          width={SIDEBAR_W}
          sessions={sessions()}
          agents={agents()}
          current={current()}
          nowSec={nowSec()}
          isHovered={(region, index) => {
            const h = hover();
            return h !== null && h.region === region && h.index === index;
          }}
          flashed={() => false}
          hint={{ pre: "F1-4 tabs · ", btn: "F5 palette", post: " · ^q quit" }}
          onMouse={onMouse}
        />
        <box flexDirection="column" paddingLeft={1}>
          <For each={scene().panes}>
            {(pane) => (
              <Pane
                pane={pane}
                nowMs={Date.now()}
                focused={pane.state === "working" || pane.state === "blocked"}
              />
            )}
          </For>
        </box>
      </box>
      {/* The events strip: the app's status row, and a real surface —
        `tmux-ide events --follow` is a JSONL stream of exactly these
        transitions. Full width, under everything, so it never collides with the
        sidebar's footer hint. */}
      <Show when={scene().events.length > 0}>
        <box flexDirection="row" gap={1} paddingLeft={1} backgroundColor={SIDEBAR_BG}>
          <text fg={ACCENT}>$ tmux-ide events --follow</text>
          <text fg={MUTED}>{`· ${scene().events.slice(-1)[0]}`}</text>
        </box>
      </Show>
    </box>
  );
}

export { CYCLE };
