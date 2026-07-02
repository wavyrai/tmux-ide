/**
 * `tmux-ide restore` — rebuild the fleet from the last snapshot.
 *
 * The chrome updater continuously writes `~/.tmux-ide/snapshot.json`
 * ({@link ./tui/chrome/snapshot.ts}); when the tmux server dies for real, this
 * rebuilds every session it recorded — windows, split layouts, per-pane cwds,
 * and titles — and re-adopts the sessions that were adopted.
 *
 * Safety first: an already-live session is NEVER clobbered (it's skipped), and
 * recorded pane commands are NOT auto-run unless `--run-commands` is passed —
 * a restored agent pane is a plain shell in the right directory with its title
 * restored, and 0037 layers agent-resume on top.
 *
 * {@link buildRestorePlan} is PURE (skip/launch/rebuild decisions + create
 * order + layout strings, unit-tested); {@link restore} is the thin io wrapper
 * that reads the snapshot + registry + live tmux, then executes the plan.
 */
import { runTmux } from "@tmux-ide/tmux-bridge";
import { IdeError } from "./lib/errors.ts";
import { listProjects } from "./lib/project-registry.ts";
import { adoptSession } from "./tui/chrome/statusline.ts";
import { readSnapshot, type FleetSnapshot, type SessionSnapshot } from "./tui/chrome/snapshot.ts";

// ---------------------------------------------------------------------------
// Pure plan
// ---------------------------------------------------------------------------

/**
 * One restore action per snapshot session:
 *  - `skip`    — a live session already owns the name; never clobber it.
 *  - `launch`  — the session maps to a registry project WITH an ide.yml; the
 *                config is the source of truth, so relaunch it instead of a raw
 *                rebuild.
 *  - `rebuild` — raw reconstruction from the snapshot (windows/panes/layout).
 */
export type RestoreAction =
  | { kind: "skip"; session: string }
  | { kind: "launch"; session: string; dir: string }
  | { kind: "rebuild"; session: SessionSnapshot };

export interface RestorePlan {
  actions: RestoreAction[];
  /** Total panes across `rebuild` actions (what restore directly creates). */
  paneCount: number;
}

/**
 * PURE — decide what to do with each snapshot session.
 *
 * Sessions are processed in snapshot order. A name that's already live is
 * skipped. Otherwise, when `ideProjects` maps the name to a directory (a
 * registry project whose dir has an ide.yml), we prefer relaunching from that
 * config; failing that, we raw-rebuild from the recorded windows/panes.
 */
export function buildRestorePlan(
  snapshot: FleetSnapshot,
  liveSessionNames: Iterable<string>,
  ideProjects: Map<string, string> = new Map(),
): RestorePlan {
  const live = new Set(liveSessionNames);
  const actions: RestoreAction[] = [];
  let paneCount = 0;
  for (const session of snapshot.sessions) {
    if (live.has(session.name)) {
      actions.push({ kind: "skip", session: session.name });
      continue;
    }
    const dir = ideProjects.get(session.name);
    if (dir) {
      actions.push({ kind: "launch", session: session.name, dir });
      continue;
    }
    actions.push({ kind: "rebuild", session });
    for (const window of session.windows) paneCount += window.panes.length;
  }
  return { actions, paneCount };
}

// ---------------------------------------------------------------------------
// io — execute a rebuild action against live tmux
// ---------------------------------------------------------------------------

function tmuxCapture(args: string[]): string {
  return runTmux(args, { encoding: "utf-8" }).toString().trim();
}

/**
 * Raw-rebuild one session from its snapshot: create the session + its first
 * window, add the remaining windows, split each window's panes (with their
 * cwds), apply the recorded layout, restore titles, set the active window, and
 * — with `runCommands` — replay each pane's recorded command.
 */
