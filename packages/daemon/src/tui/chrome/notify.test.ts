/**
 * Unit tests for the pure parts of the notification loop — the decision engine
 * (state filtering, viewer suppression, debounce/flap guard), the message
 * format, the client parser, prefs resolution + kill-switch, quiet hours, and
 * the native/legacy macOS click-through argv.
 */
import { describe, expect, it } from "vitest";
import {
  APP_FOCUS_STALE_MS,
  applyKillSwitch,
  buildAppFocusValue,
  DARWIN_SOUND_FILE,
  decideNotifications,
  decideTtyWrites,
  DEFAULT_NOTIFICATION_PREFS,
  enabledStates,
  inQuietHours,
  LINUX_SOUND_FILE,
  notifierExecuteCommand,
  nativeMacosNotifierArgs,
  notifyDebounceKey,
  notifyMessage,
  notifySendArgs,
  NOTIFY_DEBOUNCE_MS,
  NOTIFY_MAX_LEN,
  osc9Notification,
  osc99Notification,
  parseAppFocus,
  parseHHMM,
  parseNotificationPrefs,
  parseClients,
  parseTmuxSocketPath,
  resolveNativeMacosNotifierPath,
  sendSystemNotification,
  soundArgv,
  soundEligible,
  suppressToastFor,
  terminalNotifierArgs,
  terminalNotifyEscape,
  type AppFocus,
  type AttachedClient,
  type NotificationPrefs,
  type NotifyEvent,
  type SystemNotification,
} from "./notify.ts";

function ev(session: string, to: NotifyEvent["to"], extra: Partial<NotifyEvent> = {}): NotifyEvent {
  return { session, from: "working", to, ...extra };
}

/** The expected system entry for a pane-less `ev()` transition. */
function sys(session: string, state: NotifyEvent["to"], message: string) {
  return { message, session, state, paneId: null, windowIndex: null };
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
      sys("a", "blocked", "agent blocked · a — needs input"),
      sys("b", "done", "agent done · b — finished"),
    ]);
  });

  it("honors the passed-in `states` set (onBlocked/onDone gating)", () => {
    const events = [ev("a", "blocked"), ev("b", "done")];
    const { system } = decideNotifications(events, [], new Map(), 0, new Set(["blocked"]));
    expect(system).toEqual([sys("a", "blocked", "agent blocked · a — needs input")]);
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
    // The system (banner) entry is still produced regardless of viewers.
    expect(system).toEqual([sys("web", "blocked", "agent blocked · web — needs input")]);
  });

  it("suppresses toasts entirely when the only client is viewing the session, but keeps the system entry", () => {
    const clients: AttachedClient[] = [{ client: "viewer", session: "web" }];
    const { toasts, system } = decideNotifications([ev("web", "blocked")], clients, new Map(), 0);
    expect(toasts).toEqual([]);
    expect(system).toEqual([sys("web", "blocked", "agent blocked · web — needs input")]);
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

  it("never notifies a first-sight event (from: null) — the restart/first-tick grace", () => {
    const clients: AttachedClient[] = [{ client: "c1", session: "other" }];
    const d = decideNotifications(
      [ev("web", "blocked", { from: null, paneId: "%1" })],
      clients,
      new Map(),
      0,
    );
    expect(d.toasts).toEqual([]);
    expect(d.system).toEqual([]);
    expect(d.nextLastNotified.size).toBe(0);
  });

  it("debounces per PANE, so two agents blocking in the same session both ping", () => {
    const clients: AttachedClient[] = [{ client: "c1", session: "other" }];
    const first = decideNotifications(
      [ev("web", "blocked", { paneId: "%1", agent: "claude" })],
      clients,
      new Map(),
      0,
    );
    expect(first.toasts).toHaveLength(1);
    // 10s later, a SECOND pane in the same session blocks — inside the window.
    const second = decideNotifications(
      [ev("web", "blocked", { paneId: "%2", agent: "codex" })],
      clients,
      first.nextLastNotified,
      10_000,
    );
    expect(second.toasts).toHaveLength(1);
    expect(second.nextLastNotified.get("%1:blocked")).toBe(0);
    expect(second.nextLastNotified.get("%2:blocked")).toBe(10_000);
    // The SAME pane flapping again inside the window stays quiet.
    const flap = decideNotifications(
      [ev("web", "blocked", { paneId: "%1" })],
      clients,
      second.nextLastNotified,
      20_000,
    );
    expect(flap.toasts).toEqual([]);
  });

  it("suppresses toast AND banner when the app is attached and the pane is on its screen", () => {
    const clients: AttachedClient[] = [{ client: "c1", session: "other" }];
    const focus: AppFocus = { ts: 0, attached: true, session: "web", panes: ["%1"] };
    const visible = decideNotifications(
      [ev("web", "blocked", { paneId: "%1" })],
      clients,
      new Map(),
      0,
      undefined,
      focus,
    );
    expect(visible.toasts).toEqual([]);
    expect(visible.system).toEqual([]);
    // Nothing fired → nothing stamped: the transition isn't debounced away for later.
    expect(visible.nextLastNotified.size).toBe(0);
    // A pane NOT on the app's screen still pings.
    const hidden = decideNotifications(
      [ev("web", "blocked", { paneId: "%2" })],
      clients,
      new Map(),
      0,
      undefined,
      focus,
    );
    expect(hidden.system).toHaveLength(1);
    // A DETACHED app suppresses nothing.
    const detached = decideNotifications(
      [ev("web", "blocked", { paneId: "%1" })],
      clients,
      new Map(),
      0,
      undefined,
      { ...focus, attached: false },
    );
    expect(detached.system).toHaveLength(1);
  });
});

