/**
 * The "who needs me" loop — turn fleet transitions into user-facing pings.
 *
 * The chrome {@link ./updater.ts updater} already sees every session's state
 * transition each tick (via {@link ./events.ts diffFleet}). Watching the status
 * bar for a `blocked`/`done` flip is a chore, so this module fans those two
 * signals out to the human: a tmux toast on each attached client
 * (`display-message -c`), and optionally a macOS notification.
 *
 * Split as usual: {@link decideNotifications} + {@link notifyMessage} +
 * {@link enabledStates} + {@link inQuietHours} + {@link parseNotificationPrefs}
 * + {@link applyKillSwitch} + {@link parseClients} + {@link terminalNotifierArgs}
 * are PURE (unit-tested without a live tmux / filesystem); {@link sendToasts},
 * {@link sendSystemNotification}, {@link hasTerminalNotifier},
 * {@link listAttachedClients} and {@link readNotificationPrefs} are the thin io
 * wrappers. Every io path is best-effort — a failed ping must never break the
 * updater loop.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { runTmux } from "@tmux-ide/tmux-bridge";
import { appConfigPath, parseAppConfig } from "../../lib/app-config.ts";
import { APP_HOST_SESSION } from "../mirror/hosted.ts";
import type { AgentStatus } from "../detect/classify.ts";

/**
 * A fleet transition this tick — since M25.1 a PANE-level transition (the
 * updater diffs per-pane states, not the session rollup, so a second agent
 * blocking in an already-blocked session still pings), ENRICHED with the
 * pane's resolved `agent` id and human `location` (`session:window.pane`) so
 * the ping can name who needs the user. The enrichments are optional: a caller
 * that can't resolve them falls back to a generic `agent` label and the bare
 * session name (see {@link notifyMessage}).
 */
export interface NotifyEvent {
  session: string;
  from: AgentStatus | null;
  to: AgentStatus;
  /** Resolved agent id (e.g. `claude`), or null/absent when unknown. */
  agent?: string | null;
  /** Human location `session:window.pane` (e.g. `myproj:1.2`); falls back to `session`. */
  location?: string;
  /** The pane behind the transition — the debounce key and the visibility
   *  test both want the pane, not the session. Absent for a caller that only
   *  has session granularity (falls back to session-keyed behavior). */
  paneId?: string | null;
  /** The pane's `window_index` — window-granular toast suppression needs it.
   *  Absent/null degrades that check to session granularity. */
  windowIndex?: number | null;
}

/** An attached tmux client, the session it's viewing, and that session's
 *  CURRENT window (null when the caller couldn't resolve it — suppression then
 *  degrades to session granularity for that client). */
export interface AttachedClient {
  client: string;
  session: string;
  windowIndex?: number | null;
}

/** A toast destined for one client's status line. */
export interface ToastTarget {
  client: string;
  message: string;
}

/**
 * A macOS-notification payload. `session` rides along so the click-through path
 * ({@link terminalNotifierArgs}) can focus the right session on click.
 */
export interface SystemNotification {
  message: string;
  session: string;
}

/** The verdict of {@link decideNotifications}. */
export interface NotifyDecision {
  toasts: ToastTarget[];
  system: SystemNotification[];
  /** The debounce map to thread into the next tick (a copy of the input). */
  nextLastNotified: Map<string, number>;
}

/** The only two states worth pinging the user over. */
const NOTIFY_STATES: ReadonlySet<AgentStatus> = new Set<AgentStatus>(["blocked", "done"]);
/**
 * Don't re-ping the same session+state more than once inside this window. This
 * is what tames a FLAPPING agent (working↔blocked every few seconds): the first
 * `blocked` fires, and every subsequent `blocked` inside the window is dropped,
 * so a flap notifies at most once per 30s instead of on every bounce.
 */
export const NOTIFY_DEBOUNCE_MS = 30_000;
/** Cap the ping text so a macOS banner never truncates mid-word (banners clip ~200+). */
export const NOTIFY_MAX_LEN = 120;

/** PURE — the trailing clause for a notifiable state. */
function statusPhrase(to: AgentStatus): string {
  return to === "blocked" ? "needs input" : "finished";
}

