/**
 * The team TUI — a cockpit over every tmux session.
 *
 * A two-level PROJECT view: every registered project is listed (including
 * ones with no running session = "stopped"), with its live tmux sessions
 * nested underneath. Unregistered live sessions surface as ad-hoc project
 * rows so nothing is hidden. Runs under bun (JSX via the @opentui/solid
 * preload) and is spawned by `tmux-ide team`.
 */
import { execFileSync } from "node:child_process";
import { render, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes, type MouseEvent } from "@opentui/core";
import { createSignal, createEffect, onMount, onCleanup, For, Show } from "solid-js";
import {
  capturePane,
  createDetachedSession,
  hasSession,
  killSession,
  runTmux,
  splitPane,
} from "@tmux-ide/tmux-bridge";
import { createTheme } from "../../widgets/lib/theme.ts";
import { previewLines } from "./preview.ts";
import { type TeamSession } from "./sessions.ts";
import { listTeamProjects, type TeamProject } from "./projects.ts";
import { registerProject, unregisterProject } from "../../lib/project-registry.ts";
import { createStatusTracker, type AgentStatus } from "../detect/classify.ts";
import { nextInput, suggestSessionName } from "./input.ts";
import { fuzzyFilter } from "./fuzzy.ts";
import { ACTION_ORDER, loadKeymap, resolveAction } from "./keymap.ts";
import { isDoubleClick, type ClickRecord } from "./mouse.ts";

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

/** A flattened navigable row — a project header or one of its sessions. */
type Row =
  | { kind: "project"; project: TeamProject }
  | { kind: "session"; project: TeamProject; session: TeamSession };

/** Flatten the project tree into the navigable row list. */
function toRows(projects: TeamProject[]): Row[] {
  const rows: Row[] = [];
  for (const project of projects) {
    rows.push({ kind: "project", project });
    for (const session of project.sessions) {
      rows.push({ kind: "session", project, session });
    }
  }
  return rows;
}

/** Searchable label for a row: project name, or "<project> / <session>". */
function rowLabel(row: Row): string {
  return row.kind === "project" ? row.project.name : `${row.project.name} / ${row.session.name}`;
}

/** Prefix shown on the inline prompt line for each prompt kind. */
function promptLabel(kind: PromptKind): string {
  if (kind === "register") return "register dir:";
  if (kind === "newSession") return "new session:";
  return "rename to:";
}

