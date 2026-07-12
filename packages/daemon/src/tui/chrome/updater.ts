/**
 * The chrome status-bar updater — ONE background loop that keeps every adopted
 * session's status var fresh.
 *
 * WHY a single updater (vs. the old per-session `#()`): the first chrome
 * pointed each adopted session's `status-format[1]` at
 * `#(tmux-ide statusline …)`, which tmux re-ran every `status-interval` — a
 * full node boot + fleet scan PER adopted session PER tick (~0.35s each). And
 * because each `#()` invocation was stateless it could never produce the
 * cross-tick `done` status (working→idle needs history).
 *
 * This module computes the fleet ONCE per tick behind a PERSISTENT
 * {@link createStatusTracker} (so working→idle surfaces as `done`), then writes
 * a per-session `@tmux_ide_status` user option for each adopted session
 * (per-session so each keeps its own active-highlight). `adoptSession` points
 * `status-format[1]` at a bare `#{@tmux_ide_status}` read — near-free, no spawn.
 *
 * The loop is HOSTED IN TMUX: `adoptSession` spins up a hidden `_tmux-ide-chrome`
 * session running `tmux-ide chrome-updater`, and unadopting the last session
 * kills it. `runUpdaterTick` is factored to take injected io so it's unit-tested
 * without a live tmux; `adoptedSessionsFrom` is a pure parser.
 */
import { hasSession, isProcessAlive, runTmux } from "@tmux-ide/tmux-bridge";
import { ADOPTED_OPTION, UPDATER_SESSION, updaterSpawnArgv } from "./front-door.ts";
import { DEFAULT_THEME, getAppConfig, type AppTheme } from "../../lib/app-config.ts";
import {
  maybeCheckForUpdate,
  markUpdateNotified,
  type UpdateStatus,
} from "../../lib/update-check.ts";
import { createStatusTracker, type AgentStatus } from "../detect/classify.ts";
import { createSessionIdCapturer } from "../detect/session-id.ts";
import { listTeamProjects, type TeamProject } from "../team/projects.ts";
import type { PaneDetail } from "../team/sessions.ts";
import { paneChip } from "./chip.ts";
import { appendEvents, diffFleet, type AgentEventInit } from "./events.ts";
import {
  decideNotifications,
  decideTtyWrites,
  enabledStates,
  inQuietHours,
  listAttachedClients,
  playPingSound,
  readAppFocus,
  readNotificationPrefs,
  sendSystemNotification,
  sendToasts,
  soundEligible,
  writeTtys,
  type AppFocus,
  type AttachedClient,
  type NotificationPrefs,
  type NotifyEvent,
  type SystemNotification,
  type ToastTarget,
  type TtyWrite,
} from "./notify.ts";
import { loadLastNotified, saveLastNotified } from "./notify-state.ts";
import {
  collectFleetSnapshot,
  createSnapshotter,
  readSnapshot,
  writeSnapshot,
} from "./snapshot.ts";
import { buildStatusline } from "./statusline.ts";

/** Per-session user option holding the pre-rendered status-bar string. */
export const STATUS_OPTION = "@tmux_ide_status";
/** Per-PANE user option holding the pre-rendered agent chip (read by pane-border-format). */
export const CHIP_OPTION = "@tmux_ide_chip";
// The adopted marker, the updater session name, and their argv builders live
// in the LEAF module front-door.ts (the unified app imports them without
// pulling this module's fleet-scan graph); re-exported here for the chrome.
export {
  ADOPTED_OPTION,
  UPDATER_SESSION,
  updaterProbeArgv,
  updaterSpawnArgv,
} from "./front-door.ts";
/** Server option holding the running updater's pid (a lightweight single-owner guard). */
export const UPDATER_PID_OPTION = "@tmux_ide_updater_pid";
/** Default tick cadence — overridable via `updater.tickMs` in the app config. */
export const TICK_MS = 2000;