describe("notifyDebounceKey", () => {
  it("keys on the pane when known, else the session", () => {
    expect(notifyDebounceKey({ session: "web", to: "blocked", paneId: "%3" })).toBe("%3:blocked");
    expect(notifyDebounceKey({ session: "web", to: "blocked" })).toBe("web:blocked");
    expect(notifyDebounceKey({ session: "web", to: "done", paneId: null })).toBe("web:done");
  });
});

describe("suppressToastFor", () => {
  const event = ev("web", "blocked", { paneId: "%1", windowIndex: 2 });

  it("is window-granular: same session other window still toasts", () => {
    expect(suppressToastFor({ client: "c", session: "web", windowIndex: 2 }, event)).toBe(true);
    expect(suppressToastFor({ client: "c", session: "web", windowIndex: 1 }, event)).toBe(false);
    expect(suppressToastFor({ client: "c", session: "api", windowIndex: 2 }, event)).toBe(false);
  });

  it("degrades to session granularity when either window is unknown", () => {
    expect(suppressToastFor({ client: "c", session: "web", windowIndex: null }, event)).toBe(true);
    expect(suppressToastFor({ client: "c", session: "web" }, ev("web", "blocked"))).toBe(true);
  });

  it("always suppresses clients viewing the hosted app (in-app surfacing owns that screen)", () => {
    expect(suppressToastFor({ client: "c", session: "_tmux-ide-app", windowIndex: 0 }, event)).toBe(
      true,
    );
  });
});

describe("app focus record", () => {
  const focus: AppFocus = { ts: 10_000, attached: true, session: "web", panes: ["%1", "%2"] };

  it("round-trips through build + parse while fresh", () => {
    expect(parseAppFocus(buildAppFocusValue(focus), 10_000 + 3000)).toEqual(focus);
  });

  it("treats a stale record as absent (an app that died without cleanup)", () => {
    expect(parseAppFocus(buildAppFocusValue(focus), 10_000 + APP_FOCUS_STALE_MS + 1)).toBeNull();
  });

  it("never throws on garbage and filters non-string pane ids", () => {
    expect(parseAppFocus("not json", 0)).toBeNull();
    expect(parseAppFocus("", 0)).toBeNull();
    expect(parseAppFocus(null, 0)).toBeNull();
    expect(parseAppFocus(JSON.stringify({ ts: 5, panes: ["%1", 7, null] }), 5)).toEqual({
      ts: 5,
      attached: false,
      session: "",
      panes: ["%1"],
    });
    expect(parseAppFocus(JSON.stringify({ attached: true }), 0)).toBeNull(); // no ts
  });
});

