/**
 * The HOME panel's row model (M21.9) — PURE so it unit-tests without OpenTUI.
 *
 * Home used to be a flat list of live sessions; now it is a list of ITEMS:
 * every live session (unchanged, first), then — when the project registry has
 * projects with no live session — a section header followed by one launchable
 * row per registered-but-not-running project. That surfaces the registry as a
 * mouse-first "open project" affordance: clicking (or pressing enter on) a
 * project row launches a detached session in its dir and opens it as the
 * workspace.
 *
 * The item list is what the render walks AND what the router's `gy - 2` row
 * math indexes, so selection/hover/click all share one geometry. Headers are
 * not selectable; the step/clamp helpers keep the keyboard selection on real
 * rows without the app hand-rolling skip loops.
 */
import { basename } from "node:path";
import type { AgentStatus } from "../detect/classify.ts";
import type { AppKeys } from "../../lib/app-config.ts";
import { prefixTwinFor } from "./settings-model.ts";

/** A live tmux session row — click/enter opens it as the workspace. */
export interface HomeSessionItem {
  kind: "session";
  session: string;
  project: string;
  status: AgentStatus;
  windows: number;
  dir: string | null;
}
/** A registered project with no live session — click/enter launches it. */
export interface HomeProjectItem {
  kind: "project";
  name: string;
  dir: string | null;
}
/** A recently-opened folder with no live session or registry entry (M22.5) —
 *  click/enter re-opens it (create-or-attach a session in `dir`). */
export interface HomeRecentItem {
  kind: "recent";
  name: string;
  dir: string;
}
/** A non-selectable section label between the sessions and the registry. */
export interface HomeHeaderItem {
  kind: "header";
  label: string;
}
export type HomeItem = HomeSessionItem | HomeProjectItem | HomeRecentItem | HomeHeaderItem;

/** The slice of the `tmux-ide team --json` payload this model reads (kept
 *  structural so the app's locally-declared fleet shape satisfies it). */
export interface HomeFleetProject {
  name: string;
  dir: string | null;
  registered: boolean;
  running: boolean;
  sessions: Array<{
    name: string;
    status: AgentStatus;
    windows: Array<unknown>;
  }>;
}

export const REGISTRY_HEADER_LABEL = "registered projects — not running";
export const RECENTS_HEADER_LABEL = "recently opened";

/** PURE — the ordered home items: every project's live sessions first (the
 *  exact rows home always showed), then a header + one row per registered
 *  project that has no live session, then (M22.5) a "recently opened" section.
 *  Recents dedupe against the REGISTRY (registry wins) — a folder you saved as
 *  a project shows only as its project row, never doubled as a recent. Recents
 *  are NOT deduped against live sessions: opening a folder spins up a session,
 *  yet the folder still belongs in "recent" for one-click reopen later. */
export function buildHomeItems(
  projects: readonly HomeFleetProject[],
  recents: readonly string[] = [],
): HomeItem[] {
  const items: HomeItem[] = [];
  for (const p of projects) {
    for (const s of p.sessions) {
      items.push({
        kind: "session",
        session: s.name,
        project: p.name,
        status: s.status,
        windows: s.windows.length,
        dir: p.dir,
      });
    }
  }
  const idle = projects.filter((p) => p.registered && !p.running);
  if (idle.length > 0) {
    items.push({ kind: "header", label: REGISTRY_HEADER_LABEL });
    for (const p of idle) items.push({ kind: "project", name: p.name, dir: p.dir });
  }
  // A folder already saved as a registered project is not repeated under
  // "recent" (registry wins the dedupe).
  const registeredDirs = new Set<string>();
  for (const p of projects) if (p.dir && p.registered) registeredDirs.add(p.dir);
  const freshRecents = recents.filter((d) => d.length > 0 && !registeredDirs.has(d));
  if (freshRecents.length > 0) {
    items.push({ kind: "header", label: RECENTS_HEADER_LABEL });
    for (const dir of freshRecents) {
      items.push({ kind: "recent", name: basename(dir) || dir, dir });
    }
  }
  return items;
}

/** PURE — first-run when the fleet has no live sessions AND no registered
 *  projects (M22.5). Recently-opened folders alone do NOT count — the welcome
 *  still greets someone who has only browsed folders, and hides the moment a
 *  session or project exists. */
export function isFirstRun(projects: readonly HomeFleetProject[]): boolean {
  const hasSession = projects.some((p) => p.sessions.length > 0);
  const hasProject = projects.some((p) => p.registered);
  return !hasSession && !hasProject;
}

/** PURE — the one-line first-run tip built from the USER'S ACTUAL keybindings
 *  (M22.5): the reliable `prefix <letter>` twin for each action, falling back
 *  to the raw Alt key when a letter is claimed by a stock tmux bind. */
export function firstRunTip(keys: AppKeys): string {
  const k = (alt: string): string => {
    const twin = prefixTwinFor(alt);
    return twin ? `prefix ${twin}` : alt;
  };
  return `Your keys: ${k(keys.home)} home · ${k(keys.popup)} switch sessions · ${k(keys.menu)} actions`;
}

/** PURE — the leading-space padding that horizontally centers a `len`-wide run
 *  in a `width`-wide area (never negative). Shared by the welcome render and
 *  the click router so a centered clickable lands where it is drawn. */
export function centerPad(width: number, len: number): number {
  return Math.max(0, Math.floor((width - len) / 2));
}

/** PURE — whether an item takes selection / clicks as a row. */
export function isSelectable(item: HomeItem | undefined): boolean {
  return item !== undefined && item.kind !== "header";
}

/** PURE — clamp a selection index onto a selectable item: into range first,
 *  then the nearest selectable at-or-above, falling back downward. Returns 0
 *  for an empty list (matching the old `Math.min(sel, len - 1)` behavior). */
export function clampSelectable(items: readonly HomeItem[], sel: number): number {
  if (items.length === 0) return 0;
  const start = Math.max(0, Math.min(sel, items.length - 1));
  for (let i = start; i < items.length; i++) if (isSelectable(items[i])) return i;
  for (let i = start - 1; i >= 0; i--) if (isSelectable(items[i])) return i;
  return 0;
}

/** PURE — move the selection one selectable row in `delta`'s direction (±1),
 *  skipping headers; stays put at either end. */
export function stepSelectable(items: readonly HomeItem[], from: number, delta: 1 | -1): number {
  for (let i = from + delta; i >= 0 && i < items.length; i += delta) {
    if (isSelectable(items[i])) return i;
  }
  return from;
}

/** PURE — a tmux-legal session name for a project: tmux forbids `:` and `.`
 *  in session names (target syntax), and spaces only invite quoting bugs —
 *  all collapse to `-`. */
export function sessionNameFor(project: string): string {
  return project.replace(/[.:\s]+/g, "-");
}

/** PURE — whether a user-typed session name is directly usable. */
export function isValidSessionName(name: string): boolean {
  return name.length > 0 && !/[.:\s]/.test(name);
}
