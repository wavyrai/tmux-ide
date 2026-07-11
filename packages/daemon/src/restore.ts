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
 * restored.
 *
 * `--resume-agents` (or `{ "restore": { "resumeAgents": true } }` in
 * `~/.tmux-ide/config.json`) layers native agent-resume on top: a rebuilt
 * agent pane that carries a recorded `@agent_session_id` relaunches with its
 * kind's VERIFIED resume invocation (`claude --resume <id>`, `codex resume
 * <id>`, … — {@link AGENT_RESUME_COMMANDS}), reviving the actual conversation
 * rather than opening a fresh shell. See {@link paneResumeCommand} for the
 * exact decision table.
 *
 * {@link buildRestorePlan} + {@link paneResumeCommand} + {@link restorePrefs}
 * are PURE (unit-tested); {@link restore} is the thin io wrapper that reads the
 * snapshot + registry + live tmux + config, then executes the plan.
 */
import { runTmux } from "@tmux-ide/tmux-bridge";
import { appConfigPath, loadAppConfig, parseAppConfig } from "./lib/app-config.ts";
import { IdeError } from "./lib/errors.ts";
import { listProjects } from "./lib/project-registry.ts";
import { adoptSession } from "./tui/chrome/statusline.ts";
import {
  readSnapshot,
  type FleetSnapshot,
  type PaneSnapshot,
  type SessionSnapshot,
} from "./tui/chrome/snapshot.ts";

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
// Pure — agent resume decision
// ---------------------------------------------------------------------------

/** A session id is trusted only if it's uuid-ish (`[A-Za-z0-9_-]` — underscore
 *  covers opencode's `ses_…` ids) — nothing shell-active. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The native session-resume invocation per agent kind (M24.1 — the table was
 * claude-only until then). ONLY VERIFIED entries ship; each spelling's source:
 *  - `claude --resume <id>`: the shipped integration (its hooks record the id).
 *  - `codex resume <id>`: `codex resume --help` — "Usage: codex resume
 *    [OPTIONS] [SESSION_ID]  … Session id (UUID) or session name".
 *  - `opencode --session <id>`: `opencode --help` — "-s, --session  session id
 *    to continue".
 *  - `cursor-agent --resume <id>`: `cursor-agent --help` — "--resume [chatId]
 *    Select a session to resume".
 *  - `copilot --resume=<id>`: GitHub Copilot CLI command reference —
 *    "--resume[=VALUE]  Resume a previous interactive session … Optionally
 *    specify a session ID" (the `=` form, since the value is optional).
 * Unverified (no entry): gemini, aider, goose, amp — no confirmed native
 * per-session resume invocation at the time of writing.
 *
 * Only claude's hooks record `@agent_session_id` automatically today; the
 * other entries fire for panes whose agent self-reported the id per the agent
 * contract (`tmux set-option -p @agent_session_id <id>`).
 */
export const AGENT_RESUME_COMMANDS: Record<string, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  opencode: (id) => `opencode --session ${id}`,
  cursor: (id) => `cursor-agent --resume ${id}`,
  copilot: (id) => `copilot --resume=${id}`,
};

/**
 * PURE — the command to relaunch a pane so its agent conversation is revived,
 * or `null` for "no resume — leave it a plain shell (or replay `command`)".
 *
 * Decision table (only fires when `resumeAgents` is on):
 *  - a kind in {@link AGENT_RESUME_COMMANDS} + a recorded `@agent_session_id` →
 *    that kind's resume invocation. The id is uuid-ish, but we don't trust the
 *    snapshot: unless it matches {@link SAFE_SESSION_ID} we bail to `null`
 *    rather than risk feeding shell metacharacters into send-keys.
 *  - a known kind with NO session id → `null`. A "continue most recent" flag
 *    would be too magical here (it resumes the cwd's most-recent conversation,
 *    which may belong to a different pane); a fresh shell is the safe default.
 *  - any other agent → `null`. No VERIFIED resume story.
 *  - `resumeAgents` off → always `null`.
 */
export function paneResumeCommand(
  pane: PaneSnapshot,
  opts: { resumeAgents: boolean },
): string | null {
  if (!opts.resumeAgents) return null;
  const resume = pane.agent ? AGENT_RESUME_COMMANDS[pane.agent] : undefined;
  if (!resume) return null;
  const id = pane.agentSessionId;
  if (!id || !SAFE_SESSION_ID.test(id)) return null;
  return resume(id);
}

/** PURE — how many of a session's panes would resume under `resumeAgents`. */
export function countResumableAgents(session: SessionSnapshot, resumeAgents: boolean): number {
  let n = 0;
  for (const window of session.windows) {
    for (const pane of window.panes) {
      if (paneResumeCommand(pane, { resumeAgents })) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Pure — restore preferences (~/.tmux-ide/config.json)
// ---------------------------------------------------------------------------

/** Restore behaviour toggles (minimal, pre-M14). */
export interface RestorePrefs {
  resumeAgents: boolean;
}

/** Default: don't resume agents unless asked (flag or config). */
export const DEFAULT_RESTORE_PREFS: RestorePrefs = { resumeAgents: false };

/**
 * PURE — read `{ restore: { resumeAgents } }` out of a parsed config, falling
 * back to {@link DEFAULT_RESTORE_PREFS} for anything missing or mistyped.
 * Delegates to the shared {@link parseAppConfig} so restore parsing can't drift
 * from the rest of the config.
 */
export function restorePrefs(parsedConfig: unknown): RestorePrefs {
  return parseAppConfig(parsedConfig).restore;
}

/** Absolute path to the shared config (honors `TMUX_IDE_CONFIG`). */
export function restoreConfigPath(): string {
  return appConfigPath();
}

/** io — resolve restore prefs from the shared app config; missing/invalid → defaults. */
export function readRestorePrefs(): RestorePrefs {
  return loadAppConfig().restore;
}

// ---------------------------------------------------------------------------
// io — execute a rebuild action against live tmux
// ---------------------------------------------------------------------------

function tmuxCapture(args: string[]): string {
  return runTmux(args, { encoding: "utf-8" }).toString().trim();
}

/** Options for one raw rebuild (see {@link rebuildSession}). */
interface RebuildOptions {
  /** Replay each pane's recorded command (`--run-commands`). */
  runCommands: boolean;
  /** Relaunch resumable agent panes as `claude --resume <id>` (`--resume-agents`). */
  resumeAgents: boolean;
}

/**
 * Raw-rebuild one session from its snapshot: create the session + its first
 * window, add the remaining windows, split each window's panes (with their
 * cwds), apply the recorded layout, restore titles, set the active window, and
 * relaunch each pane per {@link RebuildOptions}.
 *
 * Per pane, at most ONE command is ever sent: an agent-resume command (when
 * eligible under {@link paneResumeCommand}) takes precedence and, if it fires,
 * suppresses the `--run-commands` replay for that pane. Returns the titles of
 * the panes that were resumed (for the report).
 */
function rebuildSession(session: SessionSnapshot, opts: RebuildOptions): string[] {
  const { runCommands, resumeAgents } = opts;
  const resumedTitles: string[] = [];
  const windows = session.windows;
  if (windows.length === 0) {
    runTmux(["new-session", "-d", "-s", session.name, "-c", session.cwd]);
    return resumedTitles;
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
      // Resume the agent conversation if eligible; that takes precedence over
      // the recorded-command replay so a pane is never sent two commands.
      const resumeCmd = paneResumeCommand(pane, { resumeAgents });
      if (resumeCmd) {
        runTmux(["send-keys", "-t", paneId, "-l", "--", resumeCmd]);
        runTmux(["send-keys", "-t", paneId, "Enter"]);
        resumedTitles.push(pane.title || paneId);
      } else if (runCommands && pane.command) {
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
  return resumedTitles;
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
  /** Relaunch resumable agent panes (`--resume-agents`); ORed with config default. */
  resumeAgents?: boolean;
}

/** One rebuilt session's resumed agent panes (for the report). */
interface ResumedSession {
  session: string;
  panes: string[];
}

/**
 * Rebuild the fleet from the last snapshot. Missing snapshot → friendly exit 1.
 * `dryRun` prints the plan without touching tmux; `runCommands` opts into
 * replaying recorded pane commands (off by default for safety); `resumeAgents`
 * (flag ORed with the `~/.tmux-ide/config.json` default) revives agent
 * conversations via `claude --resume <id>`.
 */
export async function restore({
  json = false,
  dryRun = false,
  runCommands = false,
  resumeAgents = false,
}: RestoreOptions = {}): Promise<void> {
  const snapshot = readSnapshot();
  if (!snapshot) {
    throw new IdeError(
      "no snapshot yet — the updater writes one every ~30s while any session is adopted",
      { code: "NO_SNAPSHOT", exitCode: 1 },
    );
  }

  // The flag forces resume on; config makes it the default. No negative flag.
  const resume = resumeAgents || readRestorePrefs().resumeAgents;
  const plan = buildRestorePlan(snapshot, liveSessions(), ideBackedProjects());

  if (dryRun) {
    reportPlan(plan, snapshot, {
      json,
      dryRun: true,
      restored: [],
      launched: [],
      resumed: [],
      resumeAgents: resume,
    });
    return;
  }

  const restored: string[] = [];
  const launched: string[] = [];
  const resumed: ResumedSession[] = [];
  const recordResumed = (session: string, panes: string[]) => {
    if (panes.length) resumed.push({ session, panes });
  };
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
          recordResumed(snap.name, rebuildSession(snap, { runCommands, resumeAgents: resume }));
          if (snap.adopted) safeAdopt(snap.name);
          restored.push(action.session);
        }
      }
      continue;
    }
    recordResumed(
      action.session.name,
      rebuildSession(action.session, { runCommands, resumeAgents: resume }),
    );
    if (action.session.adopted) safeAdopt(action.session.name);
    restored.push(action.session.name);
  }

  reportPlan(plan, snapshot, {
    json,
    dryRun: false,
    restored,
    launched,
    resumed,
    resumeAgents: resume,
  });
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
  /** Per-session resumed agent panes (empty on dry-run — see `resumeAgents`). */
  resumed: ResumedSession[];
  /** Whether resume is on (drives the dry-run `(would resume N agents)` note). */
  resumeAgents: boolean;
}

function reportPlan(
  plan: RestorePlan,
  snapshot: FleetSnapshot,
  { json, dryRun, restored, launched, resumed, resumeAgents }: ReportContext,
): void {
  const skipped = plan.actions.filter((a) => a.kind === "skip").map((a) => a.session);
  const willLaunch = plan.actions.filter((a) => a.kind === "launch").map((a) => a.session);
  const willRebuild = plan.actions.filter((a) => a.kind === "rebuild").map((a) => a.session.name);
  const resumedPanes = resumed.reduce((n, r) => n + r.panes.length, 0);

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
          resumeAgents,
          resumedPanes,
          resumed,
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
        const wouldResume = countResumableAgents(action.session, resumeAgents);
        const resumeNote = wouldResume
          ? `, would resume ${wouldResume} agent${wouldResume === 1 ? "" : "s"}`
          : "";
        console.log(
          `  rebuild  ${action.session.name} (${w} window${w === 1 ? "" : "s"}, ${p} pane${p === 1 ? "" : "s"}${resumeNote})`,
        );
      }
    }
    return;
  }

  const resumedBySession = new Map(resumed.map((r) => [r.session, r.panes.length]));
  const resumeSuffix = (name: string) => {
    const n = resumedBySession.get(name) ?? 0;
    return n ? ` (resumed ${n} agent${n === 1 ? "" : "s"})` : "";
  };
  const parts: string[] = [];
  if (restored.length)
    parts.push(`rebuilt ${restored.map((s) => `${s}${resumeSuffix(s)}`).join(", ")}`);
  if (launched.length) parts.push(`launched ${launched.join(", ")}`);
  if (skipped.length) parts.push(`skipped ${skipped.join(", ")} (already running)`);
  console.log(parts.length ? `Restored: ${parts.join("; ")}` : "Nothing to restore.");
}
