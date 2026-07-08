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
import { DEFAULT_THEME, getAppConfig, type AppTheme } from "../../lib/app-config.ts";
import {
  maybeCheckForUpdate,
  markUpdateNotified,
  type UpdateStatus,
} from "../../lib/update-check.ts";
import { createStatusTracker, type AgentStatus } from "../detect/classify.ts";
import { listTeamProjects, type TeamProject } from "../team/projects.ts";
import type { PaneDetail } from "../team/sessions.ts";
import { paneChip } from "./chip.ts";
import { appendEvents, diffFleet, type AgentEventInit } from "./events.ts";
import {
  decideNotifications,
  enabledStates,
  inQuietHours,
  listAttachedClients,
  readNotificationPrefs,
  sendSystemNotification,
  sendToasts,
  type AttachedClient,
  type NotificationPrefs,
  type NotifyEvent,
  type SystemNotification,
  type ToastTarget,
} from "./notify.ts";
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
/** Per-session marker option set on adopt so the updater can enumerate adopted sessions. */
export const ADOPTED_OPTION = "@tmux_ide_adopted";
/** The hidden internal session that hosts the updater loop. */
export const UPDATER_SESSION = "_tmux-ide-chrome";
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
   * Notification dispatch (optional). When wired alongside `prevState`, the tick
   * turns THIS tick's transitions into user pings — toasts on attached clients
   * and/or a macOS notification — via {@link decideNotifications}, gated on
   * `prefs`. `lastNotified` is the persistent debounce map, mutated in place.
   * All deps-injected so the routing is unit-tested without a live tmux.
   */
  listClients?: () => AttachedClient[];
  lastNotified?: Map<string, number>;
  now?: () => number;
  prefs?: NotificationPrefs;
  sendToasts?: (toasts: ToastTarget[]) => void;
  sendSystem?: (n: SystemNotification) => void;
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

/** Flatten the project view to a flat per-session status list for {@link diffFleet}. */
function fleetStatuses(projects: TeamProject[]): Array<{ name: string; status: AgentStatus }> {
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
  if (update?.updateAvailable && update.latest) dispatchUpdateToast(deps, update.latest);
  if (deps.prevState && deps.appendEvents) {
    const { events, state } = diffFleet(deps.prevState, fleetStatuses(projects));
    deps.prevState.clear();
    for (const [name, status] of state) deps.prevState.set(name, status);
    if (events.length > 0) {
      deps.appendEvents(events);
      dispatchNotifications(deps, enrichEvents(events, panes, deps.locatePane));
    }
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
 * PURE — pick the pane to name in a session-level ping. A session rolls up many
 * panes; the ping should point at ONE. We take a pane whose status matches the
 * transition (`to`), preferring one that resolved to a real agent (so the ping
 * reads `claude blocked …`, not a bare shell). Null when no pane matches — the
 * updater then falls back to the session name / a generic label.
 */
export function pickRepresentativePane(
  session: string,
  to: AgentStatus,
  panes: PaneDetail[],
): PaneDetail | null {
  const matching = panes.filter((p) => p.sessionName === session && p.status === to);
  if (matching.length === 0) return null;
  return matching.find((p) => p.agent !== null) ?? matching[0]!;
}

/**
 * PURE — enrich session-level transitions with the pane's `agent` id and human
 * `location` so {@link notifyMessage} can name who needs the user. Only the
 * notifiable states (blocked/done) get resolved — everything else keeps the bare
 * session as its location and is filtered out downstream anyway, so `locate`
 * (a live tmux call) only fires for a real ping.
 */
export function enrichEvents(
  events: AgentEventInit[],
  panes: PaneDetail[],
  locate?: (paneId: string) => string,
): NotifyEvent[] {
  return events.map((ev) => {
    const notifiable = ev.to === "blocked" || ev.to === "done";
    const rep = notifiable ? pickRepresentativePane(ev.session, ev.to, panes) : null;
    return {
      ...ev,
      agent: rep?.agent ?? null,
      location: rep && locate ? locate(rep.paneId) : ev.session,
    };
  });
}

/**
 * Ping the user about who needs them from this tick's transitions. Only runs
 * when the notification deps are wired, notifications are `enabled`, AND at
 * least one channel is on. `lastNotified` is mutated in place so the debounce
 * (the flap guard) persists across ticks. The macOS banner is additionally
 * gated on QUIET HOURS — inside the window the banner is skipped, but the event
 * has already been recorded to the log by the caller, so history stays honest.
 */
function dispatchNotifications(deps: UpdaterTickDeps, events: NotifyEvent[]): void {
  const { listClients, lastNotified, now, prefs, sendToasts: toast, sendSystem } = deps;
  if (!listClients || !lastNotified || !now || !prefs) return;
  if (!prefs.enabled) return;
  if (!prefs.toast && !prefs.macos) return;
  const nowMs = now();
  const decision = decideNotifications(
    events,
    listClients(),
    lastNotified,
    nowMs,
    enabledStates(prefs),
  );
  lastNotified.clear();
  for (const [key, ts] of decision.nextLastNotified) lastNotified.set(key, ts);
  if (prefs.toast && toast) toast(decision.toasts);
  if (prefs.macos && sendSystem && !inQuietHours(new Date(nowMs), prefs.quietHours)) {
    for (const n of decision.system) sendSystem(n);
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
 * isn't up, start it detached running `tmux-ide chrome-updater`. `exec` replaces
 * the shell so the pane IS the loop; killing the session stops it. `_`-internal
 * so it's hidden from the bar/switcher. Best-effort — a chrome failure must
 * never break adopt/launch.
 */
export function startUpdaterIfNeeded(): void {
  try {
    if (updaterRunning()) return;
    runTmux(["new-session", "-d", "-s", UPDATER_SESSION, "exec tmux-ide chrome-updater"]);
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

/**
 * Run the updater loop forever (the body of `tmux-ide chrome-updater`). Claims
 * single-ownership, then rewrites every adopted session's bar immediately and
 * every {@link TICK_MS} thereafter behind ONE persistent tracker (so `done`
 * transitions surface). Blocks — the interval keeps the event loop alive.
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
  // Persistent so the notification debounce survives across ticks.
  const lastNotified = new Map<string, number>();
  // Persistent per-pane chip cache so we only rewrite a chip when it changed.
  const chipCache = new Map<string, string>();
  // The fleet snapshotter — pulsed each tick, self-throttled, writes only on a
  // structural change so the fleet can be rebuilt after a tmux-server death.
  const snapshotter = createSnapshotter({
    collect: () => collectFleetSnapshot(),
    read: readSnapshot,
    write: writeSnapshot,
    every: config.updater.snapshotEvery,
  });
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
        listClients: listAttachedClients,
        lastNotified,
        now: () => Date.now(),
        prefs: readNotificationPrefs(),
        sendToasts,
        sendSystem: sendSystemNotification,
        locatePane: paneLocation,
        maybeCheckForUpdate: () => maybeCheckForUpdate({ enabled: config.updates.check }),
        markUpdateNotified,
      });
    } catch {
      // never let one bad tick kill the loop
    }
    try {
      snapshotter.onTick();
    } catch {
      // a failed snapshot just means staler disaster-recovery state
    }
  };
  tick();
  const timer = setInterval(tick, config.updater.tickMs);
  const shutdown = () => {
    clearInterval(timer);
    releaseUpdater();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
