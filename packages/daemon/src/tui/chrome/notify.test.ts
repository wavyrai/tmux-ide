/**
 * Unit tests for the pure parts of the notification loop — the decision engine
 * (state filtering, viewer suppression, debounce/flap guard), the message
 * format, the client parser, prefs resolution + kill-switch, quiet hours, and
 * the terminal-notifier click-through argv.
 */
import { describe, expect, it } from "vitest";
import {
  applyKillSwitch,
  decideNotifications,
  DEFAULT_NOTIFICATION_PREFS,
  enabledStates,
  inQuietHours,
  notifyMessage,
  NOTIFY_DEBOUNCE_MS,
  NOTIFY_MAX_LEN,
  parseHHMM,
  parseNotificationPrefs,
  parseClients,
  terminalNotifierArgs,
  type AttachedClient,
  type NotificationPrefs,
  type NotifyEvent,
} from "./notify.ts";

function ev(session: string, to: NotifyEvent["to"], extra: Partial<NotifyEvent> = {}): NotifyEvent {
  return { session, from: "working", to, ...extra };
}

describe("notifyMessage", () => {
  it("formats agent + location + state, e.g. 'claude blocked · myproj:1.2 — needs input'", () => {
    expect(
      notifyMessage({
        session: "myproj",
        from: "working",
        to: "blocked",
        agent: "claude",
        location: "myproj:1.2",
      }),
    ).toBe("claude blocked · myproj:1.2 — needs input");
    expect(
      notifyMessage({
        session: "myproj",
        from: "working",
        to: "done",
        agent: "codex",
        location: "myproj:0.1",
      }),
    ).toBe("codex done · myproj:0.1 — finished");
  });

  it("falls back to a generic agent label and the bare session name", () => {
    expect(notifyMessage({ session: "web", from: "working", to: "blocked" })).toBe(
      "agent blocked · web — needs input",
    );
  });

  it("clamps over-long text to the banner cap", () => {
    const msg = notifyMessage({
      session: "s",
      from: "working",
      to: "blocked",
      agent: "a".repeat(300),
      location: "loc",
    });
    expect(msg.length).toBe(NOTIFY_MAX_LEN);
    expect(msg.endsWith("…")).toBe(true);
  });
});

describe("enabledStates", () => {
  it("maps onBlocked/onDone to the notifiable state set", () => {
    const base = DEFAULT_NOTIFICATION_PREFS;
    expect([...enabledStates(base)].sort()).toEqual(["blocked", "done"]);
    expect([...enabledStates({ ...base, onDone: false })]).toEqual(["blocked"]);
    expect([...enabledStates({ ...base, onBlocked: false })]).toEqual(["done"]);
    expect([...enabledStates({ ...base, onBlocked: false, onDone: false })]).toEqual([]);
  });
});