/**
 * PURE — the human-readable ping for an (enriched) transition, e.g.
 * `claude blocked · myproj:1.2 — needs input`. Falls back to a generic `agent`
 * label and the bare session name when the updater couldn't resolve the pane's
 * agent/location. Clamped to {@link NOTIFY_MAX_LEN} so it fits a macOS banner.
 */
export function notifyMessage(ev: NotifyEvent): string {
  const agent = ev.agent && ev.agent.length > 0 ? ev.agent : "agent";
  const where = ev.location && ev.location.length > 0 ? ev.location : ev.session;
  const text = `${agent} ${ev.to} · ${where} — ${statusPhrase(ev.to)}`;
  return text.length > NOTIFY_MAX_LEN ? `${text.slice(0, NOTIFY_MAX_LEN - 1)}…` : text;
}

/**
 * PURE — which states this user has opted into pinging on, from the
 * `onBlocked`/`onDone` prefs. Empty when both are off (→ no notifications).
 */
export function enabledStates(prefs: NotificationPrefs): ReadonlySet<AgentStatus> {
  const states = new Set<AgentStatus>();
  if (prefs.onBlocked) states.add("blocked");
  if (prefs.onDone) states.add("done");
  return states;
}

/** PURE — the debounce-map key for an event: the PANE when known (so a second
 *  agent blocking in the same session still pings — per-pane debounce), else
 *  the session (session-granular callers keep the old behavior). */
export function notifyDebounceKey(ev: Pick<NotifyEvent, "session" | "to" | "paneId">): string {
  return `${ev.paneId ?? ev.session}:${ev.to}`;
}

/** PURE — should this client's toast be suppressed for this event? A client
 *  gets no toast when it is already LOOKING at the transition: same session
 *  AND same window (window-granular since M25.1 — an agent in window 2 while
 *  the client views window 1 IS toast-worthy). Unknown window info on either
 *  side degrades to the old session-granular suppression. Clients viewing the
 *  hosted app are always suppressed: the app has its own in-app surfacing, and
 *  a raw tmux message over the app's renderer is noise. */
export function suppressToastFor(client: AttachedClient, ev: NotifyEvent): boolean {
  if (client.session === APP_HOST_SESSION) return true;
  if (client.session !== ev.session) return false;
  if (ev.windowIndex === undefined || ev.windowIndex === null) return true;
  if (client.windowIndex === undefined || client.windowIndex === null) return true;
  return client.windowIndex === ev.windowIndex;
}

/**
 * PURE — decide who to ping from this tick's transitions.
 *
 * Rules:
 *   - a FIRST-SIGHT event (`from: null`) never notifies — the updater's first
 *     tick (or a restart, or a session appearing) sees every pane as new, and
 *     re-pinging an agent that has been blocked for an hour is noise;
 *   - only states in `states` qualify (default {@link NOTIFY_STATES}; the caller
 *     narrows it via {@link enabledStates} to honor `onBlocked`/`onDone`);
 *   - DEBOUNCE: skip a pane+state (see {@link notifyDebounceKey}) that fired
 *     within {@link NOTIFY_DEBOUNCE_MS} — the flap guard;
 *   - APP FOCUS: when the unified app is attached and the event's pane is on
 *     its screen ({@link AppFocus}), the user is LOOKING at it — no toast, no
 *     banner (and no debounce stamp: nothing fired);
 *   - SUPPRESS the toast for any client already viewing that pane's window
 *     ({@link suppressToastFor}) — other clients still get toasted;
 *   - a `system` entry is produced per qualifying, non-debounced event regardless
 *     of clients (so the macOS path fires even with nothing attached — the
 *     caller gates it on prefs / quiet hours).
 *
 * Returns the toasts/system to dispatch plus `nextLastNotified` (a copy of the
 * input with fresh timestamps for the events we acted on) to thread onward.
 */