/**
 * PURE — parse `list-sessions -F '#{session_name}\t#{@tmux_ide_adopted}'` output
 * into the list of adopted session names. A session is adopted when its marker
 * field is exactly `"1"` (sessions without the option render an empty field —
 * verified on tmux 3.6, where user options ARE readable in list-sessions
 * formats).
 */
export function adoptedSessionsFrom(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const [name = "", flag = ""] = line.split("\t");
    if (name && flag === "1") out.push(name);
  }
  return out;
}

/** Enumerate adopted sessions from the live tmux server. Never throws. */
export function listAdoptedSessions(): string[] {
  try {
    const raw = runTmux(["list-sessions", "-F", `#{session_name}\t#{${ADOPTED_OPTION}}`])
      .toString()
      .trim();
    return raw ? adoptedSessionsFrom(raw.split("\n")) : [];
  } catch {
    return [];
  }
}

/** Write a session's pre-rendered status var. */
function writeSessionStatus(session: string, value: string): void {
  runTmux(["set-option", "-t", session, STATUS_OPTION, value]);
}

/** Write a pane's pre-rendered chip var (empty string clears it → title fallback). */
function writePaneChip(paneId: string, value: string): void {
  runTmux(["set-option", "-p", "-t", paneId, CHIP_OPTION, value]);
}