describe("parseClients", () => {
  it("parses client\\tsession\\twindow\\ttty\\ttermname lines and drops malformed ones", () => {
    expect(
      parseClients([
        "/dev/ttys000\tweb\t2\t/dev/ttys000\txterm-256color",
        "/dev/ttys001\tapi\t0\t/dev/ttys001\txterm-kitty",
        "",
        "lonely",
        "\tdangling\t1",
      ]),
    ).toEqual([
      {
        client: "/dev/ttys000",
        session: "web",
        windowIndex: 2,
        tty: "/dev/ttys000",
        termname: "xterm-256color",
      },
      {
        client: "/dev/ttys001",
        session: "api",
        windowIndex: 0,
        tty: "/dev/ttys001",
        termname: "xterm-kitty",
      },
    ]);
  });

  it("parses missing/garbage optional fields as null (session-granular, escape-less fallback)", () => {
    expect(parseClients(["/dev/ttys000\tweb", "/dev/ttys001\tapi\tx"])).toEqual([
      { client: "/dev/ttys000", session: "web", windowIndex: null, tty: null, termname: null },
      { client: "/dev/ttys001", session: "api", windowIndex: null, tty: null, termname: null },
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
          terminal: false,
          delaySeconds: 5,
          sound: "all",
          onBlocked: false,
          onDone: true,
          quietHours: { start: "22:00", end: "08:00" },
        },
      }),
    ).toEqual({
      enabled: false,
      toast: false,
      macos: true,
      terminal: false,
      delaySeconds: 5,
      sound: "all",
      onBlocked: false,
      onDone: true,
      quietHours: { start: "22:00", end: "08:00" },
    });
    // Mistyped M25.2 fields fall back to their defaults (delay 0 is VALID).
    expect(
      parseNotificationPrefs({
        notifications: { terminal: "yes", delaySeconds: -3, sound: "loud" },
      }),
    ).toMatchObject({ terminal: true, delaySeconds: 2, sound: "blocked" });
    expect(parseNotificationPrefs({ notifications: { delaySeconds: 0 } }).delaySeconds).toBe(0);
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
    terminal: true,
    delaySeconds: 2,
    sound: "all",
    onBlocked: true,
    onDone: true,
    quietHours: null,
  };

  it("TMUX_IDE_NOTIFY=0 disables the master switch and every channel", () => {
    expect(applyKillSwitch(full, "0")).toEqual({
      ...full,
      enabled: false,
      toast: false,
      macos: false,
      terminal: false,
      sound: "none",
    });
  });

  it("leaves prefs untouched otherwise", () => {
    expect(applyKillSwitch(full, undefined)).toEqual(full);
    expect(applyKillSwitch(full, "1")).toEqual(full);
    expect(applyKillSwitch(full, "")).toEqual(full);
  });
});

describe("notifierExecuteCommand", () => {
  it("routes through the hosted cockpit when it exists, else switches straight to the session", () => {
    expect(notifierExecuteCommand("web")).toBe(
      "if tmux has-session -t '=_tmux-ide-app' 2>/dev/null; then " +
        "tmux set-option -t '_tmux-ide-app' @tmux_ide_app_jump 'web'; " +
        "tmux switch-client -t '=_tmux-ide-app'; " +
        "else tmux switch-client -t 'web'; fi",
    );
  });

  it("single-quote-escapes the session name in both branches", () => {
    const cmd = notifierExecuteCommand("wei'rd");
    expect(cmd).toContain("@tmux_ide_app_jump 'wei'\\''rd'");
    expect(cmd).toContain("else tmux switch-client -t 'wei'\\''rd'; fi");
  });
});

