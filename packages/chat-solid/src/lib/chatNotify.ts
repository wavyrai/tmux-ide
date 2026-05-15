/**
 * Background-completion notifier.
 *
 * When an assistant turn finishes while the dashboard window is in
 * the background, optionally chime and/or raise an OS banner. Both
 * channels are opt-in via the dashboard settings store, which
 * persists to `localStorage["tmux-ide.settings.v1"]`. chat-solid is a
 * standalone library, so we read that key directly here rather than
 * importing the dashboard's settings module (same pattern as
 * `composerDraftStore`'s direct localStorage access).
 *
 * The chime is a synthesized WebAudio blip — no bundled asset, no
 * autoplay-policy gesture needed (the user already interacted to send
 * the prompt that produced this turn).
 */

const SETTINGS_KEY = "tmux-ide.settings.v1";

interface NotificationPrefs {
  sound: boolean;
  desktopBanners: boolean;
}

const DEFAULT_PREFS: NotificationPrefs = { sound: true, desktopBanners: false };

function hasLocalStorage(): boolean {
  try {
    return typeof globalThis.localStorage !== "undefined";
  } catch {
    return false;
  }
}

function readPrefs(): NotificationPrefs {
  if (!hasLocalStorage()) return DEFAULT_PREFS;
  try {
    const raw = globalThis.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFS;
    const n = (parsed as { notification?: unknown }).notification;
    if (typeof n !== "object" || n === null) return DEFAULT_PREFS;
    const rec = n as Record<string, unknown>;
    return {
      sound: typeof rec.sound === "boolean" ? rec.sound : DEFAULT_PREFS.sound,
      desktopBanners:
        typeof rec.desktopBanners === "boolean" ? rec.desktopBanners : DEFAULT_PREFS.desktopBanners,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** True when the window can't be seen — hidden tab or unfocused. */
function windowIsBackgrounded(): boolean {
  if (typeof document === "undefined") return false;
  if (document.visibilityState === "hidden") return true;
  try {
    return typeof document.hasFocus === "function" && !document.hasFocus();
  } catch {
    return false;
  }
}

let audioCtx: AudioContext | null = null;

function playChime(): void {
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx ??= new Ctor();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.setValueAtTime(880, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.34);
  } catch {
    /* WebAudio unavailable / blocked — skip silently */
  }
}

function showBanner(): void {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const banner = new Notification("Assistant finished", {
      body: "Your reply is ready.",
      tag: "chat-solid-turn-complete",
      silent: true,
    });
    banner.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      banner.close();
    };
  } catch {
    /* Notification construction can throw on some platforms — skip */
  }
}

/**
 * Fire the configured background-completion alerts. No-op when the
 * window is focused/visible so foreground replies stay silent.
 */
export function notifyAssistantTurnComplete(): void {
  if (!windowIsBackgrounded()) return;
  const prefs = readPrefs();
  if (prefs.sound) playChime();
  if (prefs.desktopBanners) showBanner();
}
