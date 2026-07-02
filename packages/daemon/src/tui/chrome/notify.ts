/**
 * The "who needs me" loop — turn fleet transitions into user-facing pings.
 *
 * The chrome {@link ./updater.ts updater} already sees every session's state
 * transition each tick (via {@link ./events.ts diffFleet}). Watching the status
 * bar for a `blocked`/`done` flip is a chore, so this module fans those two
 * signals out to the human: a tmux toast on each attached client
 * (`display-message -c`), and optionally a macOS notification.
 *
 * Split as usual: {@link decideNotifications} + {@link notificationPrefs} +
 * {@link applyKillSwitch} + {@link parseClients} are PURE (unit-tested without a
 * live tmux / filesystem); {@link sendToasts}, {@link sendSystemNotification},
 * {@link listAttachedClients} and {@link readNotificationPrefs} are the thin io
 * wrappers. Every io path is best-effort — a failed ping must never break the
 * updater loop.
 */
import { execFileSync } from "node:child_process";
import { runTmux } from "@tmux-ide/tmux-bridge";
import { appConfigPath, loadAppConfig, parseAppConfig } from "../../lib/app-config.ts";
import type { AgentStatus } from "../detect/classify.ts";

/** A fleet transition this tick — the shape {@link ./events.ts diffFleet} emits. */
export interface NotifyEvent {
  session: string;
  from: AgentStatus | null;
  to: AgentStatus;
}

/** An attached tmux client and the session it's currently viewing. */
export interface AttachedClient {
  client: string;
  session: string;
}

/** A toast destined for one client's status line. */
export interface ToastTarget {
  client: string;
  message: string;
}

/** A macOS-notification payload (title is fixed by {@link sendSystemNotification}). */
export interface SystemNotification {
  message: string;
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
/** Don't re-ping the same session+state more than once inside this window. */
export const NOTIFY_DEBOUNCE_MS = 30_000;

/** PURE — the human-readable ping text for a notifiable state. */
function notifyMessage(session: string, to: AgentStatus): string {
  return to === "blocked" ? `⚠ ${session} needs you (blocked)` : `✓ ${session} finished (done)`;
}

/**
 * PURE — decide who to ping from this tick's transitions.
 *
 * Rules:
 *   - only `blocked` / `done` transitions qualify (working/idle etc. are noise);
 *   - DEBOUNCE: skip a session+state that fired within {@link NOTIFY_DEBOUNCE_MS};
 *   - SUPPRESS the toast for any client already viewing that session (they can
 *     see the bar flip themselves) — other clients still get toasted;
 *   - a `system` entry is produced per qualifying, non-debounced event regardless
 *     of clients (so the macOS path fires even with nothing attached — the
 *     caller gates it on prefs).
 *
 * Returns the toasts/system to dispatch plus `nextLastNotified` (a copy of the
 * input with fresh timestamps for the events we acted on) to thread onward.
 */
export function decideNotifications(
  events: NotifyEvent[],
  clients: AttachedClient[],
  lastNotified: Map<string, number>,
  nowMs: number,
): NotifyDecision {
  const nextLastNotified = new Map(lastNotified);
  const toasts: ToastTarget[] = [];
  const system: SystemNotification[] = [];
  for (const ev of events) {
    if (!NOTIFY_STATES.has(ev.to)) continue;
    const key = `${ev.session}:${ev.to}`;
    const last = nextLastNotified.get(key);
    if (last !== undefined && nowMs - last < NOTIFY_DEBOUNCE_MS) continue;
    nextLastNotified.set(key, nowMs);
    const message = notifyMessage(ev.session, ev.to);
    for (const c of clients) {
      if (c.session === ev.session) continue; // they're already looking at it
      toasts.push({ client: c.client, message });
    }
    system.push({ message });
  }
  return { toasts, system, nextLastNotified };
}

/** PURE — parse `list-clients -F '#{client_name}\t#{session_name}'` output. */
export function parseClients(lines: string[]): AttachedClient[] {
  const out: AttachedClient[] = [];
  for (const line of lines) {
    const [client = "", session = ""] = line.split("\t");
    if (client && session) out.push({ client, session });
  }
  return out;
}

/** io — enumerate attached clients from the live tmux server. Never throws. */
export function listAttachedClients(): AttachedClient[] {
  try {
    const raw = runTmux(["list-clients", "-F", "#{client_name}\t#{session_name}"])
      .toString()
      .trim();
    return raw ? parseClients(raw.split("\n")) : [];
  } catch {
    return [];
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

/**
 * io — fire a macOS notification via `osascript`. macOS-only (guarded), and
 * quotes/backslashes are escaped for the AppleScript string literal. Best-effort.
 */
export function sendSystemNotification(message: string): void {
  if (process.platform !== "darwin") return;
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  try {
    execFileSync("osascript", ["-e", `display notification "${escaped}" with title "tmux-ide"`], {
      stdio: "ignore",
    });
  } catch {
    // osascript missing / notification blocked — never fatal
  }
}

/** User notification preferences (minimal, pre-M14). */
export interface NotificationPrefs {
  toast: boolean;
  macos: boolean;
}

/** Defaults: tmux toasts on, macOS notifications off. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = { toast: true, macos: false };

/**
 * PURE — read `{ notifications: { toast, macos } }` out of a parsed config,
 * falling back to {@link DEFAULT_NOTIFICATION_PREFS} for anything missing or of
 * the wrong type. Delegates to the shared {@link parseAppConfig} so notification
 * parsing can't drift from the rest of the config.
 */
export function notificationPrefs(parsedConfig: unknown): NotificationPrefs {
  return parseAppConfig(parsedConfig).notifications;
}

/** PURE — the `TMUX_IDE_NOTIFY=0` kill-switch: disables both channels. */
export function applyKillSwitch(
  prefs: NotificationPrefs,
  envValue: string | undefined,
): NotificationPrefs {
  return envValue === "0" ? { toast: false, macos: false } : prefs;
}

/** Absolute path to the shared config (honors `TMUX_IDE_CONFIG`). */
export function notifyConfigPath(): string {
  return appConfigPath();
}

/**
 * io — resolve effective prefs from the shared app config (defaults for a
 * missing/invalid file), then apply the `TMUX_IDE_NOTIFY=0` kill-switch. Reads
 * fresh so the env kill-switch is honored each call.
 */
export function readNotificationPrefs(): NotificationPrefs {
  return applyKillSwitch(loadAppConfig().notifications, process.env.TMUX_IDE_NOTIFY);
}