function rebuildSession(session: SessionSnapshot, runCommands: boolean): void {
  const windows = session.windows;
  if (windows.length === 0) {
    runTmux(["new-session", "-d", "-s", session.name, "-c", session.cwd]);
    return;
  }

  windows.forEach((window, w) => {
    const windowCwd = window.panes[0]?.cwd || session.cwd;
    // First window comes from new-session; the rest are added detached.
    const windowId =
      w === 0
        ? tmuxCapture([
            "new-session",
            "-d",
            "-P",
            "-F",
            "#{window_id}",
            "-s",
            session.name,
            "-c",
            windowCwd,
          ])
        : tmuxCapture([
            "new-window",
            "-d",
            "-P",
            "-F",
            "#{window_id}",
            "-t",
            `${session.name}:`,
            "-c",
            windowCwd,
          ]);

    // The window opens with one pane (snapshot pane 0). Create the rest; the
    // layout string below fixes geometry, so split direction is irrelevant.
    const paneIds = [tmuxCapture(["display-message", "-p", "-t", windowId, "#{pane_id}"])];
    for (let p = 1; p < window.panes.length; p++) {
      const paneCwd = window.panes[p]!.cwd || windowCwd;
      paneIds.push(
        tmuxCapture([
          "split-window",
          "-d",
          "-P",
          "-F",
          "#{pane_id}",
          "-t",
          paneIds[p - 1]!,
          "-c",
          paneCwd,
        ]),
      );
    }

    // Restore geometry from the recorded layout (tmux accepts the checksummed
    // #{window_layout} string verbatim), then name the window.
    if (window.layout) runTmux(["select-layout", "-t", windowId, window.layout]);
    if (window.name) runTmux(["rename-window", "-t", windowId, window.name]);

    // Restore per-pane titles (and optionally replay commands). Titles are
    // paired by creation order, which matches the snapshot's index order.
    window.panes.forEach((pane, p) => {
      const paneId = paneIds[p];
      if (!paneId) return;
      if (pane.title) runTmux(["select-pane", "-t", paneId, "-T", pane.title]);
      // Re-stamp agent identity so the next snapshot keeps it and 0037's
      // agent-resume can find the conversation to revive.
      if (pane.agentSessionId) {
        runTmux(["set-option", "-p", "-t", paneId, "@agent_session_id", pane.agentSessionId]);
      }
      if (pane.agent) {
        runTmux(["set-option", "-p", "-t", paneId, "@agent_hint", pane.agent]);
      }
      if (runCommands && pane.command) {
        runTmux(["send-keys", "-t", paneId, "-l", "--", pane.command]);
        runTmux(["send-keys", "-t", paneId, "Enter"]);
      }
    });
  });

  // Set the active window to whatever the snapshot had focused.
  const activeIndex = windows.findIndex((w) => w.active);
  if (activeIndex >= 0) {
    runTmux(["select-window", "-t", `${session.name}:${windows[activeIndex]!.index}`]);
  }
}

// ---------------------------------------------------------------------------
// io — the command
// ---------------------------------------------------------------------------

/** Registry sessions whose dir has an ide.yml → name -> dir (the launch path). */
function ideBackedProjects(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    for (const project of listProjects()) {
      if (project.hasIdeYml && project.dir) map.set(project.name, project.dir);
    }
  } catch {
    // no registry → nothing prefers a launch; everything raw-rebuilds
  }
  return map;
}

function liveSessions(): string[] {
  try {
    const raw = tmuxCapture(["list-sessions", "-F", "#{session_name}"]);
    return raw ? raw.split("\n").filter(Boolean) : [];
  } catch {
    // no server / no sessions → nothing is live, rebuild everything
    return [];
  }
}

export interface RestoreOptions {
  json?: boolean;
  dryRun?: boolean;
  runCommands?: boolean;
}

/**
 * Rebuild the fleet from the last snapshot. Missing snapshot → friendly exit 1.
 * `dryRun` prints the plan without touching tmux; `runCommands` opts into
 * replaying recorded pane commands (off by default for safety).
 */