/** The io a single tick needs — injectable so the orchestration is unit-tested. */
export interface UpdaterTickDeps {
  listAdopted: () => string[];
  /**
   * Compute the fleet. The tick passes an `onPane` collector so per-pane detail
   * (agent + status) is recovered during the SAME scan the bars are built from
   * — the loop wires this to `listTeamProjects(tracker, { onPane })`. Callers
   * that don't need chips (tests) may ignore the argument.
   */
  computeProjects: (onPane: (pane: PaneDetail) => void) => TeamProject[];
  writeStatus: (session: string, value: string) => void;
  /**
   * The shared palette threaded into {@link buildStatusline} / {@link paneChip}
   * (default {@link DEFAULT_THEME}). The loop resolves it once from the app
   * config so a re-theme applies on the next updater start.
   */
  theme?: AppTheme;
  /**
   * Per-pane chip write (optional). When wired, the tick writes each ADOPTED
   * session's panes a `@tmux_ide_chip` pane option (`agent · status`, or empty
   * for a non-agent pane). Only CHANGED chips are written — `chipCache` holds
   * the last value per pane and is mutated in place across ticks so the steady
   * state costs zero set-options.
   */
  writeChip?: (paneId: string, value: string) => void;
  chipCache?: Map<string, string>;
  /**
   * Transition tracking (optional). When both are supplied, the tick diffs the
   * WHOLE fleet against `prevState` and appends any transitions via
   * `appendEvents`, mutating `prevState` in place to the fresh state. Omitted by
   * callers/tests that only care about the status bars.
   */
  prevState?: Map<string, AgentStatus>;
  appendEvents?: (events: AgentEventInit[]) => void;
  /**
   * Notification dispatch (optional). When wired alongside `prevPaneState`
   * (M25.1 — notifications are PANE-granular so a second agent blocking in an
   * already-blocked session still pings), the tick turns THIS tick's pane
   * transitions into user pings — toasts on attached clients and/or a macOS
   * notification — via {@link decideNotifications}, gated on `prefs`.
   * `lastNotified` is the persistent debounce map, mutated in place (and
   * persisted via `persistNotified` when a ping fired, so a restart can't
   * re-ping inside the window). All deps-injected so the routing is
   * unit-tested without a live tmux.
   */
  prevPaneState?: Map<string, AgentStatus>;
  listClients?: () => AttachedClient[];
  lastNotified?: Map<string, number>;
  now?: () => number;
  prefs?: NotificationPrefs;
  sendToasts?: (toasts: ToastTarget[]) => void;
  sendSystem?: (n: SystemNotification) => void;
  /**
   * The OS-level channel io (M25.2), both optional and deps-injected like the
   * rest: `sendTerminal` writes OSC 9/99 + BEL bytes to client ttys
   * ({@link writeTtys}); `playSound` fires the platform ping sound
   * ({@link playPingSound}). Which clients/states qualify is decided purely
   * ({@link decideTtyWrites} / {@link soundEligible}).
   */
  sendTerminal?: (writes: TtyWrite[]) => void;
  playSound?: () => void;
  /**
   * The DELAYED RE-VERIFY queue (M25.2), loop-owned and mutated in place like
   * `prevPaneState`. With `notifications.delaySeconds > 0`, a notify-eligible
   * transition queues its OS-LEVEL channels here instead of firing them; each
   * tick {@link firePendingOsPings} fires the due entries whose pane is STILL
   * in the notified state (this tick's scan is the re-verify — no setTimeout
   * racing the tick), so a flappy blocked→working inside the window fires
   * nothing OS-level. Toasts never queue — the in-app note stays immediate.
   * Omitted (tests, delay 0) → OS channels fire immediately.
   */
  pendingPings?: PendingOsPing[];
  /** The unified app's focus record (see {@link AppFocus}) — pings for panes
   *  on the app's screen are suppressed. Wired to {@link readAppFocus}. */
  appFocus?: () => AppFocus | null;
  /** Persist the debounce map after a tick that fired a ping. Wired to
   *  {@link saveLastNotified}. */
  persistNotified?: (map: ReadonlyMap<string, number>) => void;
  /**
   * Resolve a pane id to its human `session:window.pane` location for the ping
   * text (optional). Wired to the live tmux {@link paneLocation}; tests inject a
   * pure stub. Only ever called for the pane behind a blocked/done transition.
   */
  locatePane?: (paneId: string) => string;
  /**
   * Update-flow surfacing (optional). When wired, the tick calls this cheap,
   * cache-backed check each tick (throttled internally to 24h; it kicks off a
   * background registry refresh). When it reports an available update the tick
   * threads the `⬆ v<latest>` dock segment into every adopted session's bar and,
   * via {@link markUpdateNotified}, fires a ONE-time toast for that version. Both
   * deps-injected so the surfacing is unit-tested without a live tmux/network.
   */
  maybeCheckForUpdate?: () => UpdateStatus;
  markUpdateNotified?: (version: string) => boolean;
  /**
   * Session-id capture (optional). When wired, receives this tick's per-pane
   * detail so the capturer ({@link ../detect/session-id.ts}) can stamp
   * `@agent_session_id` on codex/cursor panes that lack one — the key
   * `restore --resume-agents` resumes from. Self-throttled and stamp-once, so
   * a fleet with no unstamped capturable panes costs nothing.
   */
  captureSessionIds?: (panes: PaneDetail[]) => void;
}

/**
 * PURE — the reserved dock segment for an available update: the clickable
 * `⬆ v<latest>` chip (accent-colored, wrapped in a `user|update` mouse range so a
 * click floats the update popup — see {@link ./statusline.ts statusClickBindCommand}).
 * Empty string when there's nothing to offer, so it takes no space on the bar.
 */
export function updateSegment(status: UpdateStatus, theme: AppTheme): string {
  if (!status.updateAvailable || !status.latest) return "";
  return `#[range=user|update]#[fg=${theme.accent}]⬆ v${status.latest}#[default]#[norange]`;
}

/** Flatten the project view to a flat per-session status list for {@link diffFleet}.
 *  Exported: the control server's event tick diffs the same projection. */
export function fleetStatuses(
  projects: TeamProject[],
): Array<{ name: string; status: AgentStatus }> {
  return projects.flatMap((p) => p.sessions.map((s) => ({ name: s.name, status: s.status })));
}

