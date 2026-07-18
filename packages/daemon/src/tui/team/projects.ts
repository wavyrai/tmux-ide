/**
 * Project-level data layer for the team TUI.
 *
 * Where `sessions.ts` enumerates the LIVE tmux sessions, this module lifts
 * that list into the two-level PROJECT model the TUI actually navigates:
 * every registered project appears (even with no running session), with its
 * live sessions nested underneath. Live sessions that don't belong to any
 * registered project surface as ad-hoc projects so nothing is hidden.
 *
 * The grouping is a PURE function (`groupSessions`) so it can be tested
 * without touching tmux or the on-disk registry; `listTeamProjects` is the
 * thin io wrapper that feeds it real data and never throws.
 */
import { getSessionCwd } from "@tmux-ide/tmux-bridge";
import type { AgentStatus, StatusTracker } from "../detect/classify.ts";
import { listProjects } from "../../lib/project-registry.ts";
import {
  listTeamSessions,
  rollupStatus,
  type ListTeamSessionsOpts,
  type TeamSession,
} from "./sessions.ts";

export interface TeamProject {
  name: string;
  dir: string | null;
  hasIdeYml: boolean;
  hasWorkspaceConfig?: boolean;
  configKind?: "workspace" | "legacy" | "none";
  configPath?: string | null;
  gitBranch: string | null;
  /** True when the project comes from the registry (vs. an ad-hoc session). */
  registered: boolean;
  /** True when at least one live tmux session maps to this project. */
  running: boolean;
  status: AgentStatus;
  sessions: TeamSession[];
}

/** The plain project shape `groupSessions` needs — a subset of RegisteredProject. */
export interface ProjectInput {
  name: string;
  dir: string;
  hasIdeYml?: boolean;
  hasWorkspaceConfig?: boolean;
  configKind?: "workspace" | "legacy" | "none";
  configPath?: string | null;
  gitBranch?: string | null;
}

/**
 * Normalize a directory for prefix comparison. Strips a trailing slash so
 * `/a/b` and `/a/b/` compare equal, but keeps the root `/` intact.
 */
function normalizeDir(dir: string): string {
  if (dir.length > 1 && dir.endsWith("/")) return dir.slice(0, -1);
  return dir;
}

/**
 * Whether `cwd` is `dir` itself or nested inside it. Trailing-slash aware so
 * `/a/bee` is NOT considered inside `/a/b`.
 */
function isInside(cwd: string, dir: string): boolean {
  const base = normalizeDir(dir);
  const path = normalizeDir(cwd);
  if (path === base) return true;
  return path.startsWith(base === "/" ? "/" : `${base}/`);
}

/**
 * Group live sessions under registered projects.
 *
 * Each session is assigned to at most one project: a name match wins first,
 * then a cwd match (the session's `pane_current_path` equalling or nested
 * inside the project's `dir`); when several projects' dirs prefix the same
 * cwd, the longest (most specific) dir wins. Every registered project appears
 * — with an empty `sessions` list and `running:false` when nothing matched.
 * Any session left unmatched becomes an ad-hoc project.
 *
 * PURE: takes a `sessionCwd` resolver so tests can supply a fake map.
 */
export function groupSessions(
  projectsIn: ProjectInput[],
  sessionsIn: TeamSession[],
  sessionCwd: (name: string) => string | null,
): TeamProject[] {
  // Hide INTERNAL plumbing from the whole team model (bar + switcher): the
  // host shell (`_tmux-ide`) and any `_`-prefixed scratch session/project.
  // Mirrors `isInternalName` in ../chrome/statusline.ts (kept inline to avoid a
  // dependency cycle — statusline.ts imports TeamProject from here).
  const projects = projectsIn.filter((p) => !p.name.startsWith("_"));
  const sessions = sessionsIn.filter((s) => !s.name.startsWith("_"));

  const buckets = new Map<string, TeamSession[]>();
  for (const p of projects) buckets.set(p.name, []);

  const matched = new Set<TeamSession>();

  // Pass 1 — name matches take precedence.
  const byName = new Map(projects.map((p) => [p.name, p]));
  for (const session of sessions) {
    if (byName.has(session.name)) {
      buckets.get(session.name)!.push(session);
      matched.add(session);
    }
  }

  // Pass 2 — cwd matches for whatever's left; longest dir wins.
  for (const session of sessions) {
    if (matched.has(session)) continue;
    const cwd = sessionCwd(session.name);
    if (!cwd) continue;
    let best: ProjectInput | undefined;
    for (const p of projects) {
      if (!isInside(cwd, p.dir)) continue;
      if (!best || normalizeDir(p.dir).length > normalizeDir(best.dir).length) best = p;
    }
    if (best) {
      buckets.get(best.name)!.push(session);
      matched.add(session);
    }
  }

  const registered: TeamProject[] = projects
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => {
      const own = buckets.get(p.name) ?? [];
      return {
        name: p.name,
        dir: p.dir,
        hasIdeYml: p.hasIdeYml ?? false,
        hasWorkspaceConfig: p.hasWorkspaceConfig,
        configKind: p.configKind,
        configPath: p.configPath ?? null,
        gitBranch: p.gitBranch ?? null,
        registered: true,
        running: own.length > 0,
        status: rollupStatus(own.map((s) => s.status)),
        sessions: own,
      };
    });

  // Ad-hoc projects: live sessions that matched no registered project.
  const adhoc: TeamProject[] = sessions
    .filter((s) => !matched.has(s))
    .map((s) => ({
      name: s.name,
      dir: sessionCwd(s.name) ?? null,
      hasIdeYml: false,
      hasWorkspaceConfig: false,
      configKind: "none",
      configPath: null,
      gitBranch: null,
      registered: false,
      running: true,
      status: rollupStatus([s.status]),
      sessions: [s],
    }));

  return [...registered, ...adhoc];
}

/**
 * Assemble the two-level project view from the live registry + tmux.
 *
 * Wraps the registry and tmux reads so any failure degrades to a sane partial
 * (an empty registry, or empty sessions) rather than throwing at the TUI.
 *
 * @param opts.viewed Forwarded to {@link listTeamSessions} to acknowledge the
 *   currently-attached session's pending `done`.
 * @param opts.onPane Forwarded to {@link listTeamSessions} so a caller (the
 *   chrome updater) can collect per-pane detail during the same scan.
 */
export function listTeamProjects(
  tracker: StatusTracker,
  opts: Pick<ListTeamSessionsOpts, "viewed" | "onPane"> = {},
): TeamProject[] {
  let projects: ProjectInput[];
  try {
    projects = listProjects();
  } catch {
    projects = [];
  }

  let sessions: TeamSession[];
  try {
    sessions = listTeamSessions(tracker, opts);
  } catch {
    sessions = [];
  }

  const cwd = (name: string): string | null => {
    try {
      return getSessionCwd(name);
    } catch {
      return null;
    }
  };

  return groupSessions(projects, sessions, cwd);
}
