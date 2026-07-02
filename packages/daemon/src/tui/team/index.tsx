/**
 * The team TUI — a cockpit over every tmux session.
 *
 * An app shell: a persistent left SIDEBAR lists every registered project
 * (including ones with no running session = "stopped"), and a MAIN pane shows
 * the selected ("active") project's detail — its live tmux sessions plus a
 * read-only preview of the active session's pane. Unregistered live sessions
 * surface as ad-hoc project rows in the sidebar so nothing is hidden. Runs
 * under bun (JSX via the @opentui/solid preload) and is spawned by
 * `tmux-ide team`.
 */
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes, type MouseEvent } from "@opentui/core";
import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import {
  capturePane,
  createDetachedSession,
  hasSession,
  killSession,
  runTmux,
  setSessionEnvironment,
  splitPane,
} from "@tmux-ide/tmux-bridge";
import { createTheme } from "../../widgets/lib/theme.ts";
import { getAppConfig } from "../../lib/app-config.ts";
import { adoptSession } from "../chrome/statusline.ts";
import { previewLines } from "./preview.ts";
import { type TeamSession, type TeamWindow } from "./sessions.ts";
import { listTeamProjects, type TeamProject } from "./projects.ts";
import { registerProject, unregisterProject } from "../../lib/project-registry.ts";
import { createStatusTracker, type AgentStatus } from "../detect/classify.ts";
import { nextInput, suggestSessionName } from "./input.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { clampIndex, wrapIndex } from "./nav.ts";
import { ACTION_ORDER, loadKeymap, resolveAction } from "./keymap.ts";
import { isDoubleClick, type ClickRecord } from "./mouse.ts";