/**
 * One tick: if any session is adopted, compute the fleet ONCE and write each
 * adopted session its own {@link buildStatusline} (its name flagged active so
 * the per-session highlight is correct). PURE given its deps — no tmux, no
 * fleet scan when nothing is adopted.
 *
 * When `prevState`/`appendEvents` are wired, it also detects state TRANSITIONS
 * across the whole fleet (not just adopted sessions) and appends them to the
 * event log — the updater is the one process that sees every tick, so it's the
 * natural place to emit history.
 */
export function runUpdaterTick(deps: UpdaterTickDeps): void {
  const adopted = deps.listAdopted();
  if (adopted.length === 0) return;
  const theme = deps.theme ?? DEFAULT_THEME;
  // Collect per-pane detail during the fleet scan so chips need no second pass.
  const panes: PaneDetail[] = [];
  const projects = deps.computeProjects((pane) => panes.push(pane));
  // The dock-first update surface: a cheap cache read that also kicks off the
  // throttled background registry refresh. Threads the "⬆ v<latest>" chip into
  // every bar this tick when an update is pending.
  const update = deps.maybeCheckForUpdate?.();
  const extra = update ? updateSegment(update, theme) : "";
  for (const session of adopted) {
    deps.writeStatus(session, buildStatusline(projects, session, 12, theme, extra));
  }
  writeChips(deps, adopted, panes, theme);
  deps.captureSessionIds?.(panes);
  if (update?.updateAvailable && update.latest) dispatchUpdateToast(deps, update.latest);
  if (deps.prevState && deps.appendEvents) {
    const { events, state } = diffFleet(deps.prevState, fleetStatuses(projects));
    deps.prevState.clear();
    for (const [name, status] of state) deps.prevState.set(name, status);
    if (events.length > 0) deps.appendEvents(events);
  }
  // Notifications ride PANE transitions (M25.1), not the session rollup — a
  // second agent blocking in an already-blocked session is invisible at the
  // session level but is exactly who the user needs to hear about. Due delayed
  // pings re-verify against THIS tick's pane states before the diff mutates
  // anything (M25.2).
  if (deps.prevPaneState) {
    firePendingOsPings(deps, panes);
    const events = diffPaneTransitions(deps.prevPaneState, panes, deps.locatePane);
    if (events.length > 0) dispatchNotifications(deps, events);
  }
}

/**
 * Write each adopted session's panes their agent chip — but only when the chip
 * CHANGED since last tick (per-pane cache), so a steady fleet issues zero
 * set-options. No-op unless both `writeChip` and `chipCache` are wired. Panes of
 * non-adopted (user, un-adopted) sessions are skipped: we only paint borders on
 * sessions we've adopted.
 */
function writeChips(
  deps: UpdaterTickDeps,
  adopted: string[],
  panes: PaneDetail[],
  theme: AppTheme,
): void {
  const { writeChip, chipCache } = deps;
  if (!writeChip || !chipCache) return;
  const adoptedSet = new Set(adopted);
  for (const pane of panes) {
    if (!adoptedSet.has(pane.sessionName)) continue;
    const chip = paneChip(pane.agent, pane.status, theme);
    if (chipCache.get(pane.paneId) === chip) continue;
    chipCache.set(pane.paneId, chip);
    writeChip(pane.paneId, chip);
  }
}

/**
 * PURE (given `locate`) — diff the previous per-pane states against this
 * tick's panes into ready-to-ping {@link NotifyEvent}s: each carries its
 * `paneId` (the debounce/visibility key), `windowIndex` (window-granular toast
 * suppression), the pane's resolved `agent`, and — only for a notifiable
 * blocked/done transition that isn't first-sight — the human `location`
 * (`locate` is a live tmux call, so it only fires for a potential ping).
 * `prev` is mutated in place to the fresh state, like the session-level
 * `prevState`; a pane that vanished simply drops out. First sight of a pane
 * emits `from: null`, which {@link decideNotifications} ignores — that's the
 * restart/first-tick grace.
 */