export function decideNotifications(
  events: NotifyEvent[],
  clients: AttachedClient[],
  lastNotified: Map<string, number>,
  nowMs: number,
  states: ReadonlySet<AgentStatus> = NOTIFY_STATES,
  appFocus: AppFocus | null = null,
): NotifyDecision {
  const nextLastNotified = new Map(lastNotified);
  const toasts: ToastTarget[] = [];
  const system: SystemNotification[] = [];
  for (const ev of events) {
    if (ev.from === null) continue; // first sight — not a transition worth pinging
    if (!states.has(ev.to)) continue;
    const key = notifyDebounceKey(ev);
    const last = nextLastNotified.get(key);
    if (last !== undefined && nowMs - last < NOTIFY_DEBOUNCE_MS) continue;
    if (appFocus?.attached && ev.paneId && appFocus.panes.includes(ev.paneId)) continue;
    nextLastNotified.set(key, nowMs);
    const message = notifyMessage(ev);
    for (const c of clients) {
      if (suppressToastFor(c, ev)) continue;
      toasts.push({ client: c.client, message });
    }
    system.push({ message, session: ev.session });
  }
  return { toasts, system, nextLastNotified };
}

/** PURE — parse `list-clients -F '#{client_name}\t#{session_name}\t#{window_index}'`
 *  output (the third field is the client's session's CURRENT window; missing/
 *  non-numeric parses as null so old two-field callers degrade gracefully). */
export function parseClients(lines: string[]): AttachedClient[] {
  const out: AttachedClient[] = [];
  for (const line of lines) {
    const [client = "", session = "", win = ""] = line.split("\t");
    if (!client || !session) continue;
    const n = Number.parseInt(win, 10);
    out.push({ client, session, windowIndex: Number.isInteger(n) ? n : null });
  }
  return out;
}

/** io — enumerate attached clients (+ their current window) from the live tmux
 *  server. Never throws. */