describe("decideNotifications", () => {
  it("notifies only on blocked / done — working and idle are ignored", () => {
    const events = [
      ev("a", "blocked"),
      ev("b", "done"),
      ev("c", "working"),
      ev("d", "idle"),
      ev("e", "unknown"),
    ];
    const { toasts, system } = decideNotifications(events, [], new Map(), 0);
    // No clients → no toasts, but a system entry per qualifying event.
    expect(toasts).toEqual([]);
    expect(system).toEqual([
      { message: "agent blocked · a — needs input", session: "a" },
      { message: "agent done · b — finished", session: "b" },
    ]);
  });

  it("honors the passed-in `states` set (onBlocked/onDone gating)", () => {
    const events = [ev("a", "blocked"), ev("b", "done")];
    const { system } = decideNotifications(events, [], new Map(), 0, new Set(["blocked"]));
    expect(system).toEqual([{ message: "agent blocked · a — needs input", session: "a" }]);
  });

  it("uses the enriched agent/location in the toast text", () => {
    const clients: AttachedClient[] = [{ client: "/dev/ttys001", session: "other" }];
    const { toasts } = decideNotifications(
      [ev("web", "blocked", { agent: "claude", location: "web:1.2" })],
      clients,
      new Map(),
      0,
    );
    expect(toasts).toEqual([
      { client: "/dev/ttys001", message: "claude blocked · web:1.2 — needs input" },
    ]);
  });

  it("toasts every client EXCEPT the one viewing that session", () => {
    const clients: AttachedClient[] = [
      { client: "viewer", session: "web" }, // watching web — suppressed
      { client: "other", session: "api" }, // watching api — still toasted
    ];
    const { toasts, system } = decideNotifications([ev("web", "blocked")], clients, new Map(), 0);
    expect(toasts).toEqual([{ client: "other", message: "agent blocked · web — needs input" }]);
    // The system (macOS) entry is still produced regardless of viewers.
    expect(system).toEqual([{ message: "agent blocked · web — needs input", session: "web" }]);
  });

  it("suppresses toasts entirely when the only client is viewing the session, but keeps the system entry", () => {
    const clients: AttachedClient[] = [{ client: "viewer", session: "web" }];
    const { toasts, system } = decideNotifications([ev("web", "blocked")], clients, new Map(), 0);
    expect(toasts).toEqual([]);
    expect(system).toEqual([{ message: "agent blocked · web — needs input", session: "web" }]);
  });

  it("debounces the same session+state within the window and allows it after", () => {
    const clients: AttachedClient[] = [{ client: "c1", session: "other" }];
    const first = decideNotifications([ev("web", "blocked")], clients, new Map(), 1000);
    expect(first.toasts).toHaveLength(1);
    expect(first.nextLastNotified.get("web:blocked")).toBe(1000);

    // 20s later — still within the 30s window → skipped, map unchanged.
    const within = decideNotifications(
      [ev("web", "blocked")],
      clients,
      first.nextLastNotified,
      1000 + 20_000,
    );
    expect(within.toasts).toEqual([]);
    expect(within.system).toEqual([]);
    expect(within.nextLastNotified.get("web:blocked")).toBe(1000);

    // Past the window → fires again and records the new timestamp.
    const after = decideNotifications(
      [ev("web", "blocked")],
      clients,
      within.nextLastNotified,
      1000 + NOTIFY_DEBOUNCE_MS + 1,
    );
    expect(after.toasts).toHaveLength(1);
    expect(after.nextLastNotified.get("web:blocked")).toBe(1000 + NOTIFY_DEBOUNCE_MS + 1);
  });

  it("tames a flapping agent — repeated blocked flips inside the window notify once", () => {
    const clients: AttachedClient[] = [{ client: "c1", session: "other" }];
    let last = new Map<string, number>();
    let fired = 0;
    // working↔blocked bouncing every 5s for 25s — only the first blocked pings.
    for (const t of [0, 5_000, 10_000, 15_000, 20_000, 25_000]) {
      const d = decideNotifications([ev("web", "blocked")], clients, last, t);
      fired += d.toasts.length;
      last = d.nextLastNotified;
    }
    expect(fired).toBe(1);
  });

  it("debounces per session+state, so blocked then done for the same session both fire", () => {
    const clients: AttachedClient[] = [{ client: "c1", session: "other" }];
    const blocked = decideNotifications([ev("web", "blocked")], clients, new Map(), 0);
    const done = decideNotifications([ev("web", "done")], clients, blocked.nextLastNotified, 5000);
    expect(done.toasts).toEqual([{ client: "c1", message: "agent done · web — finished" }]);
    expect(done.nextLastNotified.get("web:blocked")).toBe(0);
    expect(done.nextLastNotified.get("web:done")).toBe(5000);
  });

  it("does not mutate the passed-in lastNotified map", () => {
    const clients: AttachedClient[] = [{ client: "c1", session: "other" }];
    const lastNotified = new Map<string, number>();
    decideNotifications([ev("web", "blocked")], clients, lastNotified, 0);
    expect(lastNotified.size).toBe(0);
  });
});

describe("parseClients", () => {
  it("parses client\\tsession lines and drops malformed ones", () => {
    expect(
      parseClients(["/dev/ttys000\tweb", "/dev/ttys001\tapi", "", "lonely", "\tdangling"]),
    ).toEqual([
      { client: "/dev/ttys000", session: "web" },
      { client: "/dev/ttys001", session: "api" },
    ]);
  });
});

describe("parseHHMM", () => {
  it("parses valid HH:MM to minutes-since-midnight", () => {
    expect(parseHHMM("00:00")).toBe(0);
    expect(parseHHMM("08:30")).toBe(510);
    expect(parseHHMM("23:59")).toBe(1439);
    expect(parseHHMM(" 22:00 ")).toBe(1320);
  });

  it("rejects malformed / out-of-range / non-string input", () => {
    for (const bad of ["24:00", "12:60", "9:00", "abc", "", "1200", 800, null, undefined]) {
      expect(parseHHMM(bad)).toBeNull();
    }
  });
});