export function diffPaneTransitions(
  prev: Map<string, AgentStatus>,
  panes: PaneDetail[],
  locate?: (paneId: string) => string,
): NotifyEvent[] {
  const events: NotifyEvent[] = [];
  const next = new Map<string, AgentStatus>();
  for (const pane of panes) {
    const before = prev.has(pane.paneId) ? prev.get(pane.paneId)! : null;
    next.set(pane.paneId, pane.status);
    if (before === pane.status) continue;
    const notifiable = before !== null && (pane.status === "blocked" || pane.status === "done");
    events.push({
      session: pane.sessionName,
      from: before,
      to: pane.status,
      paneId: pane.paneId,
      windowIndex: pane.windowIndex,
      agent: pane.agent,
      location: notifiable && locate ? locate(pane.paneId) : pane.sessionName,
    });
  }
  prev.clear();
  for (const [paneId, status] of next) prev.set(paneId, status);
  return events;
}

/** A queued OS-level ping: the {@link SystemNotification} payload plus when it
 *  becomes due. Fires only if its pane is STILL in `state` at fire time. */
export interface PendingOsPing extends SystemNotification {
  dueAtMs: number;
}

/** PURE — whether ANY channel beyond the master switch is on; an all-off
 *  config costs the tick nothing. */
function anyChannelOn(prefs: NotificationPrefs): boolean {
  return prefs.toast || prefs.macos || prefs.terminal || prefs.sound !== "none";
}

/**
 * Ping the user about who needs them from this tick's transitions. Only runs
 * when the notification deps are wired, notifications are `enabled`, AND at
 * least one channel is on. `lastNotified` is mutated in place so the debounce
 * (the flap guard) persists across ticks. The in-app toast fires IMMEDIATELY
 * (cheap, low-annoyance); the OS-LEVEL channels (banner / terminal escape /
 * sound / BEL) either fire now (`delaySeconds` 0 or no queue wired) or queue
 * onto `pendingPings` for the delayed re-verify (M25.2). The debounce stamp
 * lands at DECIDE time either way — a flap that later cancels its OS ping
 * already toasted, so it spent its debounce slot honestly.
 */
function dispatchNotifications(deps: UpdaterTickDeps, events: NotifyEvent[]): void {
  const { listClients, lastNotified, now, prefs, sendToasts: toast } = deps;
  if (!listClients || !lastNotified || !now || !prefs) return;
  if (!prefs.enabled) return;
  if (!anyChannelOn(prefs)) return;
  const nowMs = now();
  const decision = decideNotifications(
    events,
    listClients(),
    lastNotified,
    nowMs,
    enabledStates(prefs),
    deps.appFocus?.() ?? null,
  );
  lastNotified.clear();
  for (const [key, ts] of decision.nextLastNotified) lastNotified.set(key, ts);
  // A system entry exists for every event that actually fired (stamped the
  // debounce map), so this is exactly "the map changed — persist it".
  if (decision.system.length > 0) deps.persistNotified?.(lastNotified);
  if (prefs.toast && toast) toast(decision.toasts);
  if (decision.system.length === 0) return;
  const delayMs = prefs.delaySeconds * 1000;
  if (delayMs > 0 && deps.pendingPings) {
    for (const n of decision.system) deps.pendingPings.push({ ...n, dueAtMs: nowMs + delayMs });
  } else {
    fireOsChannels(deps, prefs, decision.system, nowMs);
  }
}

/**
 * Fire the DUE queued OS pings whose transition still holds (M25.2). The
 * re-verify is tick-native: this tick's fresh pane scan is the source of truth
 * — a pane that flapped out of the notified state, vanished, or is now on the
 * unified app's screen ({@link AppFocus} — the user got there on their own)
 * fires nothing and is dropped. Prefs are the CURRENT tick's fresh read, so a
 * config change during the delay is honored. Runs before this tick's diff so
 * "the next tick's pane states" is literally what confirms each ping.
 */