// Theme pass-through: `bin/cli.ts` forwards the project's ide.yml `theme` as
// `--theme=<json>`. A malformed value must never crash the cockpit, so the
// parse is guarded and falls back to the default theme.
const { values: argv } = parseArgs({ options: { theme: { type: "string" } } });
function parseThemeArg(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
const themeConfig = parseThemeArg(argv.theme);

/**
 * Resolve the tmux client the popup was invoked on, from INSIDE the popup.
 *
 * `display-message -p '#{client_name}'` uses the popup's inherited `$TMUX` /
 * `$TMUX_PANE` to identify the invoking client — it returns the right client
 * even with several attached to the same session (verified live on tmux 3.6).
 * Must be called BEFORE `$TMUX` is cleared. Returns null on any failure, in
 * which case the switcher falls back to a client-less `switch-client` (which
 * still targets the current client when `$TMUX` is intact).
 */
function resolvePopupClient(): string | null {
  try {
    const name = runTmux(["display-message", "-p", "#{client_name}"]).toString().trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

// Fixed sidebar width in columns — narrow enough to leave the detail pane room
// on an 80-col terminal, wide enough for a project name + session count.
const SIDEBAR_WIDTH = 34;

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

const STATUS: Record<AgentStatus, { glyph: string; label: string }> = {
  blocked: { glyph: "●", label: "blocked" },
  working: { glyph: "●", label: "working" },
  done: { glyph: "●", label: "done" },
  idle: { glyph: "●", label: "idle" },
  unknown: { glyph: "·", label: "unknown" },
};

/** Which inline text prompt is open (they all submit an action). */
type PromptKind = "register" | "newSession" | "rename";

/** Searchable label for the sidebar fuzzy filter — the project name. */
function projectName(project: TeamProject): string {
  return project.name;
}

/** Prefix shown on the inline prompt line for each prompt kind. */
function promptLabel(kind: PromptKind): string {
  if (kind === "register") return "register dir:";
  if (kind === "newSession") return "new session:";
  return "rename to:";
}

render(() => {
  const theme = createTheme(themeConfig, getAppConfig().theme);
  // One tracker persists across refreshes so the cross-tick `done` state
  // (working→idle without being viewed) can be inferred.
  const tracker = createStatusTracker();
  // The dir the user actually ran `tmux-ide` from. The CLI spawns this widget
  // with cwd set to the repo root (for the bun JSX preload), so it forwards the
  // real cwd via env; fall back to process.cwd() when run directly.
  const invokeCwd = process.env.TMUX_IDE_CWD ?? process.cwd();
  // Picker mode: the switcher runs inside a tmux `display-popup` (bound to M-p
  // on adopted sessions). `TMUX_IDE_PICKER_CLIENT`'s PRESENCE flips picker mode
  // on; its VALUE is an optional explicit client name. When empty we resolve
  // the invoking client ourselves from inside the popup — `display-message -p
  // '#{client_name}'` returns it correctly (verified live on tmux 3.6), unlike
  // a `#{client_name}` in the bind command, which does not format-expand. We
  // must resolve BEFORE clearing $TMUX (display-message needs the popup's tmux
  // env to know which client it's on). Like host mode we then clear $TMUX so
  // fleet queries hit the DEFAULT server; the explicit `-c <client>` on
  // switch-client keeps the switch correct without it.
  const pickerClientEnv = process.env.TMUX_IDE_PICKER_CLIENT ?? null;
  const pickerMode = pickerClientEnv !== null;
  let pickerClient: string | null = null;
  if (pickerMode) {
    pickerClient =
      pickerClientEnv && pickerClientEnv.length > 0 ? pickerClientEnv : resolvePopupClient();
    delete process.env.TMUX;
  }
  // Picker mode renders the compact single-column switcher (the popup layout).
  const compactMode = pickerMode;
  // Shared with the tmux chrome via the app theme tokens (blocked red, working
  // amber, done blue, idle green) so the cockpit matches the status bar palette.
  const statusColor: Record<AgentStatus, RGBA> = {
    blocked: toRGBA(theme.statusBlocked),
    working: toRGBA(theme.statusWorking),
    done: toRGBA(theme.statusDone),
    idle: toRGBA(theme.statusIdle),
    unknown: toRGBA(theme.statusUnknown),
  };

  // Central keymap (defaults + optional ~/.tmux-ide/team-keys.json overrides),
  // resolved once at startup — the key handler routes through it.
  const keymap = loadKeymap();

  // The OpenTUI renderer, captured once so the attach/launch paths can hand the
  // terminal to a full-screen child and take it back afterwards.
  const renderer = useRenderer();

  const [projects, setProjects] = createSignal<TeamProject[]>(listTeamProjects(tracker));
  // The two shell cursors: the active PROJECT (index into the visible project
  // list — filtered while filtering, else all) and the active SESSION (index
  // into the active project's sessions, default 0).
  const [activeProject, setActiveProject] = createSignal(0);
  const [activeSession, setActiveSession] = createSignal(0);
  // Picker-only third cursor tier: which WINDOW (tab) of the active session is
  // selected. `-1` = the session row itself (no window), `0..n-1` = a window
  // row. Standalone never sets it past -1 (its window lines are read-only).
  const [activeWindow, setActiveWindow] = createSignal(-1);
  // Whether the `?` keybindings overlay is showing.
  const [helpOpen, setHelpOpen] = createSignal(false);
  // The single inline text prompt (register dir / new session / rename). null =
  // no prompt open. Its submit action switches on `kind`.
  const [prompt, setPrompt] = createSignal<{ kind: PromptKind; value: string } | null>(null);
  // Target captured when the new-session / rename prompt opens, so the async
  // submit stays correct even if the 2s refresh moves the selection.
  const [newSessionDir, setNewSessionDir] = createSignal(invokeCwd);
  const [renameTarget, setRenameTarget] = createSignal("");
  // Pending destructive-action confirmation (e.g. kill); intercepts y/n.
  const [confirm, setConfirm] = createSignal<{ message: string; onYes: () => void } | null>(null);
  // Transient status line (errors / confirmations); lingers until next action.
  const [message, setMessage] = createSignal("");
  // Quick-jump fuzzy filter (`/`): narrows the visible SIDEBAR projects as you type.
  const [filterMode, setFilterMode] = createSignal(false);
  const [filterQuery, setFilterQuery] = createSignal("");
  // Live preview of the active session's active pane (read-only mirror).
  const dimensions = useTerminalDimensions();
  const [preview, setPreview] = createSignal<string[]>([]);
  const [previewTitle, setPreviewTitle] = createSignal("");

  /** The sidebar's project list: fuzzy-filtered while filtering, else all. */
  const visibleProjects = () =>
    filterMode()
      ? fuzzyFilter(filterQuery(), projects(), projectName).map((m) => m.item)
      : projects();

  /** The active project (into the visible list), or undefined when empty. */
  const activeProj = (): TeamProject | undefined => visibleProjects()[activeProject()];
  /** The active session within the active project, or undefined when none. */
  const activeSess = (): TeamSession | undefined => activeProj()?.sessions[activeSession()];
  /** The selected window of the active session (picker only), or undefined. */
  const activeWin = (): TeamWindow | undefined => {
    const wi = activeWindow();
    return wi >= 0 ? activeSess()?.windowList[wi] : undefined;
  };

  /**
   * PICKER navigation is a single flat cursor over a THREE-tier row union:
   * every project row, the active project's session rows, and the active
   * session's window rows. This builds that ordered node list — the cursor is
   * the `(activeProject, activeSession, activeWindow)` triple, where `si:-1`
   * marks a project row and `wi:-1` a session (or project) row.
   */
  function pickerNodes(): Array<{ pi: number; si: number; wi: number }> {
    const nodes: Array<{ pi: number; si: number; wi: number }> = [];
    visibleProjects().forEach((proj, pi) => {
      nodes.push({ pi, si: -1, wi: -1 });
      if (pi !== activeProject()) return;
      proj.sessions.forEach((sess, si) => {
        nodes.push({ pi, si, wi: -1 });
        if (si === activeSession()) {
          sess.windowList.forEach((_w, wi) => nodes.push({ pi, si, wi }));
        }
      });
    });
    return nodes;
  }

  /** Move the picker's flat cursor by `delta`, wrapping across the row union. */
  function movePicker(delta: number) {
    const nodes = pickerNodes();
    if (nodes.length === 0) return;
    const cur = nodes.findIndex(
      (n) => n.pi === activeProject() && n.si === activeSession() && n.wi === activeWindow(),
    );
    const next = nodes[wrapIndex(cur >= 0 ? cur : 0, delta, nodes.length)]!;
    setActiveProject(next.pi);
    setActiveSession(next.si);
    setActiveWindow(next.wi);
  }

  function refresh(viewed?: string) {
    const next = listTeamProjects(tracker, viewed ? { viewed } : {});
    setProjects(next);
    // Clamp both cursors against the freshly-loaded lists so neither dangles.
    const vis = filterMode()
      ? fuzzyFilter(filterQuery(), next, projectName).map((m) => m.item)
      : next;
    const pi = clampIndex(activeProject(), vis.length);
    setActiveProject(pi);
    const si = clampIndex(activeSession(), vis[pi]?.sessions.length ?? 0);
    setActiveSession(activeSession() < 0 ? -1 : si);
    // Keep the window cursor valid: drop to the session row (-1) when it points
    // past the (possibly shrunk) window list, so it never dangles after a tick.
    const winCount = vis[pi]?.sessions[si]?.windowList.length ?? 0;
    setActiveWindow((w) => (w >= 0 && w < winCount ? w : -1));
  }

  onMount(() => {
    const timer = setInterval(refresh, 2000);
    onCleanup(() => clearInterval(timer));
  });

  /** Select a project by its index in the visible list, resetting the session cursor. */
  function selectProject(index: number) {
    setActiveProject(index);
    setActiveSession(0);
    setActiveWindow(-1);
  }

  /** Which tmux session (if any) the preview should mirror for the selection. */
  function previewTarget(): string | null {
    const proj = activeProj();
    if (!proj) return null;
    const sess = activeSess() ?? (proj.running ? proj.sessions[0] : undefined);
    return sess?.name ?? null;
  }

  /** Capture the active session's active pane and shape it to the preview box. */
  function updatePreview() {
    // The compact picker layout has no preview box (it's a transient popup), so
    // skip the capture-pane work entirely (it runs on every selection and every
    // 2s refresh).
    if (compactMode) return;
    const target = previewTarget();
    if (!target) {
      setPreview([]);
      setPreviewTitle("");
      return;
    }
    const dims = dimensions();
    const budget = Math.max(5, dims.height - 10);
    const width = Math.max(20, dims.width - SIDEBAR_WIDTH - 6);
    try {
      const raw = capturePane(target, { lines: budget });
      setPreview(previewLines(raw, budget, width));
      setPreviewTitle(target);
    } catch {
      setPreview([]);
    }
  }

  // Keep the preview live: reruns on the active project/session, filter state,
  // terminal resize, and the 2s refresh (which replaces projects() each tick).
  createEffect(updatePreview);

  /**
   * Hand the host terminal to a full-screen child process (a `tmux attach`, or
   * a nested `tmux-ide` launch) and take it back when the child returns.
   *
   * `renderer.suspend()` / `renderer.resume()` are OpenTUI 0.1.88's built-in
   * pair for exactly this: `suspend()` stops the render loop, disables
   * mouse/raw mode, detaches the stdin listener and calls the native
   * `suspendRenderer` (which restores the host terminal — leaves the alt-screen
   * and shows the cursor); `resume()` re-enables raw mode + the stdin listener,
   * calls `resumeRenderer` (re-enters the alt-screen), clears the buffer and
   * restarts the render loop. So the cockpit survives the hand-off and repaints
   * itself once the child exits — no `process.exit`. `finally` guarantees we
   * always resume even if the child throws.
   */
  function withSuspendedTerminal(fn: () => void) {
    renderer.suspend();
    try {
      fn();
    } finally {
      renderer.resume();
    }
  }

  /**
   * Attach the terminal to a session by name; returns to the cockpit after the
   * user detaches (prefix+d) rather than exiting. A missing session or a normal
   * detach both just return from `execFileSync`, so both land back here.
   */
  function attachSessionName(name: string) {
    withSuspendedTerminal(() => {
      try {
        execFileSync("tmux", ["attach", "-t", name], { stdio: "inherit" });
      } catch {
        // detached or session gone — fall through
      }
    });
    // Back in the cockpit: acknowledge the session we just viewed (clears any
    // pending `done` for its panes) and repaint from fresh state.
    refresh(name);
  }

  /**
   * Best-effort: adopt a cockpit-created session into the native chrome (status
   * bar + switcher popup + shared updater). Chrome is optional — a failure here
   * must never block session creation.
   */
  function bestEffortAdopt(session: string) {
    try {
      adoptSession(session);
    } catch {
      // chrome is optional
    }
  }

  /**
   * PICKER MODE: `switch-client` the invoking client to `sessionName`, then
   * exit so tmux closes the popup. We pass `-c <pickerClient>` explicitly — the
   * one incantation that works from the popup regardless of `$TMUX` state
   * (verified live). On failure keep the popup open with the error on the
   * status line rather than exiting into a broken state.
   */
  function pickerSwitch(sessionName: string) {
    try {
      const args = ["switch-client"];
      if (pickerClient) args.push("-c", pickerClient);
      args.push("-t", sessionName);
      runTmux(args);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
      return;
    }
    process.exit(0);
  }

  /**
   * PICKER MODE: bring a stopped project up detached, then switch to it and
   * exit. An `ide.yml` project gets its full layout via `launch(dir, { attach:
   * false })`; a plain project just needs a bare detached session. Mirrors
   * ends in `pickerSwitch` (no main pane to drive). An `ide.yml` launch adopts
   * itself; a bare detached session is adopted here.
   */
  function pickerLaunchAndSwitch(project: TeamProject) {
    if (!project.dir) return;
    if (project.hasIdeYml) {
      import("../../launch.ts")
        .then(({ launch }) => launch(project.dir!, { attach: false }))
        .then(() => pickerSwitch(project.name))
        .catch((e) => setMessage(String((e as { message?: string })?.message ?? e)));
      return;
    }
    try {
      createDetachedSession(project.name, project.dir);
      // Flag cockpit-created sessions so agents inside can detect tmux-ide.
      try {
        setSessionEnvironment(project.name, "TMUX_IDE", "1");
      } catch {}
      bestEffortAdopt(project.name);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
      return;
    }
    pickerSwitch(project.name);
  }

  /**
   * PICKER MODE enter: switch to the active project's live session, or launch
   * the stopped project and switch to it. No preview / main pane / suspend —
   * the popup only ever ends in a `switch-client` + exit.
   */
  function pickerEnter() {
    const proj = activeProj();
    if (!proj) return;
    if (proj.running) {
      const sess = activeSess() ?? proj.sessions[0];
      if (sess) {
        // A selected WINDOW row switches to that tab (`<session>:<index>`); a
        // session (or project) row switches to the session as a whole.
        const win = activeWin();
        pickerSwitch(win ? `${sess.name}:${win.index}` : sess.name);
        return;
      }
    }
    pickerLaunchAndSwitch(proj);
  }

  /**
   * Launch a project (standalone cockpit). When it has an `ide.yml`, run the
   * full `tmux-ide` launch (builds the layout and attaches) — this blocks until
   * the user detaches, so we refresh and stay in the cockpit rather than exit.
   * Otherwise spin up a bare detached session so it appears in place.
   */
  function launchProject(project: TeamProject) {
    if (!project.dir) return;
    if (project.hasIdeYml) {
      withSuspendedTerminal(() => {
        try {
          execFileSync("tmux-ide", [], { cwd: project.dir, stdio: "inherit" });
        } catch {
          // launch failed or user detached — fall through to refresh
        }
      });
      refresh();
      return;
    }
    try {
      createDetachedSession(project.name, project.dir);
      // Flag cockpit-created sessions so agents inside can detect tmux-ide.
      try {
        setSessionEnvironment(project.name, "TMUX_IDE", "1");
      } catch {}
      bestEffortAdopt(project.name);
      setMessage(`launched ${project.name}`);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
    }
    refresh();
  }

  // Last click on a project / session row, tracked so a second click on the
  // same row within the double-click window activates it (mirrors Enter). Plain
  // closure vars — they need no reactivity, they only feed the next click.
  let lastProjectClick: ClickRecord | null = null;
  let lastSessionClick: ClickRecord | null = null;
  let lastWindowClick: ClickRecord | null = null;

  /**
   * A sidebar project row's mousedown: select it, and on a same-row
   * double-click within the window, activate it via `enter()` (attach / launch).
   */
  function clickProject(index: number) {
    const now = Date.now();
    selectProject(index);
    if (isDoubleClick(lastProjectClick, index, now)) {
      lastProjectClick = null;
      enter();
      return;
    }
    lastProjectClick = { index, at: now };
  }

  /**
   * A main-pane session row's mousedown: make it the active session, and on a
   * same-row double-click attach it.
   */
  function clickSession(index: number) {
    const now = Date.now();
    setActiveSession(index);
    setActiveWindow(-1);
    if (isDoubleClick(lastSessionClick, index, now)) {
      lastSessionClick = null;
      const sess = activeProj()?.sessions[index];
      if (sess) {
        if (pickerMode) {
          pickerSwitch(sess.name);
        } else {
          attachSessionName(sess.name);
        }
      }
      return;
    }
    lastSessionClick = { index, at: now };
  }

  /**
   * PICKER: a window row's mousedown selects it (its parent session too), and
   * on a same-row double-click switches the client to `<session>:<index>` and
   * closes the popup — the window-scoped analogue of {@link clickSession}.
   */
  function clickWindow(sessionIndex: number, windowIndex: number) {
    const now = Date.now();
    setActiveSession(sessionIndex);
    setActiveWindow(windowIndex);
    // Composite key so a double-click is only counted within the same window row.
    const key = sessionIndex * 10000 + windowIndex;
    if (isDoubleClick(lastWindowClick, key, now)) {
      lastWindowClick = null;
      const sess = activeProj()?.sessions[sessionIndex];
      const win = sess?.windowList[windowIndex];
      if (sess && win) pickerSwitch(`${sess.name}:${win.index}`);
      return;
    }
    lastWindowClick = { index: key, at: now };
  }

  /** Wheel over the sidebar moves the project selection, wrapping like the arrows. */
  function scrollProjects(evt: MouseEvent) {
    const dir = evt.scroll?.direction;
    if (dir !== "up" && dir !== "down") return;
    const n = visibleProjects().length;
    if (n === 0) return;
    setActiveProject((p) => wrapIndex(p, dir === "up" ? -1 : 1, n));
    setActiveSession(0);
    setActiveWindow(-1);
  }

  /**
   * Enter on the active project: when it's running, suspend + attach in place;
   * when stopped, launch it. In picker mode this instead switch-clients + exits.
   */
  function enter() {
    if (pickerMode) {
      pickerEnter();
      return;
    }
    const proj = activeProj();
    if (!proj) return;
    if (proj.running) {
      const sess = activeSess() ?? proj.sessions[0];
      if (sess) {
        attachSessionName(sess.name);
        return;
      }
    }
    launchProject(proj);
  }

  /** Gate a kill behind a y/n confirm: the active session, or a running project's sessions. */
  function requestKill() {
    const proj = activeProj();
    if (!proj) return;
    const sess = activeSess();
    if (sess) {
      setMessage("");
      setConfirm({
        message: `kill ${sess.name}? (y/n)`,
        onYes: () => {
          killSession(sess.name);
          refresh();
        },
      });
      return;
    }
    // No session cursor (empty project) but running — kill all its sessions.
    if (proj.running) {
      setMessage("");
      setConfirm({
        message: `kill ${proj.name}? (y/n)`,
        onYes: () => {
          for (const s of proj.sessions) killSession(s.name);
          refresh();
        },
      });
    }
  }

  /** Unregister the active project when it's registered and stopped — never orphan a live session. */
  function unregister() {
    const proj = activeProj();
    if (!proj || !proj.registered || proj.running) return;
    try {
      unregisterProject(proj.name);
      setMessage(`unregistered ${proj.name}`);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
    }
    refresh();
  }

  /** Open the register-dir prompt seeded with the current working directory. */
  function openRegister() {
    setMessage("");
    setPrompt({ kind: "register", value: invokeCwd });
  }

  /** Open the new-session prompt in the active project's dir, seeded with a unique name. */
  function openNewSession() {
    const proj = activeProj();
    const base = proj ? proj.name : "session";
    const dir = (proj ? proj.dir : null) ?? invokeCwd;
    setNewSessionDir(dir);
    setMessage("");
    setPrompt({ kind: "newSession", value: suggestSessionName(base, hasSession) });
  }

  /** Open the rename prompt when the active session resolves to a live session. */
  function openRename() {
    const target = previewTarget();
    if (!target) return;
    setRenameTarget(target);
    setMessage("");
    setPrompt({ kind: "rename", value: target });
  }

  /** Split the active session's active pane (right, 50%). */
  function splitSelected() {
    const target = previewTarget();
    if (!target) return;
    const dir = activeProj()?.dir ?? invokeCwd;
    try {
      splitPane(target, "horizontal", dir, 50);
      setMessage(`split ${target}`);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
    }
    refresh();
  }

  /** Dispatch the open prompt's submit action by kind. */
  function submitPrompt() {
    const p = prompt();
    if (!p) return;
    if (p.kind === "register") {
      // registerProject is async; resolve/clear after it lands.
      registerProject({ dir: p.value.trim() })
        .then(() => {
          setPrompt(null);
          setMessage("registered");
          refresh();
        })
        .catch((e) => setMessage(String((e as { message?: string })?.message ?? e)));
      return;
    }
    if (p.kind === "newSession") {
      const name = p.value.trim();
      if (!name) {
        setMessage("session name required");
        return;
      }
      try {
        createDetachedSession(name, newSessionDir());
        // Flag cockpit-created sessions so agents inside can detect tmux-ide.
        try {
          setSessionEnvironment(name, "TMUX_IDE", "1");
        } catch {}
        bestEffortAdopt(name);
        setMessage(`created ${name}`);
      } catch (e) {
        setMessage(String((e as { message?: string })?.message ?? e));
      }
      setPrompt(null);
      refresh();
      return;
    }
    // rename
    const oldName = renameTarget();
    const newName = p.value.trim();
    if (!oldName || !newName || newName === oldName) {
      setPrompt(null);
      return;
    }
    try {
      runTmux(["rename-session", "-t", oldName, newName]);
      setMessage(`renamed ${oldName} → ${newName}`);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
    }
    setPrompt(null);
    refresh();
  }

  useKeyboard((evt) => {
    // Destructive-action confirm swallows all keys: y runs it, anything else cancels.
    if (confirm()) {
      const c = confirm()!;
      setConfirm(null);
      if (evt.name === "y") {
        c.onYes();
        refresh();
      }
      return;
    }

    // Inline text prompt swallows all keys while open.
    if (prompt()) {
      if (evt.name === "escape") {
        setPrompt(null);
        return;
      }
      if (evt.name === "return") {
        submitPrompt();
        return;
      }
      const next = nextInput(prompt()!.value, evt);
      if (next !== null) setPrompt({ ...prompt()!, value: next });
      return;
    }

    // Filter prompt intercepts navigation while open — it narrows the sidebar.
    if (filterMode()) {
      if (evt.name === "escape") {
        setFilterMode(false);
        setFilterQuery("");
        setActiveProject(0);
        setActiveSession(0);
        setActiveWindow(-1);
        return;
      }
      if (evt.name === "return") {
        // Act on the filtered active project, then drop the filter and re-anchor
        // the cursor onto that same project in the full list.
        const proj = activeProj();
        enter();
        setFilterMode(false);
        setFilterQuery("");
        const idx = proj ? projects().findIndex((p) => p.name === proj.name) : -1;
        setActiveProject(idx >= 0 ? idx : 0);
        setActiveSession(0);
        return;
      }
      const fn = visibleProjects().length;
      if (evt.name === "up" || evt.name === "k") {
        if (fn > 0) setActiveProject((s) => wrapIndex(s, -1, fn));
        setActiveSession(0);
        setActiveWindow(-1);
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        if (fn > 0) setActiveProject((s) => wrapIndex(s, 1, fn));
        setActiveSession(0);
        setActiveWindow(-1);
        return;
      }
      const next = nextInput(filterQuery(), evt);
      if (next !== null) {
        setFilterQuery(next);
        setActiveProject(0);
        setActiveSession(0);
        setActiveWindow(-1);
      }
      return;
    }

    // The help overlay swallows keys: escape / ? / q close it.
    if (helpOpen()) {
      if (evt.name === "escape" || evt.name === "?" || evt.name === "q") {
        setHelpOpen(false);
      }
      return;
    }

    // ctrl+c always quits, independent of the (rebindable) quit key.
    if (evt.ctrl && evt.name === "c") {
      process.exit(0);
    }

    // Picker mode: Esc just closes the popup. This sits AFTER the modal guards
    // above (confirm / prompt / filter / help), so those still consume Esc to
    // dismiss themselves first — only a "bare" Esc closes the picker.
    if (pickerMode && evt.name === "escape") {
      process.exit(0);
    }

    const n = visibleProjects().length;
    // The rename default is Shift+R; single-char keys arrive lowercase with
    // shift as a modifier (per the @opentui convention), so map it explicitly.
    const keyName = evt.name === "r" && evt.shift ? "R" : evt.name;
    const action = resolveAction(keymap, keyName);
    switch (action) {
      case "up":
        // Picker walks the flat project→session→window row union; standalone
        // just pages the project list (its window lines are read-only).
        if (pickerMode) movePicker(-1);
        else if (n > 0) {
          setActiveProject((s) => wrapIndex(s, -1, n));
          setActiveSession(0);
          setActiveWindow(-1);
        }
        break;
      case "down":
        if (pickerMode) movePicker(1);
        else if (n > 0) {
          setActiveProject((s) => wrapIndex(s, 1, n));
          setActiveSession(0);
          setActiveWindow(-1);
        }
        break;
      case "enter":
        enter();
        break;
      case "launch": {
        const proj = activeProj();
        if (proj) {
          if (pickerMode) pickerLaunchAndSwitch(proj);
          else launchProject(proj);
        }
        break;
      }
      case "new":
        openNewSession();
        break;
      case "rename":
        openRename();
        break;
      case "split":
        splitSelected();
        break;
      case "register":
        openRegister();
        break;
      case "unregister":
        unregister();
        break;
      case "kill":
        requestKill();
        break;
      case "filter":
        setMessage("");
        setFilterQuery("");
        setFilterMode(true);
        setActiveProject(0);
        setActiveSession(0);
        setActiveWindow(-1);
        break;
      case "refresh":
        refresh();
        break;
      case "help":
        setHelpOpen(true);
        break;
      case "quit":
        process.exit(0);
        break;
      case null:
        break;
    }
  });

  // The keybindings help overlay — shared by both layouts. Replaces the middle
  // body while `?` is open.
  function helpOverlay() {
    return (
      <box flexDirection="column" flexGrow={1} alignItems="center" paddingTop={2}>
        <box
          flexDirection="column"
          border
          borderColor={toRGBA(theme.accent)}
          backgroundColor={toRGBA(theme.selected)}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            keybindings
          </text>
          <box flexDirection="column" paddingTop={1}>
            <For each={ACTION_ORDER}>
              {(action) => (
                <box flexDirection="row" gap={1}>
                  <text fg={toRGBA(theme.accent)}>{keymap[action].keys.join("/").padEnd(10)}</text>
                  <text fg={toRGBA(theme.fg)}>{keymap[action].description}</text>
                </box>
              )}
            </For>
          </box>
          <box paddingTop={1}>
            <text fg={toRGBA(theme.fgMuted)}>esc / ? / q to close</text>
          </box>
        </box>
      </box>
    );
  }

  // The inline text prompt (register / new session / rename) and the fuzzy
  // filter line — both shared by the two layouts, both a single line each.
  function promptRow() {
    return (
      <Show when={prompt()}>
        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.accent)}>{promptLabel(prompt()!.kind)}</text>
          <text fg={toRGBA(theme.fg)}>{prompt()!.value}</text>
          <text fg={toRGBA(theme.fgMuted)}>_</text>
        </box>
      </Show>
    );
  }
  function filterRow() {
    return (
      <Show when={filterMode()}>
        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.accent)}>/</text>
          <text fg={toRGBA(theme.fg)}>{filterQuery()}</text>
          <text fg={toRGBA(theme.fgMuted)}>_</text>
          <box flexGrow={1} />
          <text
            fg={toRGBA(theme.fgMuted)}
          >{`${visibleProjects().length}/${projects().length}`}</text>
        </box>
      </Show>
    );
  }
  function statusRow() {
    return (
      <Show when={confirm() || message().length > 0}>
        <box paddingLeft={1} paddingRight={1}>
          <text fg={confirm() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
            {confirm() ? confirm()!.message : message()}
          </text>
        </box>
      </Show>
    );
  }

  /**
   * PICKER layout — a compact single-column switcher for the `display-popup`
   * (bound to M-p on adopted sessions). This narrow popup is just the
   * project/session list + live status; no sidebar/preview split. The active
   * project's sessions expand inline so the user can pick one to switch to;
   * other projects collapse to their row to save vertical space. Picking ends
   * in a `switch-client` + close.
   */
  function CompactSwitcher() {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={toRGBA(theme.bg)}>
        {/* header — one tight line */}
        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.accent)}>tmux-ide</text>
          <box flexGrow={1} />
          <text fg={toRGBA(theme.fgMuted)}>{`${projects().length} projects`}</text>
        </box>

        {promptRow()}
        {filterRow()}

        {/* body: help overlay, or the single-column project/session list */}
        <Show
          when={helpOpen()}
          fallback={
            <box
              flexDirection="column"
              flexGrow={1}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              onMouseScroll={scrollProjects}
            >
              <Show
                when={visibleProjects().length > 0}
                fallback={
                  <text fg={toRGBA(theme.fgMuted)}>
                    {filterMode() ? "no match" : "no projects — a to add"}
                  </text>
                }
              >
                <For each={visibleProjects()}>
                  {(project, i) => {
                    const isActive = () => i() === activeProject();
                    // The flat cursor sits on the project row only when no
                    // session/window under it is selected (activeSession === -1).
                    const isCursor = () => isActive() && activeSession() === -1;
                    const running = project.running;
                    return (
                      <box flexDirection="column">
                        {/* project row */}
                        <box
                          flexDirection="row"
                          gap={1}
                          backgroundColor={isCursor() ? toRGBA(theme.border) : undefined}
                          onMouseDown={() => clickProject(i())}
                        >
                          <text fg={isCursor() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
                            {isCursor() ? "▸" : " "}
                          </text>
                          <text fg={running ? statusColor[project.status] : toRGBA(theme.fgMuted)}>
                            {running ? STATUS[project.status].glyph : "○"}
                          </text>
                          <text
                            fg={
                              isActive()
                                ? toRGBA(theme.accent)
                                : running
                                  ? toRGBA(theme.fg)
                                  : toRGBA(theme.fgMuted)
                            }
                            attributes={isActive() ? TextAttributes.BOLD : 0}
                          >
                            {project.name}
                          </text>
                          <box flexGrow={1} />
                          <text fg={toRGBA(theme.fgMuted)}>
                            {running ? `${project.sessions.length}` : "○ stopped"}
                          </text>
                        </box>
                        {/* git branch — dim indented line, when present */}
                        <Show when={project.gitBranch}>
                          <box flexDirection="row" paddingLeft={2}>
                            <text fg={toRGBA(theme.fgMuted)}>{project.gitBranch ?? ""}</text>
                          </box>
                        </Show>
                        {/* sessions — expanded only under the active project */}
                        <Show when={isActive() && project.sessions.length > 0}>
                          <For each={project.sessions}>
                            {(session, si) => {
                              // The session row is the cursor only when no window
                              // under it is selected; its windows expand whenever
                              // it's the active session.
                              const sExpanded = () => si() === activeSession();
                              const sActive = () => sExpanded() && activeWindow() === -1;
                              return (
                                <box flexDirection="column">
                                  <box
                                    flexDirection="row"
                                    gap={1}
                                    paddingLeft={2}
                                    backgroundColor={sActive() ? toRGBA(theme.border) : undefined}
                                    onMouseDown={() => clickSession(si())}
                                  >
                                    <text
                                      fg={sActive() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}
                                    >
                                      {sActive() ? "▸" : " "}
                                    </text>
                                    <text fg={statusColor[session.status]}>
                                      {STATUS[session.status].glyph}
                                    </text>
                                    <text fg={toRGBA(theme.fg)}>{session.name}</text>
                                    <box flexGrow={1} />
                                    <text fg={toRGBA(theme.fgMuted)}>{`${session.panes}p`}</text>
                                    <text fg={toRGBA(theme.fgMuted)}>
                                      {session.attached ? "·a" : ""}
                                    </text>
                                  </box>
                                  {/* windows (tabs) — expanded under the active session */}
                                  <Show when={sExpanded() && session.windowList.length > 0}>
                                    <For each={session.windowList}>
                                      {(win, wi) => {
                                        const wActive = () => wi() === activeWindow();
                                        return (
                                          <box
                                            flexDirection="row"
                                            gap={1}
                                            paddingLeft={4}
                                            backgroundColor={
                                              wActive() ? toRGBA(theme.border) : undefined
                                            }
                                            onMouseDown={() => clickWindow(si(), wi())}
                                          >
                                            <text
                                              fg={
                                                wActive()
                                                  ? toRGBA(theme.accent)
                                                  : toRGBA(theme.fgMuted)
                                              }
                                            >
                                              {wActive() ? "▸" : " "}
                                            </text>
                                            <text fg={statusColor[win.status]}>
                                              {STATUS[win.status].glyph}
                                            </text>
                                            <text fg={toRGBA(theme.fg)}>
                                              {`${win.index}:${win.name}${win.active ? " *" : ""}`}
                                            </text>
                                            <box flexGrow={1} />
                                            <text
                                              fg={toRGBA(theme.fgMuted)}
                                            >{`${win.panes}p`}</text>
                                          </box>
                                        );
                                      }}
                                    </For>
                                  </Show>
                                </box>
                              );
                            }}
                          </For>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </Show>
            </box>
          }
        >
          {helpOverlay()}
        </Show>

        {statusRow()}

        {/* compact footer — shortened labels to fit ~34 cols. The picker ends in
            a switch-client + close, so it advertises that. */}
        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.fgMuted)}>↵ switch</text>
          <text fg={toRGBA(theme.fgMuted)}>l launch</text>
          <text fg={toRGBA(theme.fgMuted)}>/ find</text>
          <text fg={toRGBA(theme.fgMuted)}>esc close</text>
        </box>
      </box>
    );
  }

  /**
   * STANDALONE layout — the full two-column app: a persistent SIDEBAR project
   * list plus a MAIN detail pane (active project's sessions + a live capture
   * preview). Used when the switcher runs on its own (`bun index.tsx`), where
   * it owns the whole terminal.
   */
  function FullApp() {
    return (
      <box flexDirection="column" flexGrow={1} backgroundColor={toRGBA(theme.bg)}>
        {/* header */}
        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
          <text fg={toRGBA(theme.accent)}>tmux-ide</text>
          <text fg={toRGBA(theme.fgMuted)}>· team</text>
          <box flexGrow={1} />
          <text fg={toRGBA(theme.fgMuted)}>{`${projects().length} projects`}</text>
        </box>

        {promptRow()}
        {filterRow()}

        {/* middle: keybindings overlay, or the sidebar (left) + main detail (right) */}
        <Show
          when={helpOpen()}
          fallback={
            <box flexDirection="row" flexGrow={1}>
              {/* SIDEBAR — the project list */}
              <box
                flexDirection="column"
                width={SIDEBAR_WIDTH}
                paddingLeft={1}
                paddingRight={1}
                paddingTop={1}
                onMouseScroll={scrollProjects}
              >
                <text fg={toRGBA(theme.fgMuted)} attributes={TextAttributes.BOLD}>
                  PROJECTS
                </text>
                <box flexDirection="column" paddingTop={1}>
                  <Show
                    when={visibleProjects().length > 0}
                    fallback={
                      <text fg={toRGBA(theme.fgMuted)}>
                        {filterMode() ? "no match" : "no projects — a to add"}
                      </text>
                    }
                  >
                    <For each={visibleProjects()}>
                      {(project, i) => {
                        const isActive = () => i() === activeProject();
                        const running = project.running;
                        return (
                          <box
                            flexDirection="column"
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={isActive() ? toRGBA(theme.border) : undefined}
                            onMouseDown={() => clickProject(i())}
                          >
                            <box flexDirection="row" gap={1}>
                              <text fg={isActive() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
                                {isActive() ? "▸" : " "}
                              </text>
                              <text
                                fg={running ? statusColor[project.status] : toRGBA(theme.fgMuted)}
                              >
                                {running ? STATUS[project.status].glyph : "○"}
                              </text>
                              <text
                                fg={
                                  isActive()
                                    ? toRGBA(theme.accent)
                                    : running
                                      ? toRGBA(theme.fg)
                                      : toRGBA(theme.fgMuted)
                                }
                                attributes={isActive() ? TextAttributes.BOLD : 0}
                              >
                                {project.name.padEnd(18).slice(0, 18)}
                              </text>
                              <box flexGrow={1} />
                              <text fg={toRGBA(theme.fgMuted)}>
                                {running ? `${project.sessions.length}` : "○ stopped"}
                              </text>
                            </box>
                            <Show when={project.gitBranch}>
                              <box flexDirection="row" paddingLeft={2}>
                                <text fg={toRGBA(theme.fgMuted)}>{project.gitBranch ?? ""}</text>
                              </box>
                            </Show>
                          </box>
                        );
                      }}
                    </For>
                  </Show>
                </box>
              </box>

              {/* vertical separator */}
              <box width={1} backgroundColor={toRGBA(theme.border)} />

              {/* MAIN — the active project's detail: sessions + live preview */}
              <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
                <Show
                  when={activeProj()}
                  fallback={<text fg={toRGBA(theme.fgMuted)}>no project selected</text>}
                >
                  {/* header: name · dir · branch · ide.yml */}
                  <box flexDirection="row" gap={1} paddingRight={1}>
                    <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
                      {activeProj()!.name}
                    </text>
                    <text fg={toRGBA(theme.fgMuted)}>{activeProj()!.dir ?? ""}</text>
                    <text fg={toRGBA(theme.fgMuted)}>{activeProj()!.gitBranch ?? ""}</text>
                    <Show when={activeProj()!.hasIdeYml}>
                      <text fg={toRGBA(theme.fgMuted)}>ide.yml</text>
                    </Show>
                  </box>

                  {/* sessions sub-list */}
                  <box flexDirection="column" paddingTop={1}>
                    <Show
                      when={(activeProj()?.sessions ?? []).length > 0}
                      fallback={<text fg={toRGBA(theme.fgMuted)}>no sessions — l to launch</text>}
                    >
                      <For each={activeProj()?.sessions ?? []}>
                        {(session, i) => {
                          const isActive = () => i() === activeSession();
                          return (
                            <box flexDirection="column">
                              <box
                                flexDirection="row"
                                gap={1}
                                paddingLeft={1}
                                paddingRight={1}
                                backgroundColor={isActive() ? toRGBA(theme.border) : undefined}
                                onMouseDown={() => clickSession(i())}
                              >
                                <text
                                  fg={isActive() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}
                                >
                                  {isActive() ? "▸" : " "}
                                </text>
                                <text fg={statusColor[session.status]}>
                                  {STATUS[session.status].glyph}
                                </text>
                                <text fg={toRGBA(theme.fg)}>
                                  {session.name.padEnd(22).slice(0, 22)}
                                </text>
                                <text fg={toRGBA(theme.fgMuted)}>
                                  {STATUS[session.status].label.padEnd(8)}
                                </text>
                                <text fg={toRGBA(theme.fgMuted)}>{`${session.panes}p`}</text>
                                <text fg={toRGBA(theme.fgMuted)}>
                                  {session.attached ? "· attached" : ""}
                                </text>
                              </box>
                              {/* windows (tabs) — read-only breakdown under each session */}
                              <For each={session.windowList}>
                                {(win) => (
                                  <box flexDirection="row" gap={1} paddingLeft={4} paddingRight={1}>
                                    <text fg={statusColor[win.status]}>
                                      {STATUS[win.status].glyph}
                                    </text>
                                    <text fg={toRGBA(theme.fgMuted)}>
                                      {`${win.index}:${win.name}${win.active ? " *" : ""}`}
                                    </text>
                                    <box flexGrow={1} />
                                    <text fg={toRGBA(theme.fgMuted)}>{`${win.panes}p`}</text>
                                  </box>
                                )}
                              </For>
                            </box>
                          );
                        }}
                      </For>
                    </Show>
                  </box>

                  {/* live preview of the active session's active pane */}
                  <box flexDirection="column" flexGrow={1} paddingTop={1}>
                    <Show
                      when={previewTitle().length > 0}
                      fallback={<text fg={toRGBA(theme.fgMuted)}>no live session</text>}
                    >
                      <text fg={toRGBA(theme.accent)}>{previewTitle()}</text>
                    </Show>
                    <box flexDirection="column" flexGrow={1} paddingTop={1}>
                      <For each={preview()}>
                        {(line) => <text fg={toRGBA(theme.fgMuted)}>{line}</text>}
                      </For>
                    </box>
                  </box>
                </Show>
              </box>
            </box>
          }
        >
          {helpOverlay()}
        </Show>

        {statusRow()}

        {/* footer */}
        <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={2}>
          <text fg={toRGBA(theme.fgMuted)}>↑↓ project</text>
          <text fg={toRGBA(theme.fgMuted)}>↵ attach/launch</text>
          <text fg={toRGBA(theme.fgMuted)}>n new</text>
          <text fg={toRGBA(theme.fgMuted)}>R rename</text>
          <text fg={toRGBA(theme.fgMuted)}>s split</text>
          <text fg={toRGBA(theme.fgMuted)}>l launch</text>
          <text fg={toRGBA(theme.fgMuted)}>a add</text>
          <text fg={toRGBA(theme.fgMuted)}>d unreg</text>
          <text fg={toRGBA(theme.fgMuted)}>x kill</text>
          <text fg={toRGBA(theme.fgMuted)}>/ filter</text>
          <text fg={toRGBA(theme.fgMuted)}>? help</text>
          <text fg={toRGBA(theme.fgMuted)}>q quit</text>
        </box>
      </box>
    );
  }

  return compactMode ? <CompactSwitcher /> : <FullApp />;
});
