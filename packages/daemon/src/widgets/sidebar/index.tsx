/**
 * The SIDEBAR — the app's persistent nav column.
 *
 * A narrow, always-visible left column that renders the whole fleet as a tree
 * — project → session → window — with live status glyphs, and jumps the viewing
 * client anywhere on enter/click. Where the switcher popup (`../../tui/team`)
 * is a transient overlay that switch-clients and exits, the sidebar is a real
 * tmux pane that lives inside a session and persists; it drives the SAME shared
 * data layer (`listTeamProjects`) and the SAME flat tree-node cursor
 * (`treeNodes`/`findCursor`) so the two never drift.
 *
 * Client resolution: the pane lives IN a session, so a switch must retarget the
 * CLIENT viewing it. We resolve that client from inside the pane via
 * `display-message -p '#{client_name}'` (uses the inherited `$TMUX_PANE`),
 * falling back to the most-recently-active attached client. Unlike the popup we
 * keep `$TMUX` intact — the column is long-lived and re-resolves the client on
 * every switch.
 *
 * Runs under bun (JSX via the @opentui/solid preload); spawned by
 * `tmux-ide sidebar-toggle` / the `sidebar: true` ide.yml sugar.
 */
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes, type MouseEvent } from "@opentui/core";
import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import { runTmux } from "@tmux-ide/tmux-bridge";
import { createTheme } from "../lib/theme.ts";
import { getAppConfig } from "../../lib/app-config.ts";
import { matchGrammar } from "../lib/grammar.ts";
import { HelpOverlay, type WidgetKey } from "../lib/help-overlay.tsx";
import { createStatusTracker, type AgentStatus } from "../../tui/detect/classify.ts";
import { listTeamProjects, type TeamProject } from "../../tui/team/projects.ts";
import { type TeamSession, type TeamWindow } from "../../tui/team/sessions.ts";
import { fuzzyFilter } from "../../tui/team/fuzzy.ts";
import { wrapIndex } from "../../tui/team/nav.ts";
import { treeNodes, findCursor } from "../../tui/team/tree.ts";
import { nextInput } from "../../tui/team/input.ts";
import { isDoubleClick, type ClickRecord } from "../../tui/team/mouse.ts";

const { values: argv } = parseArgs({
  options: {
    theme: { type: "string" },
    session: { type: "string" },
    dir: { type: "string" },
  },
  strict: false,
});

function parseThemeArg(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

const STATUS_GLYPH: Record<AgentStatus, string> = {
  blocked: "●",
  working: "●",
  done: "●",
  idle: "●",
  unknown: "·",
};

/**
 * Resolve the tmux client viewing this pane. `display-message -p
 * '#{client_name}'` uses the inherited `$TMUX_PANE` to name the client — it
 * returns the right one even with several clients attached (the popup relies on
 * the same trick). Falls back to the most-recently-active attached client when
 * the direct read is empty, and to null when there are no clients at all.
 */
function resolveClient(): string | null {
  try {
    const name = runTmux(["display-message", "-p", "#{client_name}"]).toString().trim();
    if (name.length > 0) return name;
  } catch {
    // fall through to the activity-sorted fallback
  }
  try {
    const raw = runTmux(["list-clients", "-F", "#{client_activity} #{client_name}"])
      .toString()
      .trim();
    const newest = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const sp = line.indexOf(" ");
        return { activity: Number(line.slice(0, sp)), name: line.slice(sp + 1) };
      })
      .sort((a, b) => b.activity - a.activity)[0];
    return newest?.name ?? null;
  } catch {
    return null;
  }
}

/** The session this sidebar's client is viewing: the `--session` arg, else the
 *  spawn-time env, else a live `display-message`. Marks the "you are here" row. */