function firePendingOsPings(deps: UpdaterTickDeps, panes: PaneDetail[]): void {
  const { pendingPings: pending, now, prefs } = deps;
  if (!pending || pending.length === 0 || !now || !prefs) return;
  const nowMs = now();
  const due: PendingOsPing[] = [];
  const keep: PendingOsPing[] = [];
  for (const p of pending) (p.dueAtMs <= nowMs ? due : keep).push(p);
  if (due.length === 0) return;
  pending.length = 0;
  for (const p of keep) pending.push(p);
  if (!prefs.enabled) return;
  const statusByPane = new Map(panes.map((p) => [p.paneId, p.status]));
  const focus = deps.appFocus?.() ?? null;
  const confirmed = due.filter((p) => {
    // A pane-less ping (session-granular caller) can't be re-verified — fire it.
    if (p.paneId !== null && statusByPane.get(p.paneId) !== p.state) return false;
    if (focus?.attached && p.paneId !== null && focus.panes.includes(p.paneId)) return false;
    return true;
  });
  fireOsChannels(deps, prefs, confirmed, nowMs);
}

/**
 * The OS-LEVEL fan-out (M25.2): system banner, terminal escapes + BEL to
 * eligible client ttys, and the ping sound (at most ONE sound per batch — a
 * fleet-wide flap must not ring a carillon). ALL of it is gated on quiet hours
 * — inside the window nothing OS-level fires (the in-app toast and the event
 * log have already surfaced the transition, so history stays honest).
 */
function fireOsChannels(
  deps: UpdaterTickDeps,
  prefs: NotificationPrefs,
  entries: SystemNotification[],
  nowMs: number,
): void {
  if (entries.length === 0) return;
  if (inQuietHours(new Date(nowMs), prefs.quietHours)) return;
  if (prefs.macos && deps.sendSystem) {
    for (const n of entries) deps.sendSystem(n);
  }
  if ((prefs.terminal || prefs.sound !== "none") && deps.sendTerminal && deps.listClients) {
    const clients = deps.listClients();
    const writes = entries.flatMap((n) => decideTtyWrites(n, clients, prefs));
    if (writes.length > 0) deps.sendTerminal(writes);
  }
  if (deps.playSound && entries.some((n) => soundEligible(n.state, prefs.sound))) {
    deps.playSound();
  }
}

/**
 * io — resolve a pane id to `session:window.pane` (e.g. `myproj:1.2`) for the
 * ping text. Best-effort: a gone pane / failed call degrades to the raw pane id.
 */
export function paneLocation(paneId: string): string {
  try {
    const raw = runTmux([
      "display-message",
      "-p",
      "-t",
      paneId,
      "#{session_name}:#{window_index}.#{pane_index}",
    ])
      .toString()
      .trim();
    return raw || paneId;
  } catch {
    return paneId;
  }
}

/**
 * Toast every attached client ONCE that an update is out — "run: tmux-ide
 * update". The one-time guarantee lives in {@link markUpdateNotified} (persisted
 * in the update cache, so it survives updater restarts, unlike the fleet
 * notification's in-memory debounce). Honors the `toast` prefs kill-switch and
 * no-ops unless the toast deps are wired.
 */
function dispatchUpdateToast(deps: UpdaterTickDeps, version: string): void {
  const { markUpdateNotified: mark, listClients, sendToasts: toast, prefs } = deps;
  if (!mark || !listClients || !toast) return;
  if (prefs && !prefs.toast) return;
  if (!mark(version)) return; // already toasted this version
  const message = `⬆ tmux-ide v${version} available — run: tmux-ide update`;
  toast(listClients().map((c) => ({ client: c.client, message })));
}

