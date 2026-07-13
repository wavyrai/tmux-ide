/**
 * Notification PREFERENCES — the pure shapes and parsing, hoisted out of
 * {@link ./notify.ts} (which is io: node:child_process, node:fs, tmux).
 *
 * Why the split: `settings-model.ts` is pure and only needs `NotificationPrefs`
 * + `parseHHMM`, but importing them from notify.ts dragged the whole io graph in
 * behind them. That's invisible in the daemon (node has `process`), and it broke
 * the moment a pure surface was imported anywhere else — the web host loads
 * these same modules in a browser, where `process` does not exist.
 *
 * The rule this restores is the repo's own: pure core, thin io. Anything a pure
 * module needs belongs in a pure module.
 *
 * notify.ts re-exports these, so existing importers are untouched.
 */
import type { NotificationSound } from "../../lib/app-config.ts";

/** A local-time window, `HH:MM`–`HH:MM`. */
export interface QuietHours {
  /** Local `HH:MM` the window opens (e.g. `22:00`). */
  start: string;
  /** Local `HH:MM` the window closes (e.g. `08:00`). */
  end: string;
}

export interface NotificationPrefs {
  /** Master switch — false silences every channel. */
  enabled: boolean;
  /** In-terminal status-line toasts. */
  toast: boolean;
  /** System banners (native macOS helper, Linux `notify-send`). */
  macos: boolean;
  /** Terminal-native banners — OSC 9/99 escapes to eligible client ttys (M25.2). */
  terminal: boolean;
  /** Seconds the OS-level channels wait + re-verify before firing (0 = immediate). */
  delaySeconds: number;
  /** Sound channel — ping sound + BEL routing (M25.2). */
  sound: NotificationSound;
  /** Ping when an agent goes `blocked`. */
  onBlocked: boolean;
  /** Ping when an agent goes `done`. */
  onDone: boolean;
  /** Optional local-time window that suppresses every OS-LEVEL channel (banner,
   *  terminal escape, sound, BEL — since M25.2). In-app toasts and the event
   *  log stay on. */
  quietHours: QuietHours | null;
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