describe("inQuietHours", () => {
  const at = (h: number, m = 0) => new Date(2026, 0, 1, h, m);

  it("is never quiet without a window", () => {
    expect(inQuietHours(at(3), null)).toBe(false);
  });

  it("handles a window that wraps midnight (22:00–08:00)", () => {
    const q = { start: "22:00", end: "08:00" };
    expect(inQuietHours(at(23), q)).toBe(true);
    expect(inQuietHours(at(2), q)).toBe(true);
    expect(inQuietHours(at(22, 0), q)).toBe(true); // inclusive start
    expect(inQuietHours(at(8, 0), q)).toBe(false); // exclusive end
    expect(inQuietHours(at(12), q)).toBe(false);
  });

  it("handles a same-day window (09:00–17:00)", () => {
    const q = { start: "09:00", end: "17:00" };
    expect(inQuietHours(at(12), q)).toBe(true);
    expect(inQuietHours(at(8), q)).toBe(false);
    expect(inQuietHours(at(17), q)).toBe(false); // exclusive end
  });

  it("is never quiet for a malformed or zero-width window", () => {
    expect(inQuietHours(at(3), { start: "bad", end: "08:00" })).toBe(false);
    expect(inQuietHours(at(3), { start: "08:00", end: "08:00" })).toBe(false);
  });
});

describe("parseNotificationPrefs", () => {
  it("defaults to the full DEFAULT_NOTIFICATION_PREFS for missing / invalid config", () => {
    expect(parseNotificationPrefs(undefined)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs(null)).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs("nonsense")).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs({})).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(parseNotificationPrefs({ notifications: {} })).toEqual(DEFAULT_NOTIFICATION_PREFS);
  });

  it("reads every field, ignoring mistyped ones", () => {
    expect(
      parseNotificationPrefs({
        notifications: {
          enabled: false,
          toast: false,
          macos: true,
          onBlocked: false,
          onDone: true,
          quietHours: { start: "22:00", end: "08:00" },
        },
      }),
    ).toEqual({
      enabled: false,
      toast: false,
      macos: true,
      onBlocked: false,
      onDone: true,
      quietHours: { start: "22:00", end: "08:00" },
    });
    // A malformed quietHours block resolves to null (disabled).
    expect(
      parseNotificationPrefs({ notifications: { quietHours: { start: "nope" } } }).quietHours,
    ).toBeNull();
    expect(parseNotificationPrefs({ notifications: { enabled: "yes", onDone: 1 } })).toEqual(
      DEFAULT_NOTIFICATION_PREFS,
    );
  });
});

describe("applyKillSwitch", () => {
  const full: NotificationPrefs = {
    enabled: true,
    toast: true,
    macos: true,
    onBlocked: true,
    onDone: true,
    quietHours: null,
  };

  it("TMUX_IDE_NOTIFY=0 disables the master switch and both channels", () => {
    expect(applyKillSwitch(full, "0")).toEqual({
      ...full,
      enabled: false,
      toast: false,
      macos: false,
    });
  });

  it("leaves prefs untouched otherwise", () => {
    expect(applyKillSwitch(full, undefined)).toEqual(full);
    expect(applyKillSwitch(full, "1")).toEqual(full);
    expect(applyKillSwitch(full, "")).toEqual(full);
  });
});

describe("terminalNotifierArgs", () => {
  it("builds a click-through banner that switches to the session", () => {
    expect(
      terminalNotifierArgs({ message: "claude blocked · web:1.2 — needs input", session: "web" }),
    ).toEqual([
      "-title",
      "tmux-ide",
      "-message",
      "claude blocked · web:1.2 — needs input",
      "-execute",
      "tmux switch-client -t 'web'",
    ]);
  });

  it("single-quote-escapes a session name for the -execute shell command", () => {
    expect(terminalNotifierArgs({ message: "m", session: "wei'rd" })).toEqual([
      "-title",
      "tmux-ide",
      "-message",
      "m",
      "-execute",
      "tmux switch-client -t 'wei'\\''rd'",
    ]);
  });
});
