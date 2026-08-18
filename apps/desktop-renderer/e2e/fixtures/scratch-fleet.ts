/**
 * A disposable tmux fleet for one test.
 *
 * The fleet is a real tmux server on a private socket with real interactive
 * shells in its panes — the app under test reads nothing else. It is built from
 * scratch per test so a chain may freely kill sessions out from under the app,
 * which is exactly what the degraded-state chain does.
 */
import { execFile, execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The `sun_path` limit for a unix socket. macOS enforces it strictly. */
const MAX_UNIX_SOCKET_PATH = 103;

export interface ScratchFleet {
  readonly root: string;
  readonly projectDir: string;
  readonly socketPath: string;
  readonly daemonInfoDir: string;
  readonly environment: Readonly<Record<string, string>>;
  /** Session names in creation order, in the order the daemon will see them. */
  readonly sessionNames: readonly string[];
  /** Create one more adopted session; returns its name. */
  readonly createSession: (name: string) => string;
  /** Kill a session. The tmux server survives; only this session goes. */
  readonly killSession: (name: string) => void;
  readonly listSessions: () => readonly string[];
  /** Window names of one session, in tmux order — the proof a rename landed. */
  readonly listWindows: (name: string) => readonly string[];
  /** Total panes across a session's windows — the proof a kill landed. */
  readonly countPanes: (name: string) => number;
  /** The session's CURRENT window name — what a window tab click must change. */
  readonly currentWindow: (name: string) => string;
  /** Every pane of the session's current window, as `width x height` cells. */
  readonly paneSizes: (name: string, windowName?: string) => readonly string[];
  /**
   * The session's current WINDOW size in cells, as tmux reports it — the ground
   * truth for whether the app's attachment actually owns the geometry (m50.2).
   */
  readonly windowGrid: (name: string) => { readonly cols: number; readonly rows: number };
  /** Raw pane text, for proving the app is showing what tmux actually holds. */
  readonly capturePane: (name: string) => string;
  /** Raw text from every pane in the current window, in tmux order. */
  readonly captureWindowPanes: (name: string) => string;
  /** Type literal text into the current pane, then press Enter. SETUP only. */
  readonly typeInPane: (name: string, text: string) => void;
  readonly dispose: () => Promise<void>;
}

export interface CreateScratchFleetOptions {
  /** How many adopted sessions to stand up. Zero is a legitimate empty fleet. */
  readonly sessions: number;
  /** Distinguishes concurrent fleets in tmux session names and temp paths. */
  readonly slug: string;
  /** Leave sessions ordinary until the public app adopts them. Defaults true. */
  readonly adoptSessions?: boolean;
  /** Safe setup-only marker printed once before the first interactive shell. */
  readonly initialPaneMarker?: string;
}

/**
 * Session names are deliberately NOT `zz-`-prefixed: daemon discovery filters
 * `zz-` and `_` sessions out of the fleet, so a `zz-` session could never reach
 * the page under test and the suite would prove nothing.
 */
function sessionName(slug: string, index: number): string {
  return `e2e-${slug}-${process.pid}-${index}`;
}

export async function createScratchFleet(
  options: CreateScratchFleetOptions,
): Promise<ScratchFleet> {
  if (options.initialPaneMarker && !/^RIG_[A-Z0-9_]{8,96}$/u.test(options.initialPaneMarker))
    throw new Error("scratch initial pane marker must be a bounded safe ProductRig token");
  // /tmp, not os.tmpdir(): on macOS the per-user temp dir realpaths to a long
  // prefix that pushes the tmux socket past the sun_path limit.
  const root = await mkdtemp(`/tmp/tmi-e2e-${options.slug}-`);
  const home = join(root, "home");
  const projectDir = join(root, "project");
  const daemonInfoDir = join(root, "daemon");
  const registryDir = join(root, "registry");
  const settingsDir = join(root, "settings");
  const stateDir = join(root, "state");
  const socketPath = join(root, "t.sock");
  const resolvedLength = realpathSync(root).length + "/t.sock".length;
  if (resolvedLength > MAX_UNIX_SOCKET_PATH) {
    throw new Error(
      `scratch tmux socket resolves to ${resolvedLength} bytes, over the ${MAX_UNIX_SOCKET_PATH}-byte limit`,
    );
  }
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(projectDir, { recursive: true }),
    mkdir(daemonInfoDir, { recursive: true, mode: 0o700 }),
    mkdir(registryDir, { recursive: true, mode: 0o700 }),
    mkdir(settingsDir, { recursive: true, mode: 0o700 }),
  ]);

  const tmuxBin = execFileSync("which", ["tmux"], { encoding: "utf8" }).trim();
  const sharedEnvironment = {
    TERM: process.env.TERM ?? "xterm-256color",
    PATH: process.env.PATH ?? "",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    TMUX_IDE_TMUX_BIN: tmuxBin,
    TMUX_IDE_DAEMON_INFO_DIR: daemonInfoDir,
    TMUX_IDE_REGISTRY_DIR: registryDir,
    TMUX_IDE_SETTINGS_DIR: settingsDir,
    TMUX_IDE_HOME: stateDir,
    TMUX_IDE_CONFIG: join(stateDir, "config.json"),
  };
  const runTmux = (argv: readonly string[]): string =>
    execFileSync(tmuxBin, ["-S", socketPath, ...argv], {
      cwd: root,
      encoding: "utf8",
      env: sharedEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/(?:\r?\n)+$/u, "");

  const names: string[] = [];
  let serverPid: number | null = null;

  const createSession = (name: string): string => {
    const firstPaneCommand =
      serverPid === null && options.initialPaneMarker
        ? `printf '${options.initialPaneMarker}\\n'; exec sh -i`
        : "exec sh -i";
    if (serverPid === null) {
      runTmux([
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        projectDir,
        "-n",
        "one",
        firstPaneCommand,
      ]);
      serverPid = Number(runTmux(["display-message", "-p", "-t", name, "#{pid}"]));
    } else {
      runTmux(["new-session", "-d", "-s", name, "-c", projectDir, "-n", "one", "exec sh -i"]);
    }
    runTmux(["new-window", "-d", "-t", `=${name}:`, "-c", projectDir, "-n", "two", "exec sh -i"]);
    // Most tests start with an adopted fleet. Cold public-entry journeys leave
    // this absent so adoption is product behavior rather than harness setup.
    if (options.adoptSessions !== false)
      runTmux(["set-option", "-t", name, "@tmux_ide_adopted", "1"]);
    if (!names.includes(name)) names.push(name);
    return name;
  };

  for (let index = 0; index < options.sessions; index += 1) {
    createSession(sessionName(options.slug, index));
  }

  // An empty fleet still needs a tmux server for the daemon to talk to, so the
  // daemon's own failure to find one cannot be mistaken for an empty fleet.
  if (serverPid === null) {
    runTmux([
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "_e2e-holder",
      "-c",
      projectDir,
      "exec sh -i",
    ]);
    serverPid = Number(runTmux(["display-message", "-p", "-t", "_e2e-holder", "#{pid}"]));
  }

  return {
    root,
    projectDir,
    socketPath,
    daemonInfoDir,
    sessionNames: names,
    createSession,
    killSession: (name) => {
      runTmux(["kill-session", "-t", `=${name}`]);
    },
    listSessions: () =>
      runTmux(["list-sessions", "-F", "#{session_name}"]).split("\n").filter(Boolean),
    listWindows: (name) =>
      runTmux(["list-windows", "-t", `=${name}`, "-F", "#{window_name}"])
        .split("\n")
        .filter(Boolean),
    countPanes: (name) =>
      runTmux(["list-panes", "-s", "-t", `=${name}`, "-F", "#{pane_id}"])
        .split("\n")
        .filter(Boolean).length,
    currentWindow: (name) => runTmux(["display-message", "-p", "-t", `${name}:`, "#{window_name}"]),
    /**
     * The session's current WINDOW size in cells, as tmux itself reports it.
     *
     * This is the ground truth a geometry-ownership assertion needs (m50.2): the
     * app claims its attachment drives this number, and only tmux can say
     * whether it does.
     */
    windowGrid: (name) => {
      /*
       * `x` as the separator, not a tab.
       *
       * `runTmux` deliberately omits locale variables, and without a locale
       * tmux sanitizes non-printable characters out
       * of `display-message -p` output — a tab comes back as `_`, so a
       * tab-separated format silently parses to NaN. `x` is what every other
       * geometry helper here uses, and it survives.
       */
      const [cols, rows] = runTmux([
        "display-message",
        "-p",
        "-t",
        `${name}:`,
        "#{window_width}x#{window_height}",
      ]).split("x");
      return { cols: Number(cols), rows: Number(rows) };
    },
    paneSizes: (name, windowName) =>
      runTmux([
        "list-panes",
        "-t",
        windowName === undefined ? `${name}:` : `=${name}:=${windowName}`,
        "-F",
        "#{pane_width}x#{pane_height}",
      ])
        .split("\n")
        .filter(Boolean),
    // `<session>:` is the session's current window, active pane. A bare `=name`
    // is a SESSION target and tmux rejects it where a pane is required.
    capturePane: (name) => runTmux(["capture-pane", "-p", "-t", `${name}:`]),
    captureWindowPanes: (name) =>
      runTmux(["list-panes", "-t", `${name}:`, "-F", "#{pane_id}"])
        .split("\n")
        .filter(Boolean)
        .map((paneId) => runTmux(["capture-pane", "-p", "-t", paneId]))
        .join("\n"),
    // `-l` keeps the fixture text literal: neither tmux key names nor a shell
    // interpolation layer gets to reinterpret the marker used by paint proofs.
    typeInPane: (name, text) => {
      runTmux(["send-keys", "-t", `${name}:`, "-l", text]);
      runTmux(["send-keys", "-t", `${name}:`, "Enter"]);
    },
    environment: {
      ...sharedEnvironment,
      TMUX: `${socketPath},${serverPid},0`,
    },
    dispose: async () => {
      await execFileAsync(tmuxBin, ["-S", socketPath, "kill-server"]).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    },
  };
}