render(() => {
  const theme = createTheme();
  // One tracker persists across refreshes so the cross-tick `done` state
  // (working→idle without being viewed) can be inferred.
  const tracker = createStatusTracker();
  const statusColor: Record<AgentStatus, RGBA> = {
    blocked: RGBA.fromInts(240, 90, 90, 255), // red
    working: RGBA.fromInts(240, 200, 90, 255), // amber
    done: RGBA.fromInts(110, 170, 240, 255), // blue
    idle: RGBA.fromInts(120, 200, 130, 255), // green
    unknown: toRGBA(theme.fgMuted),
  };

  // Central keymap (defaults + optional ~/.tmux-ide/team-keys.json overrides),
  // resolved once at startup — the key handler routes through it.
  const keymap = loadKeymap();

  // The OpenTUI renderer, captured once so the attach/launch paths can hand the
  // terminal to a full-screen child and take it back afterwards.
  const renderer = useRenderer();

  const [projects, setProjects] = createSignal<TeamProject[]>(listTeamProjects(tracker));
  const [selected, setSelected] = createSignal(0);
  // Whether the `?` keybindings overlay is showing.
  const [helpOpen, setHelpOpen] = createSignal(false);
  // The single inline text prompt (register dir / new session / rename). null =
  // no prompt open. Its submit action switches on `kind`.
  const [prompt, setPrompt] = createSignal<{ kind: PromptKind; value: string } | null>(null);
  // Target captured when the new-session / rename prompt opens, so the async
  // submit stays correct even if the 2s refresh moves the selection.
  const [newSessionDir, setNewSessionDir] = createSignal(process.cwd());
  const [renameTarget, setRenameTarget] = createSignal("");
  // Pending destructive-action confirmation (e.g. kill); intercepts y/n.
  const [confirm, setConfirm] = createSignal<{ message: string; onYes: () => void } | null>(null);
  // Transient status line (errors / confirmations); lingers until next action.
  const [message, setMessage] = createSignal("");
  // Quick-jump fuzzy filter (`/`): narrows the visible rows as you type.
  const [filterMode, setFilterMode] = createSignal(false);
  const [filterQuery, setFilterQuery] = createSignal("");
  // Live preview of the selected session's active pane (read-only mirror).
  const dimensions = useTerminalDimensions();
  const [preview, setPreview] = createSignal<string[]>([]);
  const [previewTitle, setPreviewTitle] = createSignal("");

  const rows = () => toRows(projects());
  // Rows narrowed by the fuzzy filter — derived so it recomputes on every
  // refresh from the latest `rows()` rather than snapshotting.
  const filteredRows = () => fuzzyFilter(filterQuery(), rows(), rowLabel).map((m) => m.item);
  // What the list actually renders / navigates: filtered while filtering, else all.
  const visibleRows = () => (filterMode() ? filteredRows() : rows());

  function refresh(viewed?: string) {
    const next = listTeamProjects(tracker, viewed ? { viewed } : {});
    setProjects(next);
    const count = filterMode()
      ? fuzzyFilter(filterQuery(), toRows(next), rowLabel).length
      : toRows(next).length;
    setSelected((s) => Math.max(0, Math.min(s, count - 1)));
  }

  onMount(() => {
    const timer = setInterval(refresh, 2000);
    onCleanup(() => clearInterval(timer));
  });

  function current(): Row | undefined {
    return visibleRows()[selected()];
  }

  /** Which tmux session (if any) the preview should mirror for the selection. */
  function previewTarget(): string | null {
    const row = current();
    if (!row) return null;
    if (row.kind === "session") return row.session.name;
    if (row.project.running && row.project.sessions.length > 0) {
      return row.project.sessions[0]!.name;
    }
    return null;
  }

  /** Capture the selected session's active pane and shape it to the preview box. */
  function updatePreview() {
    const target = previewTarget();
    if (!target) {
      setPreview([]);
      setPreviewTitle("");
      return;
    }
    const dims = dimensions();
    const budget = Math.max(5, dims.height - 6);
    const width = Math.max(20, Math.floor(dims.width * 0.55) - 4);
    try {
      const raw = capturePane(target, { lines: budget });
      setPreview(previewLines(raw, budget, width));
      setPreviewTitle(target);
    } catch {
      setPreview([]);
    }
  }

  // Keep the preview live: reruns on selection, filter state, terminal resize,
  // and the 2s refresh (which replaces the projects() array each tick).
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
   * Launch a project. When it has an `ide.yml`, run the full `tmux-ide` launch
   * (builds the layout and attaches) — this blocks until the user detaches, so
   * we refresh and stay in the cockpit rather than exit. Otherwise spin up a
   * bare detached session so it appears in place.
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
      setMessage(`launched ${project.name}`);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
    }
    refresh();
  }

  // Last mouse click, tracked so a second click on the same row within the
  // double-click window activates it (mirrors keyboard Enter). A closure var —
  // it needs no reactivity, it only feeds the next click.
  let lastClick: ClickRecord | null = null;

  /**
   * A row's mousedown: select it, and on a same-row double-click within the
   * window, activate it via `enter()` (attach / launch). Keyboard and mouse
   * share the one `selected()` signal, so the preview updates either way.
   */
  function clickRow(index: number) {
    const now = Date.now();
    setSelected(index);
    if (isDoubleClick(lastClick, index, now)) {
      lastClick = null;
      enter();
      return;
    }
    lastClick = { index, at: now };
  }

  /** Wheel over the list moves the selection one row, wrapping like the arrows. */
  function scrollSelection(evt: MouseEvent) {
    const dir = evt.scroll?.direction;
    if (dir !== "up" && dir !== "down") return;
    const n = visibleRows().length;
    if (n === 0) return;
    setSelected((s) => (dir === "up" ? (s - 1 + n) % n : (s + 1) % n));
  }

  /** Enter: attach on a session row; launch (or attach-first) on a project row. */
  function enter() {
    const row = current();
    if (!row) return;
    if (row.kind === "session") {
      attachSessionName(row.session.name);
      return;
    }
    const project = row.project;
    // A running project attaches its first session — nicer than re-launching.
    if (project.running && project.sessions.length > 0) {
      attachSessionName(project.sessions[0].name);
      return;
    }
    launchProject(project);
  }

  /**
   * Kill only the tmux SESSION(s) of a row; the registry entry is untouched.
   * Takes the row explicitly so a confirm can capture it and stay correct if
   * the selection shifts under the 2s refresh before the user answers.
   */
  function killRow(row: Row) {
    if (row.kind === "session") {
      killSession(row.session.name);
    } else if (row.project.running) {
      for (const s of row.project.sessions) killSession(s.name);
    } else {
      return;
    }
    refresh();
  }

  /** Gate a kill behind a y/n confirm on the status line. */
  function requestKill() {
    const row = current();
    if (!row) return;
    const killable = row.kind === "session" || row.project.running;
    if (!killable) return;
    const name = row.kind === "session" ? row.session.name : row.project.name;
    setMessage("");
    setConfirm({ message: `kill ${name}? (y/n)`, onYes: () => killRow(row) });
  }

  /** Unregister a stopped, registered project — never orphan a live session. */
  function unregister() {
    const row = current();
    if (!row || row.kind !== "project") return;
    const project = row.project;
    if (!project.registered || project.running) return;
    try {
      unregisterProject(project.name);
      setMessage(`unregistered ${project.name}`);
    } catch (e) {
      setMessage(String((e as { message?: string })?.message ?? e));
    }
    refresh();
  }

  /** Open the register-dir prompt seeded with the current working directory. */
  function openRegister() {
    setMessage("");
    setPrompt({ kind: "register", value: process.cwd() });
  }

  /** Open the new-session prompt, seeded with a unique name for the selection. */
  function openNewSession() {
    const row = current();
    const base = row ? row.project.name : "session";
    const dir = (row ? row.project.dir : null) ?? process.cwd();
    setNewSessionDir(dir);
    setMessage("");
    setPrompt({ kind: "newSession", value: suggestSessionName(base, hasSession) });
  }

  /** Open the rename prompt when the selection resolves to a live session. */
  function openRename() {
    const target = previewTarget();
    if (!target) return;
    setRenameTarget(target);
    setMessage("");
    setPrompt({ kind: "rename", value: target });
  }

  /** Split the selected live session's active pane (right, 50%). */
  function splitSelected() {
    const target = previewTarget();
    if (!target) return;
    const dir = current()?.project.dir ?? process.cwd();
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

    // Filter prompt intercepts navigation while open.
    if (filterMode()) {
      if (evt.name === "escape") {
        setFilterMode(false);
        setFilterQuery("");
        setSelected(0);
        return;
      }
      if (evt.name === "return") {
        enter();
        setFilterMode(false);
        setFilterQuery("");
        return;
      }
      const fn = filteredRows().length;
      if (evt.name === "up" || evt.name === "k") {
        if (fn > 0) setSelected((s) => (s - 1 + fn) % fn);
        return;
      }
      if (evt.name === "down" || evt.name === "j") {
        if (fn > 0) setSelected((s) => (s + 1) % fn);
        return;
      }
      const next = nextInput(filterQuery(), evt);
      if (next !== null) {
        setFilterQuery(next);
        setSelected(0);
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

    const n = visibleRows().length;
    // The rename default is Shift+R; single-char keys arrive lowercase with
    // shift as a modifier (per the @opentui convention), so map it explicitly.
    const keyName = evt.name === "r" && evt.shift ? "R" : evt.name;
    const action = resolveAction(keymap, keyName);
    switch (action) {
      case "up":
        if (n > 0) setSelected((s) => (s - 1 + n) % n);
        break;
      case "down":
        if (n > 0) setSelected((s) => (s + 1) % n);
        break;
      case "enter":
        enter();
        break;
      case "launch": {
        const row = current();
        if (row && row.kind === "project") launchProject(row.project);
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
        setSelected(0);
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

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor={toRGBA(theme.bg)}>
      {/* header */}
      <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
        <text fg={toRGBA(theme.accent)}>tmux-ide</text>
        <text fg={toRGBA(theme.fgMuted)}>· team</text>
        <box flexGrow={1} />
        <text fg={toRGBA(theme.fgMuted)}>{`${projects().length} projects`}</text>
      </box>

      {/* middle: keybindings overlay, or the list (left) + live preview (right) */}
      <Show
        when={helpOpen()}
        fallback={
          <box flexDirection="row" flexGrow={1}>
        <box flexDirection="column" width="45%">
          {/* inline text prompt (register dir / new session / rename) */}
          <Show when={prompt()}>
            <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
              <text fg={toRGBA(theme.accent)}>{promptLabel(prompt()!.kind)}</text>
              <text fg={toRGBA(theme.fg)}>{prompt()!.value}</text>
              <text fg={toRGBA(theme.fgMuted)}>_</text>
            </box>
          </Show>

          {/* fuzzy-filter prompt */}
          <Show when={filterMode()}>
            <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={1}>
              <text fg={toRGBA(theme.accent)}>/</text>
              <text fg={toRGBA(theme.fg)}>{filterQuery()}</text>
              <text fg={toRGBA(theme.fgMuted)}>_</text>
              <box flexGrow={1} />
              <text fg={toRGBA(theme.fgMuted)}>{`${filteredRows().length}/${rows().length}`}</text>
            </box>
          </Show>

          {/* list */}
          <box
            flexDirection="column"
            flexGrow={1}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            onMouseScroll={scrollSelection}
          >
            <Show
              when={visibleRows().length > 0}
              fallback={
                <text fg={toRGBA(theme.fgMuted)}>
                  No projects or sessions. Register a project or start a tmux session to see it
                  here.
                </text>
              }
            >
              <For each={visibleRows()}>
                {(row, i) => {
                  const isSel = () => i() === selected();
                  return (
                    <Show
                      when={row.kind === "project"}
                      fallback={
                        /* session row — indented under its project */
                        <box
                          flexDirection="row"
                          gap={1}
                          paddingLeft={3}
                          paddingRight={1}
                          backgroundColor={isSel() ? toRGBA(theme.border) : undefined}
                          onMouseDown={() => clickRow(i())}
                        >
                          <text fg={isSel() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
                            {isSel() ? "▸" : " "}
                          </text>
                          <text fg={statusColor[(row as { session: TeamSession }).session.status]}>
                            {STATUS[(row as { session: TeamSession }).session.status].glyph}
                          </text>
                          <text fg={toRGBA(theme.fg)}>
                            {(row as { session: TeamSession }).session.name.padEnd(22).slice(0, 22)}
                          </text>
                          <text fg={toRGBA(theme.fgMuted)}>
                            {STATUS[(row as { session: TeamSession }).session.status].label.padEnd(
                              8,
                            )}
                          </text>
                          <text fg={toRGBA(theme.fgMuted)}>
                            {`${(row as { session: TeamSession }).session.panes}p`}
                          </text>
                          <text fg={toRGBA(theme.fgMuted)}>
                            {(row as { session: TeamSession }).session.attached ? "· attached" : ""}
                          </text>
                        </box>
                      }
                    >
                      {/* project header row */}
                      {(() => {
                        const project = (row as { project: TeamProject }).project;
                        const running = project.running;
                        return (
                          <box
                            flexDirection="row"
                            gap={1}
                            paddingLeft={1}
                            paddingRight={1}
                            backgroundColor={isSel() ? toRGBA(theme.border) : undefined}
                            onMouseDown={() => clickRow(i())}
                          >
                            <text fg={isSel() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
                              {isSel() ? "▸" : " "}
                            </text>
                            <text
                              fg={running ? statusColor[project.status] : toRGBA(theme.fgMuted)}
                            >
                              {running ? STATUS[project.status].glyph : "○"}
                            </text>
                            <text
                              fg={running ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}
                              attributes={running ? TextAttributes.BOLD : 0}
                            >
                              {project.name.padEnd(22).slice(0, 22)}
                            </text>
                            <text fg={toRGBA(theme.fgMuted)}>{running ? "" : "○ stopped"}</text>
                            <text fg={toRGBA(theme.fgMuted)}>{project.gitBranch ?? ""}</text>
                            <text fg={toRGBA(theme.fgMuted)}>
                              {project.hasIdeYml ? "ide.yml" : ""}
                            </text>
                            <box flexGrow={1} />
                            <text fg={toRGBA(theme.fgMuted)}>
                              {`${project.sessions.length} ${
                                project.sessions.length === 1 ? "session" : "sessions"
                              }`}
                            </text>
                          </box>
                        );
                      })()}
                    </Show>
                  );
                }}
              </For>
            </Show>
          </box>

          {/* transient status line — a pending confirm takes precedence */}
          <Show when={confirm() || message().length > 0}>
            <box paddingLeft={1} paddingRight={1}>
              <text fg={confirm() ? toRGBA(theme.accent) : toRGBA(theme.fgMuted)}>
                {confirm() ? confirm()!.message : message()}
              </text>
            </box>
          </Show>
        </box>

        {/* vertical separator */}
        <box width={1} backgroundColor={toRGBA(theme.border)} />

        {/* live preview of the selected session's active pane */}
        <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingTop={1}>
          <Show
            when={previewTitle().length > 0}
            fallback={<text fg={toRGBA(theme.fgMuted)}>no live session</text>}
          >
            <text fg={toRGBA(theme.accent)}>{previewTitle()}</text>
          </Show>
          <box flexDirection="column" flexGrow={1} paddingTop={1}>
            <For each={preview()}>{(line) => <text fg={toRGBA(theme.fgMuted)}>{line}</text>}</For>
          </box>
        </box>
          </box>
        }
      >
        {/* keybindings help overlay — replaces the body while `?` is open */}
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
                    <text fg={toRGBA(theme.accent)}>
                      {keymap[action].keys.join("/").padEnd(10)}
                    </text>
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
      </Show>

      {/* footer */}
      <box paddingLeft={1} paddingRight={1} flexDirection="row" gap={2}>
        <text fg={toRGBA(theme.fgMuted)}>↵ launch/attach</text>
        <text fg={toRGBA(theme.fgMuted)}>n new</text>
        <text fg={toRGBA(theme.fgMuted)}>R rename</text>
        <text fg={toRGBA(theme.fgMuted)}>s split</text>
        <text fg={toRGBA(theme.fgMuted)}>l launch</text>
        <text fg={toRGBA(theme.fgMuted)}>a add</text>
        <text fg={toRGBA(theme.fgMuted)}>d unreg</text>
        <text fg={toRGBA(theme.fgMuted)}>x kill</text>
        <text fg={toRGBA(theme.fgMuted)}>/ filter</text>
        <text fg={toRGBA(theme.fgMuted)}>r refresh</text>
        <text fg={toRGBA(theme.fgMuted)}>? help</text>
        <text fg={toRGBA(theme.fgMuted)}>q quit</text>
      </box>
    </box>
  );
});
