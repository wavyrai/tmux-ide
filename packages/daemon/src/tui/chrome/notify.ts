/**
 * The "who needs me" loop — turn fleet transitions into user-facing pings.
 *
 * The chrome {@link ./updater.ts updater} already sees every session's state
 * transition each tick (via {@link ./events.ts diffFleet}). Watching the status
 * bar for a `blocked`/`done` flip is a chore, so this module fans those two
 * signals out to the human: a tmux toast on each attached client
 * (`display-message -c`), and optionally a macOS notification.
 *
 * Since M25.2 the fan-out spans FIVE channels: the in-app toast, the system
 * banner (native macOS helper, Linux `notify-send`), the
 * terminal-native OSC 9/99 escape written straight to each eligible client's
 * tty, a ping sound, and a BEL on blocked. The OS-level channels (everything
 * but the toast) are quiet-hours gated and delay/re-verified by the updater.
 *
 * Split as usual: {@link decideNotifications} + {@link notifyMessage} +
 * {@link enabledStates} + {@link inQuietHours} + {@link parseNotificationPrefs}
 * + {@link applyKillSwitch} + {@link parseClients} + {@link terminalNotifierArgs}
 * + {@link terminalNotifyEscape} + {@link decideTtyWrites} + {@link notifySendArgs}
 * + {@link soundEligible} + {@link soundArgv} are PURE (unit-tested without a
 * live tmux / filesystem); {@link sendToasts}, {@link sendSystemNotification},
 * {@link resolveNativeMacosNotifierPath}, {@link listAttachedClients}, {@link writeTtys},
 * {@link playPingSound} and {@link readNotificationPrefs} are the thin io
 * wrappers. Every io path is best-effort — a failed ping must never break the
 * updater loop.
 */
import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { runTmux } from "@tmux-ide/tmux-bridge";
import { appConfigPath, parseAppConfig, type NotificationSound } from "../../lib/app-config.ts";
import { APP_HOST_SESSION } from "../mirror/hosted.ts";
import { tmuxPassthrough } from "../mirror/selection.ts";
import type { AgentStatus } from "../detect/classify.ts";
// The pure prefs shapes + parsing live in a pure module (notify-prefs.ts) so
// pure surfaces (settings-model) can import them without dragging this file's
// node/tmux io behind them. Re-exported here: existing importers are unchanged.
import { parseHHMM, type NotificationPrefs, type QuietHours } from "./notify-prefs.ts";
export { parseHHMM };
export type { NotificationPrefs, QuietHours };

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
 *  degrades to session granularity for that client). `tty`/`termname` (M25.2)
 *  are what the terminal-escape channel needs — the device to write and which
 *  escape form the terminal behind it understands; null/absent means the
 *  caller couldn't resolve them and that client just gets no escapes. */
export interface AttachedClient {
  client: string;
  session: string;
  windowIndex?: number | null;
  /** `#{client_tty}` — the device the escape/BEL bytes are written to. */
  tty?: string | null;
  /** `#{client_termname}` — picks OSC 99 (kitty) / passthrough (nested tmux). */
  termname?: string | null;
}

/** A toast destined for one client's status line. */
export interface ToastTarget {
  client: string;
  message: string;
}

/**
 * One OS-level ping. `session` rides along so the click-through path
 * ({@link terminalNotifierArgs}) can focus the right session on click; since
 * M25.2 the payload also carries the transition's `state` (urgency + sound
 * routing) and its pane identity (`paneId`/`windowIndex`) so the delayed
 * re-verify can confirm the pane is STILL in that state and the terminal-escape
 * channel can re-apply per-client suppression at fire time.
 */
export interface SystemNotification {
  message: string;
  session: string;
  /** The state that was pinged — must still hold when a delayed ping fires. */
  state: AgentStatus;
  /** The pane behind the ping (null: session-granular caller — unverifiable). */
  paneId: string | null;
  /** The pane's window — per-client escape suppression wants it. */
  windowIndex: number | null;
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
    system.push({
      message,
      session: ev.session,
      state: ev.to,
      paneId: ev.paneId ?? null,
      windowIndex: ev.windowIndex ?? null,
    });
  }
  return { toasts, system, nextLastNotified };
}

/** PURE — parse `list-clients -F '#{client_name}\t#{session_name}\t#{window_index}
 *  \t#{client_tty}\t#{client_termname}'` output (fields three-plus are optional;
 *  missing/non-numeric window parses as null so shorter-format callers degrade
 *  gracefully, and a missing tty/termname just disables that client's escapes). */