export function listAttachedClients(): AttachedClient[] {
  try {
    const raw = runTmux(["list-clients", "-F", "#{client_name}\t#{session_name}\t#{window_index}"])
      .toString()
      .trim();
    return raw ? parseClients(raw.split("\n")) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The app focus handshake (M25.1)
// ---------------------------------------------------------------------------

/**
 * What the unified app publishes about its own screen, so the updater can
 * suppress pings for panes the user is literally looking at. Lives as a tmux
 * SERVER option ({@link APP_FOCUS_OPTION}) rather than a file: the record is
 * scoped to exactly the server whose panes are being watched (no cross-server
 * or cross-`TMUX_IDE_HOME` leakage), it is readable in the same cheap tmux
 * calls the updater already makes, and it DIES WITH THE SERVER — a crashed
 * server can't leave a stale record behind. A crashed APP can, which is what
 * the `ts` staleness guard covers ({@link APP_FOCUS_STALE_MS}).
 */
export interface AppFocus {
  /** Epoch ms the app last refreshed the record (each fleet poll, ~3s). */
  ts: number;
  /** Whether a client is attached to the app (hosted: probed; plain: true). */
  attached: boolean;
  /** The session the app's Terminal tab mirrors ("" on Home with no context). */
  session: string;
  /** Pane ids VISIBLE on the app's screen right now — the mirrored window's
   *  panes while the Terminal tab is active, [] on Files/Diff/Home. */
  panes: string[];
}

/** The tmux server option carrying the app's JSON {@link AppFocus} record. */
export const APP_FOCUS_OPTION = "@tmux_ide_app_focus";
/** Ignore a focus record older than this — covers an app that died without
 *  cleanup (the app refreshes every ~3s fleet poll). */
export const APP_FOCUS_STALE_MS = 15_000;

/** PURE — serialize an {@link AppFocus} for the option value. */
export function buildAppFocusValue(focus: AppFocus): string {
  return JSON.stringify(focus);
}

/** PURE — parse a raw option value into a live {@link AppFocus}, or null for
 *  anything missing, malformed, or STALE (`ts` older than
 *  {@link APP_FOCUS_STALE_MS} relative to `nowMs`). Never throws. */
export function parseAppFocus(raw: string | null | undefined, nowMs: number): AppFocus | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    if (!o || typeof o !== "object") return null;
    const ts = typeof o.ts === "number" ? o.ts : null;
    if (ts === null || nowMs - ts > APP_FOCUS_STALE_MS) return null;
    return {
      ts,
      attached: o.attached === true,
      session: typeof o.session === "string" ? o.session : "",
      panes: Array.isArray(o.panes)
        ? o.panes.filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** io — read the app's focus record off the live tmux server (null when unset,
 *  malformed, or stale). Never throws. */
export function readAppFocus(nowMs: number = Date.now()): AppFocus | null {
  try {
    const raw = runTmux(["show-option", "-s", "-v", APP_FOCUS_OPTION]).toString().trim();
    return parseAppFocus(raw, nowMs);
  } catch {
    // option never set (unset server user-options error out) — no app around
    return null;
  }
}

/**
 * io — flash each toast on its client's status line (`-d 3000` = 3s; needs tmux
 * ≥3.2). Best-effort per toast: a gone client / failed call just drops that one.
 */
export function sendToasts(toasts: ToastTarget[]): void {
  for (const { client, message } of toasts) {
    try {
      runTmux(["display-message", "-c", client, "-d", "3000", message]);
    } catch {
      // client vanished or display failed — never fatal
    }
  }
}

/** io — whether `terminal-notifier` is on PATH (enables click-through banners). */
export function hasTerminalNotifier(): boolean {
  try {
    execFileSync("which", ["terminal-notifier"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** PURE — single-quote a string for safe interpolation into a `/bin/sh -c` command. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The session option a banner click stamps on the hosted app: "open THIS
 *  session when you next look". The app consumes it on its fleet poll. */
export const APP_JUMP_OPTION = "@tmux_ide_app_jump";

/**
 * PURE — the shell command a banner click runs (M25.1 click-to-jump v2).
 * When the hosted app exists, the click routes THROUGH the cockpit: stamp
 * {@link APP_JUMP_OPTION} on the host session (the running app consumes it and
 * opens that workspace — so even a DETACHED cockpit shows the right session on
 * the next attach), then switch the user's most-recent client to the cockpit.
 * Without a hosted app, fall back to switching the client straight to the
 * session. (`switch-client` without `-c` targets the last-active client — the
 * best we can do without knowing which terminal the click came from; with no
 * client attached at all it fails silently, and the jump stamp still lands.)
 *
 * NOTE the target spellings: has-session/switch-client take the `=` exact-match
 * prefix, but set-option REJECTS it ("no such session", measured on 3.7b — see
 * {@link ../mirror/hosted.ts hostSetupArgvs}), so the stamp uses the plain name.
 */
export function notifierExecuteCommand(session: string): string {
  const target = shellSingleQuote(session);
  const host = shellSingleQuote(`=${APP_HOST_SESSION}`);
  return (
    `if tmux has-session -t ${host} 2>/dev/null; then ` +
    `tmux set-option -t ${shellSingleQuote(APP_HOST_SESSION)} ${APP_JUMP_OPTION} ${target}; ` +
    `tmux switch-client -t ${host}; ` +
    `else tmux switch-client -t ${target}; fi`
  );
}

/**
 * PURE — the `terminal-notifier` argv for a click-through banner: clicking it
 * runs {@link notifierExecuteCommand}, which jumps the user's most-recent
 * client to the hosted cockpit (selecting the session that needs them) when
 * one exists, else straight to the session.
 */
export function terminalNotifierArgs(n: SystemNotification): string[] {
  return [
    "-title",
    "tmux-ide",
    "-message",
    n.message,
    "-execute",
    notifierExecuteCommand(n.session),
  ];
}

/**
 * io — fire a macOS notification. macOS-only (guarded), best-effort. When
 * `terminal-notifier` is available we use it for a CLICK-THROUGH banner
 * ({@link terminalNotifierArgs}) that focuses the session on click; otherwise we
 * fall back to `osascript`, whose `display notification` has NO click action —
 * so on a stock machine the banner informs but can't be clicked to jump.
 */
export function sendSystemNotification(n: SystemNotification): void {
  if (process.platform !== "darwin") return;
  try {
    if (hasTerminalNotifier()) {
      execFileSync("terminal-notifier", terminalNotifierArgs(n), { stdio: "ignore" });
      return;
    }
    const escaped = n.message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    execFileSync("osascript", ["-e", `display notification "${escaped}" with title "tmux-ide"`], {
      stdio: "ignore",
    });
  } catch {
    // osascript / terminal-notifier missing or notification blocked — never fatal
  }
}

/** A "quiet hours" window — banners are suppressed while the wall clock is inside it. */
export interface QuietHours {
  /** Local `HH:MM` the window opens (e.g. `22:00`). */
  start: string;
  /** Local `HH:MM` the window closes (e.g. `08:00`). */
  end: string;
}

/** User notification preferences. */
export interface NotificationPrefs {
  /** Master switch — false silences every channel. */
  enabled: boolean;
  /** In-terminal status-line toasts. */
  toast: boolean;
  /** macOS system banners. */
  macos: boolean;
  /** Ping when an agent goes `blocked`. */
  onBlocked: boolean;
  /** Ping when an agent goes `done`. */
  onDone: boolean;
  /** Optional local-time window that suppresses macOS banners (events still record). */
  quietHours: QuietHours | null;
}

/** Defaults: enabled, tmux toasts on, macOS banners off, both states pinged, no quiet window. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  toast: true,
  macos: false,
  onBlocked: true,
  onDone: true,
  quietHours: null,
};

/** A plain object, or `{}` for anything that isn't one (arrays included). */
function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** A boolean, else the default. */
function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** PURE — parse `HH:MM` to minutes-since-midnight, or null when malformed / out of range. */
export function parseHHMM(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * PURE — is `now` (local time) inside the quiet window? Handles a window that
 * WRAPS midnight (`22:00`–`08:00`). A null window, or a malformed / zero-width
 * (`start === end`) one, is never quiet.
 */
export function inQuietHours(now: Date, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  const start = parseHHMM(quiet.start);
  const end = parseHHMM(quiet.end);
  if (start === null || end === null || start === end) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return start < end ? nowMin >= start && nowMin < end : nowMin >= start || nowMin < end;
}

/** PURE — parse a `{ start, end }` quiet-hours block, or null when absent / malformed. */
function parseQuietHours(value: unknown): QuietHours | null {
  const o = asObject(value);
  const start = typeof o.start === "string" ? o.start : null;
  const end = typeof o.end === "string" ? o.end : null;
  if (start === null || end === null) return null;
  if (parseHHMM(start) === null || parseHHMM(end) === null) return null;
  return { start, end };
}

/**
 * PURE — resolve full {@link NotificationPrefs} from a parsed config object.
 *
 * `toast`/`macos` delegate to the shared {@link parseAppConfig} (so those two
 * can't drift from the rest of the config); the polish-era fields
 * (`enabled`/`onBlocked`/`onDone`/`quietHours`) are read straight off the raw
 * `notifications` block here — `parseAppConfig` doesn't model them, so reading
 * them locally keeps this change inside the chrome layer. Anything missing or
 * mistyped falls back to {@link DEFAULT_NOTIFICATION_PREFS}.
 */
export function parseNotificationPrefs(rawConfig: unknown): NotificationPrefs {
  const base = parseAppConfig(rawConfig).notifications;
  const n = asObject(asObject(rawConfig).notifications);
  return {
    enabled: pickBool(n.enabled, DEFAULT_NOTIFICATION_PREFS.enabled),
    toast: base.toast,
    macos: base.macos,
    onBlocked: pickBool(n.onBlocked, DEFAULT_NOTIFICATION_PREFS.onBlocked),
    onDone: pickBool(n.onDone, DEFAULT_NOTIFICATION_PREFS.onDone),
    quietHours: parseQuietHours(n.quietHours),
  };
}

/** PURE — the `TMUX_IDE_NOTIFY=0` kill-switch: disables everything. */
export function applyKillSwitch(
  prefs: NotificationPrefs,
  envValue: string | undefined,
): NotificationPrefs {
  return envValue === "0" ? { ...prefs, enabled: false, toast: false, macos: false } : prefs;
}

/** Absolute path to the shared config (honors `TMUX_IDE_CONFIG`). */
export function notifyConfigPath(): string {
  return appConfigPath();
}

/** io — read + JSON-parse the raw config file; undefined when missing / malformed. */
function readRawConfig(): unknown {
  const path = appConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * io — resolve effective prefs from the shared app config (defaults for a
 * missing/invalid file), then apply the `TMUX_IDE_NOTIFY=0` kill-switch. Reads
 * fresh so the env kill-switch and config edits are honored each call.
 */
export function readNotificationPrefs(): NotificationPrefs {
  return applyKillSwitch(parseNotificationPrefs(readRawConfig()), process.env.TMUX_IDE_NOTIFY);
}
