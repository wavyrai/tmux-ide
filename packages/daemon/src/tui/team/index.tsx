/**
 * The team TUI — a cockpit over every tmux session.
 *
 * Lists live sessions with a rolled-up status and lets you jump between
 * them. This is the top-level view for the multi-session model; it runs
 * under bun (JSX via the @opentui/solid preload) and is spawned by
 * `tmux-ide team`.
 */
import { execFileSync } from "node:child_process";
import { render, useKeyboard } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { createTheme } from "../../widgets/lib/theme.ts";
import { listTeamSessions, type TeamSession, type SessionStatus } from "./sessions.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

const STATUS: Record<SessionStatus, { glyph: string; label: string }> = {
  working: { glyph: "●", label: "working" },
  idle: { glyph: "●", label: "idle" },
  empty: { glyph: "○", label: "empty" },
  unknown: { glyph: "·", label: "—" },
};

render(() => {
  const theme = createTheme();
  const statusColor: Record<SessionStatus, RGBA> = {
    working: RGBA.fromInts(240, 200, 90, 255), // amber
    idle: RGBA.fromInts(120, 200, 130, 255), // green
    empty: toRGBA(theme.fgMuted),
    unknown: toRGBA(theme.fgMuted),
  };

  const [sessions, setSessions] = createSignal<TeamSession[]>(listTeamSessions());
  const [selected, setSelected] = createSignal(0);

  function refresh() {
    const next = listTeamSessions();
    setSessions(next);
    setSelected((s) => Math.max(0, Math.min(s, next.length - 1)));
  }

  onMount(() => {
    const timer = setInterval(refresh, 2000);
    onCleanup(() => clearInterval(timer));
  });

  function current(): TeamSession | undefined {
    return sessions()[selected()];
  }

  function attach() {
    const s = current();
    if (!s) return;
    // Hand the terminal to tmux; return here only after the user detaches.
    try {
      execFileSync("tmux", ["attach", "-t", s.name], { stdio: "inherit" });
    } catch {
      // detached or session gone — fall through
    }
    process.exit(0);
  }

  function kill() {
    const s = current();
    if (!s) return;
    try {
      execFileSync("tmux", ["kill-session", "-t", s.name], { stdio: "ignore" });
    } catch {
      // already gone
    }
    refresh();
  }

  useKeyboard((evt) => {
    const n = sessions().length;
    if (evt.name === "q" || (evt.ctrl && evt.name === "c")) {
      process.exit(0);
    } else if (evt.name === "up" || evt.name === "k") {
      if (n > 0) setSelected((s) => (s - 1 + n) % n);
    } else if (evt.name === "down" || evt.name === "j") {
      if (n > 0) setSelected((s) => (s + 1) % n);
    } else if (evt.name === "return") {
      attach();
    } else if (evt.name === "r") {
      refresh();
    } else if (evt.name === "x") {
      kill();
    }
  });

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={toRGBA(theme.bg)}>
      {/* header */}
      <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
        <text fg={toRGBA(theme.accent)}>tmux-ide</text>
        <text fg={toRGBA(theme.fgMuted)}>· team</text>
        <box flexGrow={1} />
        <text fg={toRGBA(theme.fgMuted)}>{`${sessions().length} sessions`}</text>
      </box>

      {/* list */}
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1} paddingTop={1}>
        <Show
          when={sessions().length > 0}
          fallback={<text fg={toRGBA(theme.fgMuted)}>No tmux sessions. Start one to see it here.</text>}
        >
          <For each={sessions()}>
            {(s, i) => {
              const isSel = () => i() === selected();
              return (
                <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1}
                  backgroundColor={isSel() ? toRGBA(theme.border) : undefined}>
                  <text fg={isSel() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
                    {isSel() ? "▸" : " "}
                  </text>
                  <text fg={statusColor[s.status]}>{STATUS[s.status].glyph}</text>
                  <text fg={toRGBA(theme.fg)}>{s.name.padEnd(24).slice(0, 24)}</text>
                  <text fg={toRGBA(theme.fgMuted)}>{STATUS[s.status].label.padEnd(8)}</text>
                  <text fg={toRGBA(theme.fgMuted)}>{`${s.panes}p`}</text>
                  <text fg={toRGBA(theme.fgMuted)}>{s.attached ? "· attached" : ""}</text>
                </box>
              );
            }}
          </For>
        </Show>
      </box>

      {/* footer */}
      <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={2}>
        <text fg={toRGBA(theme.fgMuted)}>↑↓ move</text>
        <text fg={toRGBA(theme.fgMuted)}>↵ attach</text>
        <text fg={toRGBA(theme.fgMuted)}>x kill</text>
        <text fg={toRGBA(theme.fgMuted)}>r refresh</text>
        <text fg={toRGBA(theme.fgMuted)}>q quit</text>
      </box>
    </box>
  );
});