export async function restore({
  json = false,
  dryRun = false,
  runCommands = false,
}: RestoreOptions = {}): Promise<void> {
  const snapshot = readSnapshot();
  if (!snapshot) {
    throw new IdeError(
      "no snapshot yet — the updater writes one every ~30s while any session is adopted",
      { code: "NO_SNAPSHOT", exitCode: 1 },
    );
  }

  const plan = buildRestorePlan(snapshot, liveSessions(), ideBackedProjects());

  if (dryRun) {
    reportPlan(plan, snapshot, { json, dryRun: true, restored: [], launched: [] });
    return;
  }

  const restored: string[] = [];
  const launched: string[] = [];
  for (const action of plan.actions) {
    if (action.kind === "skip") continue;
    if (action.kind === "launch") {
      const ok = await launchProject(action.dir, json);
      if (ok) launched.push(action.session);
      else {
        // Launch failed — fall back to a raw rebuild from the snapshot so the
        // session still comes back.
        const snap = snapshot.sessions.find((s) => s.name === action.session);
        if (snap) {
          rebuildSession(snap, runCommands);
          if (snap.adopted) safeAdopt(snap.name);
          restored.push(action.session);
        }
      }
      continue;
    }
    rebuildSession(action.session, runCommands);
    if (action.session.adopted) safeAdopt(action.session.name);
    restored.push(action.session.name);
  }

  reportPlan(plan, snapshot, { json, dryRun: false, restored, launched });
}

/** Adopt a restored session into the chrome; never let a chrome failure abort restore. */
function safeAdopt(session: string): void {
  try {
    adoptSession(session);
  } catch {
    // chrome is optional — the session is already rebuilt
  }
}

/**
 * Relaunch a project from its ide.yml (config is the source of truth). Returns
 * false on any failure so the caller can fall back to a raw rebuild. Launch's
 * own stdout is swallowed in `--json` mode so the report stays parseable.
 */
async function launchProject(dir: string, json: boolean): Promise<boolean> {
  const restoreLog = console.log;
  if (json) console.log = () => {};
  try {
    const { launch } = await import("./launch.ts");
    await launch(dir, { attach: false });
    return true;
  } catch {
    return false;
  } finally {
    console.log = restoreLog;
  }
}

interface ReportContext {
  json: boolean;
  dryRun: boolean;
  restored: string[];
  launched: string[];
}

function reportPlan(
  plan: RestorePlan,
  snapshot: FleetSnapshot,
  { json, dryRun, restored, launched }: ReportContext,
): void {
  const skipped = plan.actions.filter((a) => a.kind === "skip").map((a) => a.session);
  const willLaunch = plan.actions.filter((a) => a.kind === "launch").map((a) => a.session);
  const willRebuild = plan.actions.filter((a) => a.kind === "rebuild").map((a) => a.session.name);

  if (json) {
    console.log(
      JSON.stringify(
        {
          dryRun,
          savedAt: snapshot.savedAt,
          skipped,
          launched: dryRun ? willLaunch : launched,
          restored: dryRun ? willRebuild : restored,
          panes: plan.paneCount,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (dryRun) {
    console.log(`Restore plan (snapshot from ${snapshot.savedAt}):`);
    for (const action of plan.actions) {
      if (action.kind === "skip") {
        console.log(`  skip     ${action.session} (already running)`);
      } else if (action.kind === "launch") {
        console.log(`  launch   ${action.session} (ide.yml at ${action.dir})`);
      } else {
        const w = action.session.windows.length;
        const p = action.session.windows.reduce((n, win) => n + win.panes.length, 0);
        console.log(
          `  rebuild  ${action.session.name} (${w} window${w === 1 ? "" : "s"}, ${p} pane${p === 1 ? "" : "s"})`,
        );
      }
    }
    return;
  }

  const parts: string[] = [];
  if (restored.length) parts.push(`rebuilt ${restored.join(", ")}`);
  if (launched.length) parts.push(`launched ${launched.join(", ")}`);
  if (skipped.length) parts.push(`skipped ${skipped.join(", ")} (already running)`);
  console.log(parts.length ? `Restored: ${parts.join("; ")}` : "Nothing to restore.");
}