function resolveCurrentSession(): string {
  const fromArg = typeof argv.session === "string" ? argv.session.trim() : "";
  if (fromArg) return fromArg;
  const fromEnv = process.env.TMUX_IDE_SESSION?.trim();
  if (fromEnv) return fromEnv;
  try {
    return execFileSync("tmux", ["display-message", "-p", "#{session_name}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Truncate to `width` visible columns with a trailing ellipsis. Names in a
 *  ~30-col column must never wrap the row. */
function trunc(s: string, width: number): string {
  if (width <= 0) return "";
  if (s.length <= width) return s;
  if (width === 1) return "…";
  return `${s.slice(0, width - 1)}…`;
}

/** Sidebar keys beyond the shared grammar — listed in the `?` overlay. */
const WIDGET_KEYS: WidgetKey[] = [{ key: "r", label: "refresh fleet" }];

render(() => {
  const theme = createTheme(parseThemeArg(typeof argv.theme === "string" ? argv.theme : undefined), getAppConfig().theme);
  const statusColor: Record<AgentStatus, RGBA> = {
    blocked: toRGBA(theme.statusBlocked),
    working: toRGBA(theme.statusWorking),
    done: toRGBA(theme.statusDone),
    idle: toRGBA(theme.statusIdle),
    unknown: toRGBA(theme.statusUnknown),
  };

  const tracker = createStatusTracker();
  const currentSession = resolveCurrentSession();

  const [projects, setProjects] = createSignal<TeamProject[]>(listTeamProjects(tracker));
  // The flat tree cursor: active project / session (-1 = project row) / window
  // (-1 = session or project row). Same shape the picker navigates.
  const [activeProject, setActiveProject] = createSignal(0);
  const [activeSession, setActiveSession] = createSignal(-1);
  const [activeWindow, setActiveWindow] = createSignal(-1);
  const [filterMode, setFilterMode] = createSignal(false);
  const [filterQuery, setFilterQuery] = createSignal("");
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const dimensions = useTerminalDimensions();

  /** Visible projects: fuzzy-filtered while filtering, else all. */
  const visibleProjects = () =>
    filterMode()
      ? fuzzyFilter(filterQuery(), projects(), (p) => p.name).map((m) => m.item)
      : projects();

  const activeProj = (): TeamProject | undefined => visibleProjects()[activeProject()];
  const activeSess = (): TeamSession | undefined => activeProj()?.sessions[activeSession()];
  const activeWin = (): TeamWindow | undefined => {
    const wi = activeWindow();
    return wi >= 0 ? activeSess()?.windowList[wi] : undefined;
  };

  /** The tree node union — EVERY project's sessions expanded (the sidebar shows
   *  the whole fleet), windows only under the active/cursor session. */
  const nodes = () =>
    treeNodes(visibleProjects(), activeProject(), activeSession(), { expandAllProjects: true });

  /** Move the flat cursor by `delta`, wrapping across the node union. */
  function move(delta: number) {
    const list = nodes();
    if (list.length === 0) return;
    const cur = findCursor(list, {
      pi: activeProject(),
      si: activeSession(),
      wi: activeWindow(),
    });
    const next = list[wrapIndex(cur >= 0 ? cur : 0, delta, list.length)]!;
    setActiveProject(next.pi);
    setActiveSession(next.si);
    setActiveWindow(next.wi);
  }

  // Park the cursor on the CURRENT session at startup so "you are here" is
  // selected and its windows auto-expand. Runs once against the initial load.
  onMount(() => {
    const projs = projects();
    for (let pi = 0; pi < projs.length; pi++) {
      const si = projs[pi]!.sessions.findIndex((s) => s.name === currentSession);
      if (si >= 0) {
        setActiveProject(pi);
        setActiveSession(si);
        setActiveWindow(-1);
        break;
      }
    }
    const timer = setInterval(() => setProjects(listTeamProjects(tracker)), 2000);
    onCleanup(() => clearInterval(timer));
  });

  // Keep the cursor valid as the fleet changes under the 2s refresh: if the
  // selected node vanished, collapse toward the nearest still-present ancestor.
  createEffect(() => {
    const vis = visibleProjects();
    const pi = Math.min(activeProject(), Math.max(0, vis.length - 1));
    if (pi !== activeProject()) setActiveProject(pi);
    const sessCount = vis[pi]?.sessions.length ?? 0;
    if (activeSession() >= sessCount) {
      setActiveSession(sessCount > 0 ? sessCount - 1 : -1);
      setActiveWindow(-1);
    }
    const winCount = vis[pi]?.sessions[activeSession()]?.windowList.length ?? 0;
    if (activeWindow() >= winCount) setActiveWindow(-1);
  });

  /** Switch the viewing client to a tmux target (`session` or `session:window`).
   *  The sidebar persists — no exit, just a status line on failure. */
  function doSwitch(target: string) {
    const client = resolveClient();
    const args = ["switch-client"];
    if (client) args.push("-c", client);
    args.push("-t", target);
    try {
      runTmux(args);
      setMessage("");
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
    }
  }

  /** Enter on the current selection: a window row → `session:index`; a session
   *  row → the session; a project row → its first live session (or a note). */
  function activate() {
    const proj = activeProj();
    if (!proj) return;
    const sess = activeSess();
    if (sess) {
      const win = activeWin();
      doSwitch(win ? `${sess.name}:${win.index}` : sess.name);
      return;
    }
    // Project row: jump to its first running session, else say why not.
    if (proj.running && proj.sessions[0]) {
      doSwitch(proj.sessions[0].name);
    } else {
      setMessage(`${proj.name}: stopped`);
    }
  }

  // Double-click tracking (select on first click, switch on the second).
  let lastClick: ClickRecord | null = null;
  function click(pi: number, si: number, wi: number) {
    const now = Date.now();
    setActiveProject(pi);
    setActiveSession(si);
    setActiveWindow(wi);
    // Composite key so a double-click only counts on the same row.
    const key = pi * 1_000_000 + (si + 1) * 1000 + (wi + 1);
    if (isDoubleClick(lastClick, key, now)) {
      lastClick = null;
      activate();
      return;
    }
    lastClick = { index: key, at: now };
  }

  function scroll(evt: MouseEvent) {
    const dir = evt.scroll?.direction;
    if (dir === "up") move(-1);
    else if (dir === "down") move(1);
  }

  useKeyboard((evt) => {
    // Help overlay swallows keys: esc / q / ? close it (grammar dismiss/quit/help).
    if (helpOpen()) {
      const g = matchGrammar(evt);
      if (g === "dismiss" || g === "quit" || g === "help") setHelpOpen(false);
      return;
    }

    // Filter prompt intercepts keys while open — it narrows the project list.
    // Per the grammar's escape precedence, esc closes the FILTER before it
    // would quit the widget; only ARROWS navigate here so j/k stay typeable.
    if (filterMode()) {
      if (evt.name === "escape") {
        setFilterMode(false);
        setFilterQuery("");
        setActiveProject(0);
        setActiveSession(-1);
        setActiveWindow(-1);
        return;
      }
      if (evt.name === "return") {
        activate();
        setFilterMode(false);
        setFilterQuery("");
        return;
      }
      if (evt.name === "up" || evt.name === "down") {
        move(evt.name === "up" ? -1 : 1);
        return;
      }
      const next = nextInput(filterQuery(), evt);
      if (next !== null) {
        setFilterQuery(next);
        setActiveProject(0);
        setActiveSession(-1);
        setActiveWindow(-1);
      }
      return;
    }

    if (evt.ctrl && evt.name === "c") process.exit(0);

    // The shared grammar runs FIRST; `r` (refresh) is the sole widget key.
    const grammar = matchGrammar(evt);
    switch (grammar) {
      case "navUp":
        move(-1);
        return;
      case "navDown":
        move(1);
        return;
      case "activate":
        activate();
        return;
      case "filter":
        setMessage("");
        setFilterQuery("");
        setFilterMode(true);
        setActiveProject(0);
        setActiveSession(-1);
        setActiveWindow(-1);
        return;
      case "help":
        setHelpOpen(true);
        return;
      case "dismiss":
      case "quit":
        // Nothing is layered here, so esc/q close the sidebar pane.
        process.exit(0);
        return;
      default:
        break;
    }

    if (evt.name === "r") setProjects(listTeamProjects(tracker));
  });

  /** Column text width available for a row's name after its glyph + indent. */
  const nameWidth = (indent: number) => Math.max(3, dimensions().width - indent - 3);

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={toRGBA(theme.bg)}>
      <Show when={helpOpen()}>
        <HelpOverlay theme={theme} title="sidebar" widgetKeys={WIDGET_KEYS} />
      </Show>
      <Show when={!helpOpen()}>
        {/* header — one tight line */}
        <box paddingLeft={1} paddingRight={1} flexDirection="row">
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            {trunc("tmux-ide", dimensions().width - 2)}
          </text>
        </box>

        {/* filter line */}
        <Show when={filterMode()}>
          <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
            <text fg={toRGBA(theme.accent)}>/</text>
            <text fg={toRGBA(theme.fg)}>{trunc(filterQuery(), dimensions().width - 4)}</text>
          </box>
        </Show>

        {/* the fleet tree */}
        <box flexDirection="column" flexGrow={1} paddingTop={1} onMouseScroll={scroll}>
          <Show
            when={visibleProjects().length > 0}
            fallback={
              <box paddingLeft={1}>
                <text fg={toRGBA(theme.fgMuted)}>{filterMode() ? "no match" : "no sessions"}</text>
              </box>
            }
          >
            <For each={visibleProjects()}>
              {(project, pi) => {
                const projCursor = () => pi() === activeProject() && activeSession() === -1;
                return (
                  <box flexDirection="column">
                    {/* project row */}
                    <box
                      flexDirection="row"
                      gap={1}
                      paddingLeft={1}
                      backgroundColor={projCursor() ? toRGBA(theme.border) : undefined}
                      onMouseDown={() => click(pi(), -1, -1)}
                    >
                      <text fg={projCursor() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
                        {projCursor() ? "▸" : " "}
                      </text>
                      <text
                        fg={project.running ? statusColor[project.status] : toRGBA(theme.fgMuted)}
                      >
                        {project.running ? STATUS_GLYPH[project.status] : "○"}
                      </text>
                      <text
                        fg={projCursor() ? toRGBA(theme.accent) : toRGBA(theme.fg)}
                        attributes={projCursor() ? TextAttributes.BOLD : 0}
                      >
                        {trunc(project.name, nameWidth(4))}
                      </text>
                    </box>

                    {/* sessions — always shown under every project */}
                    <For each={project.sessions}>
                      {(session, si) => {
                        const sessCursor = () =>
                          pi() === activeProject() &&
                          si() === activeSession() &&
                          activeWindow() === -1;
                        const isCurrent = () => session.name === currentSession;
                        const expanded = () => pi() === activeProject() && si() === activeSession();
                        return (
                          <box flexDirection="column">
                            <box
                              flexDirection="row"
                              gap={1}
                              paddingLeft={2}
                              backgroundColor={sessCursor() ? toRGBA(theme.border) : undefined}
                              onMouseDown={() => click(pi(), si(), -1)}
                            >
                              <text
                                fg={
                                  isCurrent()
                                    ? toRGBA(theme.accent)
                                    : sessCursor()
                                      ? toRGBA(theme.accent)
                                      : toRGBA(theme.fgMuted)
                                }
                              >
                                {isCurrent() ? "▸" : sessCursor() ? "›" : " "}
                              </text>
                              <text fg={statusColor[session.status]}>
                                {STATUS_GLYPH[session.status]}
                              </text>
                              <text
                                fg={isCurrent() ? toRGBA(theme.accent) : toRGBA(theme.fg)}
                                attributes={isCurrent() ? TextAttributes.BOLD : 0}
                              >
                                {trunc(session.name, nameWidth(6))}
                              </text>
                            </box>
                            {/* windows — expanded under the active/cursor session */}
                            <Show when={expanded() && session.windowList.length > 0}>
                              <For each={session.windowList}>
                                {(win, wi) => {
                                  const winCursor = () =>
                                    pi() === activeProject() &&
                                    si() === activeSession() &&
                                    wi() === activeWindow();
                                  return (
                                    <box
                                      flexDirection="row"
                                      gap={1}
                                      paddingLeft={4}
                                      backgroundColor={
                                        winCursor() ? toRGBA(theme.border) : undefined
                                      }
                                      onMouseDown={() => click(pi(), si(), wi())}
                                    >
                                      <text
                                        fg={
                                          winCursor() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)
                                        }
                                      >
                                        {winCursor() ? "›" : " "}
                                      </text>
                                      <text fg={statusColor[win.status]}>
                                        {STATUS_GLYPH[win.status]}
                                      </text>
                                      <text fg={toRGBA(theme.fg)}>
                                        {trunc(
                                          `${win.index}:${win.name}${win.active ? "*" : ""}`,
                                          nameWidth(8),
                                        )}
                                      </text>
                                    </box>
                                  );
                                }}
                              </For>
                            </Show>
                          </box>
                        );
                      }}
                    </For>
                  </box>
                );
              }}
            </For>
          </Show>
        </box>

        {/* transient status line */}
        <Show when={message().length > 0}>
          <box paddingLeft={1} paddingRight={1}>
            <text fg={toRGBA(theme.fgMuted)}>{trunc(message(), dimensions().width - 2)}</text>
          </box>
        </Show>

        {/* footer — the verbs that fit a narrow column */}
        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.fgMuted)}>
            {trunc("↵ go  / find  ? help", dimensions().width - 2)}
          </text>
        </box>
      </Show>
    </box>
  );
});