/**
 * Seed a single session's status var NOW (a one-off fleet scan). Called by
 * `adoptSession` so a freshly-adopted bar is never blank while it waits for the
 * background loop's next tick. Best-effort — a failure just defers to the loop.
 */
export function seedSessionStatus(session: string): void {
  try {
    const projects = listTeamProjects(createStatusTracker());
    writeSessionStatus(session, buildStatusline(projects, session, 12, getAppConfig().theme));
  } catch {
    // leave it to the updater's next tick
  }
}

/** Whether the updater session is already up. */
export function updaterRunning(): boolean {
  try {
    return hasSession(UPDATER_SESSION);
  } catch {
    return false;
  }
}

/**
 * Ensure the background updater is running: if the `_tmux-ide-chrome` session
 * isn't up, start it detached running `tmux-ide chrome-updater`. `_`-internal
 * so it's hidden from the bar/switcher. Best-effort — a chrome failure must
 * never break adopt/launch.
 */
export function startUpdaterIfNeeded(): void {
  try {
    if (updaterRunning()) return;
    runTmux(updaterSpawnArgv());
  } catch {
    // best-effort — the bar still works via the last-written var
  }
}

/** Kill the updater session (called when the last adopted session is unadopted). */
export function stopUpdater(): void {
  try {
    if (updaterRunning()) runTmux(["kill-session", "-t", UPDATER_SESSION]);
  } catch {
    // already gone — nothing to stop
  }
}

/** Read the pid the current updater owner recorded, or null when unset/garbage. */
function readUpdaterPid(): number | null {
  try {
    const raw = runTmux(["show-option", "-s", "-v", UPDATER_PID_OPTION]).toString().trim();
    const pid = Number(raw);
    return raw && Number.isInteger(pid) ? pid : null;
  } catch {
    // option never set (unset server user-options error out) — no owner
    return null;
  }
}

/**
 * Claim single-ownership of the loop. Returns false when another LIVE updater
 * already holds the pid option (so a stray manual `chrome-updater` exits
 * cleanly instead of double-writing). A dead/stale pid is reclaimed.
 */
function claimUpdater(): boolean {
  const existing = readUpdaterPid();
  if (existing !== null && existing !== process.pid && isProcessAlive(existing)) return false;
  try {
    runTmux(["set-option", "-s", UPDATER_PID_OPTION, String(process.pid)]);
  } catch {
    // if we can't record the pid, still run — the session-level guard suffices
  }
  return true;
}

/** Release ownership on shutdown (only if we still hold it). */
function releaseUpdater(): void {
  try {
    if (readUpdaterPid() === process.pid) runTmux(["set-option", "-s", "-u", UPDATER_PID_OPTION]);
  } catch {
    // best-effort
  }
}

/** Exit the loop after this many CONSECUTIVE ticks with the tmux server gone —
 *  a dead server means nothing to watch and nobody to ping, and an immortal
 *  interval would zombie (two were found live before M25.1). */
export const UPDATER_UNREACHABLE_EXIT_TICKS = 5;

/** PURE — a consecutive-failure counter: feed it each tick's reachability;
 *  it answers "give up now?" after `threshold` misses in a row (any success
 *  resets the run). */
export function createUnreachableCounter(
  threshold: number = UPDATER_UNREACHABLE_EXIT_TICKS,
): (reachable: boolean) => boolean {
  let consecutive = 0;
  return (reachable: boolean): boolean => {
    consecutive = reachable ? 0 : consecutive + 1;
    return consecutive >= threshold;
  };
}

/** io — can we still talk to the tmux server? (A server with zero sessions
 *  exits, so `list-sessions` failing means the server itself is gone.) */