/** A full SystemNotification for the channel-arg tests. */
function sysN(over: Partial<SystemNotification> = {}): SystemNotification {
  return {
    message: "claude blocked · web:1.2 — needs input",
    session: "web",
    state: "blocked",
    paneId: "%1",
    windowIndex: 1,
    ...over,
  };
}

describe("terminalNotifierArgs", () => {
  it("builds the legacy click-through banner whose -execute is the jump command", () => {
    expect(terminalNotifierArgs(sysN())).toEqual([
      "-title",
      "tmux-ide",
      "-message",
      "claude blocked · web:1.2 — needs input",
      "-execute",
      notifierExecuteCommand("web"),
    ]);
  });
});

describe("native macOS notifier", () => {
  it("finds the packaged app above the bundled bin directory", () => {
    const app = "/opt/tmux-ide/packages/daemon/dist/native/TmuxIdeNotifier.app";
    const executable = `${app}/Contents/MacOS/tmux-ide-notifier`;
    expect(
      resolveNativeMacosNotifierPath({
        cliPath: "/opt/tmux-ide/bin/cli.js",
        modulePath: "/virtual/tmux-ide-tui",
        exists: (path) => path === executable,
      }),
    ).toBe(app);
  });

  it("returns null when no runtime anchor contains the helper", () => {
    expect(
      resolveNativeMacosNotifierPath({
        cliPath: null,
        modulePath: "/virtual/tmux-ide-tui",
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("parses the exact tmux socket and rejects malformed values", () => {
    expect(parseTmuxSocketPath("/private/tmp/tmux-501/default,123,0")).toBe(
      "/private/tmp/tmux-501/default",
    );
    expect(parseTmuxSocketPath("/private/tmp/tmux,with,commas,123,0")).toBe(
      "/private/tmp/tmux,with,commas",
    );
    expect(parseTmuxSocketPath("relative,123,0")).toBeNull();
    expect(parseTmuxSocketPath(undefined)).toBeNull();
  });

  it("passes structured click coordinates to the hidden native app", () => {
    expect(
      nativeMacosNotifierArgs(
        "/opt/tmux-ide/TmuxIdeNotifier.app",
        sysN(),
        "/opt/homebrew/bin/tmux",
        "/private/tmp/tmux-501/default",
      ),
    ).toEqual([
      "-g",
      "-n",
      "/opt/tmux-ide/TmuxIdeNotifier.app",
      "--args",
      "--title",
      "tmux-ide",
      "--message",
      "claude blocked · web:1.2 — needs input",
      "--session",
      "web",
      "--host-session",
      "_tmux-ide-app",
      "--jump-option",
      "@tmux_ide_app_jump",
      "--tmux-path",
      "/opt/homebrew/bin/tmux",
      "--socket-path",
      "/private/tmp/tmux-501/default",
    ]);
  });
});

describe("notifySendArgs (Linux banners)", () => {
  it("marks blocked critical; done stays default urgency", () => {
    expect(notifySendArgs(sysN())).toEqual([
      "--app-name=tmux-ide",
      "--urgency=critical",
      "tmux-ide",
      "claude blocked · web:1.2 — needs input",
    ]);
    expect(notifySendArgs(sysN({ state: "done", message: "m" }))).toEqual([
      "--app-name=tmux-ide",
      "tmux-ide",
      "m",
    ]);
  });
});

describe("sendSystemNotification routing (injected io)", () => {
  const calls = () => {
    const seen: Array<{ cmd: string; args: string[] }> = [];
    return {
      seen,
      exec: (cmd: string, args: string[]) => {
        seen.push({ cmd, args });
      },
    };
  };

  it("linux + desktop env + notify-send on PATH → notify-send with the banner args", () => {
    const { seen, exec } = calls();
    sendSystemNotification(sysN(), {
      platform: "linux",
      env: { DISPLAY: ":0" },
      exec,
      hasBinary: (n) => n === "notify-send",
    });
    expect(seen).toEqual([{ cmd: "notify-send", args: notifySendArgs(sysN()) }]);
  });

  it("linux honors WAYLAND_DISPLAY too, and skips silently when headless or binary-less", () => {
    const { seen, exec } = calls();
    const io = { platform: "linux" as const, exec, hasBinary: () => true };
    sendSystemNotification(sysN(), { ...io, env: { WAYLAND_DISPLAY: "wayland-0" } });
    expect(seen).toHaveLength(1);
    sendSystemNotification(sysN(), { ...io, env: {} }); // headless
    sendSystemNotification(sysN(), {
      ...io,
      env: { DISPLAY: ":0" },
      hasBinary: () => false, // no notify-send
    });
    expect(seen).toHaveLength(1);
  });

  it("darwin prefers the native app, retaining terminal-notifier and osascript fallbacks", () => {
    const { seen, exec } = calls();
    const app = "/opt/tmux-ide/TmuxIdeNotifier.app";
    const tmux = "/opt/homebrew/bin/tmux";
    const env = { TMUX: "/private/tmp/tmux-501/default,123,0" };
    sendSystemNotification(sysN(), {
      platform: "darwin",
      exec,
      env,
      nativeNotifierPath: app,
      tmuxPath: tmux,
      hasBinary: () => false,
    });
    expect(seen[0]).toEqual({
      cmd: "/usr/bin/open",
      args: nativeMacosNotifierArgs(app, sysN(), tmux, parseTmuxSocketPath(env.TMUX)),
    });

    sendSystemNotification(sysN(), {
      platform: "darwin",
      exec,
      nativeNotifierPath: null,
      hasBinary: (name) => name === "terminal-notifier",
    });
    expect(seen[1]).toEqual({ cmd: "terminal-notifier", args: terminalNotifierArgs(sysN()) });

    sendSystemNotification(sysN(), {
      platform: "darwin",
      exec,
      nativeNotifierPath: null,
      hasBinary: () => false,
    });
    expect(seen[2]?.cmd).toBe("osascript");
    expect(seen[2]?.args[1]).toContain("claude blocked");
  });

  it("darwin falls back when LaunchServices rejects a corrupt native bundle", () => {
    const seen: Array<{ cmd: string; args: string[] }> = [];
    sendSystemNotification(sysN(), {
      platform: "darwin",
      nativeNotifierPath: "/broken/TmuxIdeNotifier.app",
      tmuxPath: "/opt/homebrew/bin/tmux",
      hasBinary: (name) => name === "terminal-notifier",
      exec: (cmd, args) => {
        seen.push({ cmd, args });
        if (cmd === "/usr/bin/open") throw new Error("LaunchServices rejected bundle");
      },
    });

    expect(seen.map(({ cmd }) => cmd)).toEqual(["/usr/bin/open", "terminal-notifier"]);
    expect(seen[1]?.args).toEqual(terminalNotifierArgs(sysN()));
  });

  it("other platforms are a no-op", () => {
    const { seen, exec } = calls();
    sendSystemNotification(sysN(), { platform: "win32", exec, hasBinary: () => true });
    expect(seen).toEqual([]);
  });
});

describe("terminal escapes (M25.2)", () => {
  it("OSC 9 is BEL-terminated; OSC 99 is kitty's ST form with urgency on blocked", () => {
    expect(osc9Notification("hi")).toBe("\x1b]9;hi\x07");
    expect(osc99Notification("hi", false)).toBe("\x1b]99;;hi\x1b\\");
    expect(osc99Notification("hi", true)).toBe("\x1b]99;u=2;hi\x1b\\");
  });

  it("picks the form by termname: kitty → OSC 99, nested tmux/screen → passthrough, else raw OSC 9", () => {
    expect(terminalNotifyEscape("xterm-kitty", "m", true)).toBe(osc99Notification("m", true));
    expect(terminalNotifyEscape("xterm-256color", "m", true)).toBe(osc9Notification("m"));
    expect(terminalNotifyEscape(null, "m", false)).toBe(osc9Notification("m"));
    // nested: the envelope with the inner ESC doubled, so the OUTER mux unwraps it
    expect(terminalNotifyEscape("tmux-256color", "m", false)).toBe(
      "\x1bPtmux;\x1b\x1b]9;m\x07\x1b\\",
    );
    expect(terminalNotifyEscape("screen-256color", "m", false)).toBe(
      "\x1bPtmux;\x1b\x1b]9;m\x07\x1b\\",
    );
  });
});

describe("decideTtyWrites", () => {
  const prefs = { terminal: true, sound: "blocked" as const };
  const clients: AttachedClient[] = [
    { client: "c1", session: "other", windowIndex: 0, tty: "/dev/t1", termname: "xterm-256color" },
    { client: "c2", session: "web", windowIndex: 1, tty: "/dev/t2", termname: "xterm-kitty" },
    { client: "c3", session: "other", windowIndex: 0, tty: null, termname: "xterm" },
  ];

  it("writes escape + BEL to every non-viewing client with a known tty", () => {
    const n = sysN({ message: "m" });
    expect(decideTtyWrites(n, clients, prefs)).toEqual([
      // c1: not viewing web → raw OSC 9 + BEL (blocked)
      { tty: "/dev/t1", data: `${osc9Notification("m")}\x07` },
      // c2 IS viewing web:1 (the event's window) → suppressed; c3 has no tty
    ]);
  });

  it("kitty client gets the OSC 99 form", () => {
    const n = sysN({ message: "m", session: "api", windowIndex: 0 });
    const writes = decideTtyWrites(n, clients, prefs);
    expect(writes.find((w) => w.tty === "/dev/t2")?.data).toBe(
      `${osc99Notification("m", true)}\x07`,
    );
  });

  it("BEL rides only blocked and only while sound is on; escapes ride prefs.terminal", () => {
    const done = sysN({ message: "m", state: "done" });
    expect(decideTtyWrites(done, [clients[0]!], prefs)).toEqual([
      { tty: "/dev/t1", data: osc9Notification("m") }, // no BEL on done
    ]);
    expect(
      decideTtyWrites(sysN({ message: "m" }), [clients[0]!], { ...prefs, sound: "none" }),
    ).toEqual([{ tty: "/dev/t1", data: osc9Notification("m") }]);
    // terminal off, sound on → the BEL still lands alone on blocked
    expect(
      decideTtyWrites(sysN({ message: "m" }), [clients[0]!], { terminal: false, sound: "blocked" }),
    ).toEqual([{ tty: "/dev/t1", data: "\x07" }]);
    // both channels off → nothing at all
    expect(
      decideTtyWrites(sysN({ message: "m" }), [clients[0]!], { terminal: false, sound: "none" }),
    ).toEqual([]);
  });
});

describe("sound routing (M25.2)", () => {
  it("soundEligible follows the tri-state", () => {
    expect(soundEligible("blocked", "blocked")).toBe(true);
    expect(soundEligible("done", "blocked")).toBe(false);
    expect(soundEligible("done", "all")).toBe(true);
    expect(soundEligible("blocked", "all")).toBe(true);
    expect(soundEligible("blocked", "none")).toBe(false);
    expect(soundEligible("working", "all")).toBe(false);
  });

  it("soundArgv picks the platform player (null elsewhere)", () => {
    expect(soundArgv("darwin")).toEqual(["afplay", DARWIN_SOUND_FILE]);
    expect(soundArgv("linux")).toEqual(["paplay", LINUX_SOUND_FILE]);
    expect(soundArgv("win32")).toBeNull();
  });
});