export function parseClients(lines: string[]): AttachedClient[] {
  const out: AttachedClient[] = [];
  for (const line of lines) {
    const [client = "", session = "", win = "", tty = "", termname = ""] = line.split("\t");
    if (!client || !session) continue;
    const n = Number.parseInt(win, 10);
    out.push({
      client,
      session,
      windowIndex: Number.isInteger(n) ? n : null,
      tty: tty || null,
      termname: termname || null,
    });
  }
  return out;
}

/** io — enumerate attached clients (+ their current window, tty, termname) from
 *  the live tmux server. Never throws. */
export function listAttachedClients(): AttachedClient[] {
  try {
    const raw = runTmux([
      "list-clients",
      "-F",
      "#{client_name}\t#{session_name}\t#{window_index}\t#{client_tty}\t#{client_termname}",
    ])
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

// ---------------------------------------------------------------------------
// The terminal-escape + sound channels (M25.2)
// ---------------------------------------------------------------------------

/**
 * PURE — the OSC 9 desktop-notification escape (iTerm2 / Ghostty / WezTerm and
 * friends; BEL-terminated). Terminals without support ignore it entirely.
 */
export function osc9Notification(text: string): string {
  return `\x1b]9;${text}\x07`;
}

/**
 * PURE — kitty's richer OSC 99 form (ST-terminated; the empty-metadata payload
 * is the notification title). Blocked pings carry `u=2` (critical urgency) —
 * kitty ignores metadata keys it doesn't know, so this is safe on older kitties.
 */
export function osc99Notification(text: string, urgent: boolean): string {
  return `\x1b]99;${urgent ? "u=2" : ""};${text}\x1b\\`;
}

/**
 * PURE — the escape a client's terminal actually understands, by
 * `#{client_termname}` (conservative, MEASURED — see {@link writeClientTty}):
 *
 *   - `*kitty*` → OSC 99 (kitty ignores OSC 9's text form);
 *   - `tmux-*` / `screen*` → the OSC 9 wrapped in the tmux passthrough envelope
 *     ({@link tmuxPassthrough}): that termname means the client is itself INSIDE
 *     another tmux/screen, so our bytes land as pane OUTPUT of the outer mux and
 *     only the envelope (plus the outer mux's `allow-passthrough`, which is the
 *     user's to set — we can't reach a foreign server) carries them further;
 *   - anything else → raw OSC 9. A direct client-tty write BYPASSES our own
 *     tmux server entirely (measured: bytes arrive on the tty stream verbatim),
 *     so for a directly-attached terminal the RAW escape is the correct form —
 *     an envelope there would be ignored by the terminal, not unwrapped.
 */
export function terminalNotifyEscape(
  termname: string | null | undefined,
  text: string,
  urgent: boolean,
): string {
  const t = termname ?? "";
  if (t.includes("kitty")) return osc99Notification(text, urgent);
  if (t.startsWith("tmux") || t.startsWith("screen")) {
    return tmuxPassthrough(osc9Notification(text));
  }
  return osc9Notification(text);
}

/** One pending write to a client's tty device. */
export interface TtyWrite {
  tty: string;
  data: string;
}

/** PURE — should the sound channel fire for this state under this pref? */
export function soundEligible(state: AgentStatus, sound: NotificationSound): boolean {
  if (sound === "none") return false;
  if (sound === "all") return state === "blocked" || state === "done";
  return state === "blocked";
}

/** BEL rings the terminal's attention marker — `blocked` only, and it rides the
 *  sound pref (a user who turned sound off asked for silence). */
function belEligible(state: AgentStatus, sound: NotificationSound): boolean {
  return state === "blocked" && sound !== "none";
}

/**
 * PURE — the tty writes for one OS-level ping: for every attached client that
 * is NOT already looking at the transition (the SAME suppression rule as toasts,
 * {@link suppressToastFor}) and whose tty we know, the terminal-notification
 * escape (when `prefs.terminal`) plus a BEL on blocked (when the sound pref
 * allows). Clients contribute nothing when both channels are off for them.
 */
export function decideTtyWrites(
  n: SystemNotification,
  clients: AttachedClient[],
  prefs: Pick<NotificationPrefs, "terminal" | "sound">,
): TtyWrite[] {
  const asEvent: NotifyEvent = {
    session: n.session,
    from: null,
    to: n.state,
    paneId: n.paneId,
    windowIndex: n.windowIndex,
  };
  const bel = belEligible(n.state, prefs.sound) ? "\x07" : "";
  const out: TtyWrite[] = [];
  for (const c of clients) {
    if (!c.tty) continue;
    if (suppressToastFor(c, asEvent)) continue;
    const escape = prefs.terminal
      ? terminalNotifyEscape(c.termname, n.message, n.state === "blocked")
      : "";
    const data = escape + bel;
    if (data) out.push({ tty: c.tty, data });
  }
  return out;
}

/**
 * io — write escape/BEL bytes straight to a client's tty device. This is the
 * delivery mechanism (MEASURED against a recorded client tty): the write goes
 * to the pty the tmux client sits on, so the bytes reach the outer terminal
 * verbatim without our tmux server ever seeing them — no `allow-passthrough`
 * needed on this server, no `run-shell`/`display-message` indirection.
 * Non-blocking open so a flow-stopped tty (^S) can never stall the updater
 * tick; any failure just drops that client's ping.
 */
export function writeClientTty(write: TtyWrite): void {
  let fd: number | null = null;
  try {
    fd = openSync(write.tty, fsConstants.O_WRONLY | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK);
    writeSync(fd, write.data);
  } catch {
    // client gone / tty unwritable — never fatal
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
    }
  }
}

/** io — dispatch a batch of tty writes, each best-effort. */
export function writeTtys(writes: TtyWrite[]): void {
  for (const w of writes) writeClientTty(w);
}

/** The calm default ping sounds — a short macOS system chime and the standard
 *  freedesktop completion sound (skipped silently when absent). */
export const DARWIN_SOUND_FILE = "/System/Library/Sounds/Tink.aiff";
export const LINUX_SOUND_FILE = "/usr/share/sounds/freedesktop/stereo/complete.oga";

/** PURE — the sound-player argv for a platform, or null when it has none. */
export function soundArgv(platform: NodeJS.Platform): string[] | null {
  if (platform === "darwin") return ["afplay", DARWIN_SOUND_FILE];
  if (platform === "linux") return ["paplay", LINUX_SOUND_FILE];
  return null;
}

/**
 * io — play the platform ping sound, fire-and-forget (a sync wait would stall
 * the updater tick for the clip's duration). Missing sound file or player →
 * silent skip.
 */
export function playPingSound(platform: NodeJS.Platform = process.platform): void {
  const argv = soundArgv(platform);
  if (!argv || !existsSync(argv[1]!)) return;
  try {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // no player — never fatal
  }
}

/** io — whether `terminal-notifier` is on PATH (enables click-through banners). */
export function hasTerminalNotifier(): boolean {
  return hasBinary("terminal-notifier");
}

/** io — resolve a binary to the absolute path a GUI-launched helper can retain. */
function binaryPath(name: string): string | null {
  try {
    const path = execFileSync("which", [name], { encoding: "utf8" }).trim();
    return path.startsWith("/") ? path : null;
  } catch {
    return null;
  }
}

/** io — whether a binary resolves on PATH. */
function hasBinary(name: string): boolean {
  return binaryPath(name) !== null;
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

/** The native sender injected into the npm/Homebrew payload at release. */
export const NATIVE_MACOS_NOTIFIER_RELATIVE_PATH =
  "packages/daemon/dist/native/TmuxIdeNotifier.app";
const NATIVE_MACOS_NOTIFIER_EXECUTABLE = "Contents/MacOS/tmux-ide-notifier";

export interface NativeMacosNotifierPathIo {
  /** The real node CLI path forwarded to compiled TUI surfaces. */
  cliPath?: string | null;
  /** Injectable module path keeps the ancestor walk deterministic in tests. */
  modulePath?: string;
  exists?: (path: string) => boolean;
}

/**
 * io — find the packaged native notifier from either runtime shape:
 *
 * - the bundled CLI lives at `bin/cli.js`, one level below the package root;
 * - checkout source lives below `packages/daemon/src/…`;
 * - the standalone Bun TUI has a virtual module URL, but the CLI forwards its
 *   real path through `TMUX_IDE_CLI`.
 *
 * Walking ancestors handles all three without baking an install prefix into
 * the binary. A missing helper is a silent null so older installs can fall back.
 */
export function resolveNativeMacosNotifierPath(io: NativeMacosNotifierPathIo = {}): string | null {
  const exists = io.exists ?? existsSync;
  const cliPath = io.cliPath === undefined ? process.env.TMUX_IDE_CLI : io.cliPath;
  const modulePath = io.modulePath ?? fileURLToPath(import.meta.url);
  const anchors = [cliPath, modulePath]
    .filter((path): path is string => Boolean(path))
    .map((path) => dirname(resolve(path)));
  const visited = new Set<string>();

  for (const anchor of anchors) {
    let directory = anchor;
    while (!visited.has(directory)) {
      visited.add(directory);
      const candidate = resolve(directory, NATIVE_MACOS_NOTIFIER_RELATIVE_PATH);
      if (exists(resolve(candidate, NATIVE_MACOS_NOTIFIER_EXECUTABLE))) return candidate;
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  return null;
}

/** PURE — recover tmux's exact socket from `$TMUX` (`path,server-pid,pane-id`). */
export function parseTmuxSocketPath(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  // Match the two numeric TMUX metadata fields from the RIGHT: socket paths
  // themselves are allowed to contain commas.
  const path = (/^(.*),\d+,\d+$/.exec(normalized)?.[1] ?? normalized).trim();
  return path.startsWith("/") ? path : null;
}

/**
 * PURE — launch the branded LSUIElement app through LaunchServices. The helper
 * stores structured tmux coordinates in the system notification payload so a
 * later click can jump without inheriting a shell, PATH, or TMUX environment.
 */
export function nativeMacosNotifierArgs(
  appPath: string,
  n: SystemNotification,
  tmuxPath: string | null,
  socketPath: string | null,
): string[] {
  const args = [
    "-g",
    "-n",
    appPath,
    "--args",
    "--title",
    "tmux-ide",
    "--message",
    n.message,
    "--session",
    n.session,
    "--host-session",
    APP_HOST_SESSION,
    "--jump-option",
    APP_JUMP_OPTION,
  ];
  if (tmuxPath) args.push("--tmux-path", tmuxPath);
  if (socketPath) args.push("--socket-path", socketPath);
  return args;
}

/**
 * PURE — the legacy `terminal-notifier` argv retained for older installations
 * whose package predates the native helper.
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
 * PURE — the `notify-send` argv for a Linux desktop banner: app-named, blocked
 * pings marked critical so they persist until dismissed (that's the "an agent
 * is stuck waiting on you" contract).
 */
export function notifySendArgs(n: SystemNotification): string[] {
  const args = ["--app-name=tmux-ide"];
  if (n.state === "blocked") args.push("--urgency=critical");
  args.push("tmux-ide", n.message);
  return args;
}

/** The io {@link sendSystemNotification} needs — injectable so the per-platform
 *  routing is unit-tested without firing real banners. */
export interface SystemNotifyIo {
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exec?: (cmd: string, args: string[]) => void;
  hasBinary?: (name: string) => boolean;
  /** undefined auto-resolves the shipped bundle; null tests/old installs skip it. */
  nativeNotifierPath?: string | null;
  /** Absolute executable retained for a click relaunch with no terminal PATH. */
  tmuxPath?: string | null;
}

/**
 * io — fire a system notification, best-effort. macOS: the bundled native app
 * first (branded, appearance-aware, click-through), then `terminal-notifier`
 * for an older install, then `osascript` as the last unbranded fallback. Linux:
 * under a
 * desktop session (DISPLAY / WAYLAND_DISPLAY) with `notify-send` on PATH, the
 * same title/body (+ critical urgency for blocked — {@link notifySendArgs});
 * anything missing → silent skip. Other platforms: no-op.
 */
export function sendSystemNotification(n: SystemNotification, io: SystemNotifyIo = {}): void {
  const platform = io.platform ?? process.platform;
  const exec =
    io.exec ?? ((cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: "ignore" }));
  const has = io.hasBinary ?? hasBinary;
  try {
    if (platform === "darwin") {
      const appPath =
        io.nativeNotifierPath === undefined
          ? resolveNativeMacosNotifierPath()
          : io.nativeNotifierPath;
      if (appPath) {
        const env = io.env ?? process.env;
        const tmuxPath = io.tmuxPath === undefined ? binaryPath("tmux") : io.tmuxPath;
        try {
          exec(
            "/usr/bin/open",
            nativeMacosNotifierArgs(appPath, n, tmuxPath, parseTmuxSocketPath(env.TMUX)),
          );
          return;
        } catch {
          // Corrupt/blocked helper: retain the two compatibility fallbacks.
        }
      }
      if (has("terminal-notifier")) {
        exec("terminal-notifier", terminalNotifierArgs(n));
        return;
      }
      const escaped = n.message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      exec("osascript", ["-e", `display notification "${escaped}" with title "tmux-ide"`]);
      return;
    }
    if (platform === "linux") {
      const env = io.env ?? process.env;
      if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return; // headless — nowhere to banner
      if (!has("notify-send")) return;
      exec("notify-send", notifySendArgs(n));
    }
  } catch {
    // notifier missing or notification blocked — never fatal
  }
}

/** A "quiet hours" window — banners are suppressed while the wall clock is inside it. */
/** User notification preferences. */

/** Defaults: enabled, tmux toasts + terminal escapes on, system banners off,
 *  sound on blocked, a 2s re-verify delay, both states pinged, no quiet window. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  enabled: true,
  toast: true,
  macos: false,
  terminal: true,
  delaySeconds: 2,
  sound: "blocked",
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
    terminal: base.terminal,
    delaySeconds: base.delaySeconds,
    sound: base.sound,
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
  return envValue === "0"
    ? { ...prefs, enabled: false, toast: false, macos: false, terminal: false, sound: "none" }
    : prefs;
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