function isServerReachable(): boolean {
  try {
    runTmux(["list-sessions", "-F", "#{session_name}"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the updater loop forever (the body of `tmux-ide chrome-updater`). Claims
 * single-ownership, then rewrites every adopted session's bar immediately and
 * every {@link TICK_MS} thereafter behind ONE persistent tracker (so `done`
 * transitions surface). Blocks — the interval keeps the event loop alive —
 * until the tmux server has been unreachable for
 * {@link UPDATER_UNREACHABLE_EXIT_TICKS} consecutive ticks, at which point the
 * loop logs once and exits instead of running headless forever.
 */
export function runUpdaterLoop(): void {
  if (!claimUpdater()) return;
  // Resolve the config once for the loop's lifetime — cadence + palette. A
  // config change (theme/keys/cadence) takes effect on the next updater start
  // (which a re-adopt triggers).
  const config = getAppConfig();
  const tracker = createStatusTracker();
  // Persistent across ticks so `diffFleet` can spot working→done etc.
  const prevState = new Map<string, AgentStatus>();
  // Per-PANE states for the notification path (M25.1 — pane-granular pings).
  const prevPaneState = new Map<string, AgentStatus>();
  // The notification debounce map — restored from disk so a restart can't
  // re-ping inside the window, persisted back on every ping.
  const lastNotified = loadLastNotified();
  // Queued OS-level pings awaiting their delayed re-verify (M25.2). In-memory
  // only: the window is seconds, so a restart just drops the queue.
  const pendingPings: PendingOsPing[] = [];
  // Persistent per-pane chip cache so we only rewrite a chip when it changed.
  const chipCache = new Map<string, string>();
  // Session-id capture for kinds without a hook integration (codex/cursor):
  // stamps @agent_session_id so restore --resume-agents has its key. Throttled
  // internally; probes only unstamped panes of capturable kinds.
  const capturer = createSessionIdCapturer({
    // Throwing is fine here — the capturer treats a failed stamp as "retry on
    // the next capture window".
    stamp: (paneId, id) => runTmux(["set-option", "-p", "-t", paneId, "@agent_session_id", id]),
  });
  // The fleet snapshotter — pulsed each tick, self-throttled, writes only on a
  // structural change so the fleet can be rebuilt after a tmux-server death.
  const snapshotter = createSnapshotter({
    collect: () => collectFleetSnapshot(),
    read: readSnapshot,
    write: writeSnapshot,
    every: config.updater.snapshotEvery,
  });
  const shouldGiveUp = createUnreachableCounter();
  const tick = () => {
    try {
      runUpdaterTick({
        listAdopted: listAdoptedSessions,
        computeProjects: (onPane) => listTeamProjects(tracker, { onPane }),
        writeStatus: writeSessionStatus,
        theme: config.theme,
        writeChip: writePaneChip,
        chipCache,
        prevState,
        appendEvents,
        prevPaneState,
        listClients: listAttachedClients,
        lastNotified,
        now: () => Date.now(),
        prefs: readNotificationPrefs(),
        sendToasts,
        sendSystem: sendSystemNotification,
        sendTerminal: writeTtys,
        playSound: playPingSound,
        pendingPings,
        locatePane: paneLocation,
        appFocus: () => readAppFocus(),
        persistNotified: (map) => saveLastNotified(map),
        maybeCheckForUpdate: () => maybeCheckForUpdate({ enabled: config.updates.check }),
        markUpdateNotified,
        captureSessionIds: (panes) => capturer.onTick(panes),
      });
    } catch {
      // never let one bad tick kill the loop
    }
    try {
      snapshotter.onTick();
    } catch {
      // a failed snapshot just means staler disaster-recovery state
    }
    // Self-exit when the server we exist to watch is gone (logged ONCE).
    if (shouldGiveUp(isServerReachable())) {
      console.error(
        `tmux-ide chrome-updater: tmux server unreachable for ${UPDATER_UNREACHABLE_EXIT_TICKS} consecutive ticks — exiting`,
      );
      shutdown();
    }
  };
  const timer = setInterval(tick, config.updater.tickMs);
  const shutdown = () => {
    clearInterval(timer);
    releaseUpdater();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  tick();
}
