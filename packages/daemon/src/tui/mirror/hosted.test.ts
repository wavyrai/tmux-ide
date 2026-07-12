import { describe, it, expect } from "vitest";
import {
  APP_HOST_SESSION,
  HOSTED_ENV,
  wantsHostedApp,
  shellQuote,
  hostedEnvVars,
  hostedCommandLine,
  hostExistsArgv,
  hostCreateArgv,
  hostSetupArgvs,
  hostAttachArgv,
  HOST_RESIZE_HOOKS,
} from "./hosted.ts";

const noEntry = {
  flagDetachable: false,
  flagHosted: false,
  configDetachable: false,
  hostedEnv: false,
};

describe("wantsHostedApp", () => {
  it("is off by default", () => {
    expect(wantsHostedApp(noEntry)).toBe(false);
  });

  it("either flag opts in", () => {
    expect(wantsHostedApp({ ...noEntry, flagDetachable: true })).toBe(true);
    expect(wantsHostedApp({ ...noEntry, flagHosted: true })).toBe(true);
  });

  it("config opts bare `app` in", () => {
    expect(wantsHostedApp({ ...noEntry, configDetachable: true })).toBe(true);
  });

  it("the hosted env marker vetoes everything (recursion guard)", () => {
    expect(
      wantsHostedApp({
        flagDetachable: true,
        flagHosted: true,
        configDetachable: true,
        hostedEnv: true,
      }),
    ).toBe(false);
  });
});

describe("shellQuote", () => {
  it("wraps plain words", () => {
    expect(shellQuote("bun")).toBe("'bun'");
  });

  it("passes spaces and metacharacters literally", () => {
    expect(shellQuote("/Users/t h/$HOME;rm")).toBe("'/Users/t h/$HOME;rm'");
  });

  it("escapes embedded single quotes", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("hostedEnvVars", () => {
  it("always carries the marker, cwd, and cli", () => {
    const env = hostedEnvVars({ cwd: "/work", cli: "/repo/bin/cli.js" });
    expect(env).toEqual({
      [HOSTED_ENV]: "1",
      TMUX_IDE_CWD: "/work",
      TMUX_IDE_CLI: "/repo/bin/cli.js",
    });
  });

  it("passes PATH and the state/config/binary overrides through when set", () => {
    const env = hostedEnvVars({
      cwd: "/work",
      cli: "/repo/bin/cli.js",
      path: "/usr/local/bin:/usr/bin",
      home: "/scratch/home",
      config: "/scratch/config.json",
      tuiBin: "/scratch/tui",
    });
    expect(env.PATH).toBe("/usr/local/bin:/usr/bin");
    expect(env.TMUX_IDE_HOME).toBe("/scratch/home");
    expect(env.TMUX_IDE_CONFIG).toBe("/scratch/config.json");
    expect(env.TMUX_IDE_TUI_BIN).toBe("/scratch/tui");
  });
});

describe("hostedCommandLine", () => {
  it("builds exec env assigns + quoted bin and argv", () => {
    const line = hostedCommandLine("bun", ["/repo/app.tsx", "--target=web"], {
      [HOSTED_ENV]: "1",
      TMUX_IDE_CWD: "/work dir",
    });
    expect(line).toBe(
      `exec env TMUX_IDE_HOSTED='1' TMUX_IDE_CWD='/work dir' 'bun' '/repo/app.tsx' '--target=web'`,
    );
  });
});

describe("tmux argv builders", () => {
  it("existence probe exact-matches the host name", () => {
    expect(hostExistsArgv()).toEqual(["has-session", "-t", `=${APP_HOST_SESSION}`]);
  });

  it("create is detached, named, cwd-pinned, and runs the command line", () => {
    expect(hostCreateArgv({ cwd: "/repo", commandLine: "exec env A='1' 'bun'" })).toEqual([
      "new-session",
      "-d",
      "-s",
      APP_HOST_SESSION,
      "-c",
      "/repo",
      "exec env A='1' 'bun'",
    ]);
  });

  it("setup turns status off and pins window-size latest (no `=` — set-option rejects it)", () => {
    expect(hostSetupArgvs().slice(0, 2)).toEqual([
      ["set-option", "-t", APP_HOST_SESSION, "status", "off"],
      ["set-option", "-w", "-t", `${APP_HOST_SESSION}:`, "window-size", "latest"],
    ]);
  });

  it("setup enables focus-events so a returning terminal's focus re-adopts its size (M25.5)", () => {
    expect(hostSetupArgvs()).toContainEqual(["set-option", "-s", "focus-events", "on"]);
  });

  it("setup installs one session-scoped self-heal hook per client event (M25.5)", () => {
    const argvs = hostSetupArgvs();
    const heal = `set-option -w -t ${APP_HOST_SESSION}: window-size latest`;
    for (const hook of HOST_RESIZE_HOOKS) {
      expect(argvs).toContainEqual(["set-hook", "-t", APP_HOST_SESSION, hook, heal]);
    }
    // and nothing else rides along — status/window-size/focus-events + the hooks
    expect(argvs).toHaveLength(3 + HOST_RESIZE_HOOKS.length);
  });

  it("the heal is never resize-window (any form flips window-size to manual — the stuck state)", () => {
    for (const argv of hostSetupArgvs()) {
      expect(argv).not.toContain("resize-window");
      expect(argv.join(" ")).not.toMatch(/resize-window/);
    }
  });

  it("hook commands are tmux-native — no run-shell (run-shell hooks serialize the server)", () => {
    for (const argv of hostSetupArgvs()) {
      expect(argv.join(" ")).not.toMatch(/run-shell/);
    }
  });

  it("attach from a plain terminal, switch-client from inside tmux", () => {
    expect(hostAttachArgv(false)).toEqual(["attach-session", "-t", `=${APP_HOST_SESSION}`]);
    expect(hostAttachArgv(true)).toEqual(["switch-client", "-t", `=${APP_HOST_SESSION}`]);
  });
});

describe("the fleet/snapshot contract", () => {
  it("the host session name is _-prefixed (internal to every listing filter)", () => {
    expect(APP_HOST_SESSION.startsWith("_")).toBe(true);
  });
});
