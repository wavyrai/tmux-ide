import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { IdeError } from "./lib/errors.ts";
import { resolveRuntimeNamespace, runtimeNamespaceEnvironment } from "./lib/runtime-namespace.ts";
import {
  createPinnedWorkspaceTmuxRunner,
  resolveWorkspacePaneTmuxAuthority,
} from "./lib/workspace-pane-creation.ts";

export interface OpenBrowserOptions {
  session?: string;
  pane?: string;
  split?: string;
  size?: string;
  window?: boolean;
}

/** Resolve once before creating a pane; ignore relative PATH entries. */
export function resolveTerminalBrowser(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = environment.TMUX_IDE_TERMINAL_BROWSER_BIN;
  const home = environment.HOME ?? homedir();
  // Resolve the managed alias on every invocation so an app update selects its
  // matching browser. Native assets remain outside the universal npm package.
  const bundled =
    platform === "darwin" && isAbsolute(home)
      ? [
          join(
            home,
            "Library",
            "Application Support",
            "tmux-ide",
            "native-alpha",
            "TmuxIDE.app",
            "Contents",
            "Resources",
            "browser",
            "terminal-browser",
          ),
        ]
      : [];
  const candidates = configured
    ? [configured]
    : [
        ...bundled,
        ...(environment.PATH ?? "")
          .split(delimiter)
          .filter(isAbsolute)
          .map((dir) => join(dir, "terminal-browser")),
      ];
  for (const candidate of candidates) {
    try {
      if (!isAbsolute(candidate)) continue;
      accessSync(candidate, constants.X_OK);
      const path = realpathSync(candidate);
      if (statSync(path).isFile()) return path;
    } catch {
      /* Try the next executable. */
    }
  }
  throw new IdeError(
    configured
      ? "TMUX_IDE_TERMINAL_BROWSER_BIN must name an absolute executable browser launcher."
      : "terminal-browser is not installed or is not on PATH. Install terminal-browser, or set TMUX_IDE_TERMINAL_BROWSER_BIN to its absolute launcher path.",
    { code: "BROWSER_UNAVAILABLE" },
  );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

export function validateBrowserOpen(url: string | undefined, options: OpenBrowserOptions): void {
  if (
    url !== undefined &&
    (!url || url.length > 16_384 || hasControlCharacter(url) || url.startsWith("-"))
  )
    throw new IdeError("Provide one URL, localhost address, or HTML file path.", {
      code: "USAGE",
      exitCode: 2,
    });
  if (options.split !== undefined && !["right", "down"].includes(options.split))
    throw new IdeError("--split must be right or down.", { code: "USAGE", exitCode: 2 });
  if (
    options.size !== undefined &&
    (!/^\d+$/u.test(options.size) || Number(options.size) < 10 || Number(options.size) > 90)
  )
    throw new IdeError("--size must be a percentage from 10 to 90.", {
      code: "USAGE",
      exitCode: 2,
    });
  if (options.window && (options.split !== undefined || options.size !== undefined))
    throw new IdeError("--window cannot be combined with --split or --size.", {
      code: "USAGE",
      exitCode: 2,
    });
  if (options.pane !== undefined && !/^%\d+$/u.test(options.pane))
    throw new IdeError("--pane must be an exact tmux pane ID, such as %3.", {
      code: "USAGE",
      exitCode: 2,
    });
  if (
    options.session !== undefined &&
    (!options.session || hasControlCharacter(options.session) || options.session.includes(":"))
  )
    throw new IdeError("--session must be an exact tmux session name.", {
      code: "USAGE",
      exitCode: 2,
    });
}

type Run = (args: readonly string[]) => string;

/** Printed when the opened browser never publishes tmux-ide's native controls. */
export const NO_NATIVE_CONTROLS_NOTICE =
  "This browser has no tmux-ide controls; install the native app for back/forward/reload.";

/** A browser bundled in a native app publishes its controls; a standalone one may not. */
function isBundledBrowser(executable: string): boolean {
  return /\/[^/]+\.app\/Contents\/Resources\/browser\//u.test(executable);
}

export interface ControlsWait {
  sleep?: (ms: number) => Promise<void>;
  /** Milliseconds; Date.now by default. */
  now?: () => number;
}

/** How long a standalone browser has to publish its controls. */
const STANDALONE_WAIT_MS = 2000;

/**
 * Watches the new pane for @tmux_ide_browser_control, which only a browser with
 * native controls sets. A browser bundled in an app is never reported: if it is
 * slow, its controls appear when it is ready. A standalone browser gets 2 s of
 * wall-clock time, however slow tmux answers, and then the notice. Returns
 * null once the option appears or when the pane is already gone.
 */
export async function nativeControlsNotice(
  run: Run,
  pane: string,
  executable: string,
  wait: ControlsWait = {},
): Promise<string | null> {
  if (isBundledBrowser(executable)) return null;
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = wait.now ?? Date.now;
  const deadline = now() + STANDALONE_WAIT_MS;
  for (;;) {
    let control: string;
    try {
      control = run(["display-message", "-p", "-t", pane, "#{@tmux_ide_browser_control}"]).trim();
    } catch {
      return null;
    }
    if (control) return null;
    if (now() >= deadline) return NO_NATIVE_CONTROLS_NOTICE;
    await sleep(250);
  }
}
export function createBrowserPane(
  run: Run,
  executable: string,
  url: string | undefined,
  options: OpenBrowserOptions,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  namespace: Readonly<Record<string, string>>,
): { pane: string; session: string; window: string; status: "created" } {
  validateBrowserOpen(url, options);
  const inheritedPane = /^%\d+$/u.test(environment.TMUX_PANE ?? "")
    ? environment.TMUX_PANE
    : undefined;
  const inheritedServer = /^(.*),(\d+),(\d+)$/u.exec(environment.TMUX ?? "");
  const implicit = !options.pane && !options.session;
  const target =
    options.pane ??
    (options.session
      ? `=${options.session}:`
      : inheritedPane && inheritedServer
        ? `$${inheritedServer[3]}:.${inheritedPane}`
        : undefined);
  if (!target)
    throw new IdeError(
      "Run tmux-ide open inside a tmux pane, or select a session with --session NAME.",
      { code: "BROWSER_TARGET_REQUIRED", exitCode: 2 },
    );
  // Resolve IDs before mutation. No implicit last-used session or window target.
  const identity = run([
    "display-message",
    "-p",
    "-t",
    target,
    "#{session_id}\t#{window_id}\t#{pane_id}\t#{pid}",
  ])
    .trim()
    .split("\t");
  const [session, window, sourcePane, serverPid] = identity;
  if (
    identity.length !== 4 ||
    !/^\$\d+$/u.test(session ?? "") ||
    !/^@\d+$/u.test(window ?? "") ||
    !/^%\d+$/u.test(sourcePane ?? "")
  )
    throw new IdeError("The browser target is no longer available.", {
      code: "BROWSER_TARGET_UNAVAILABLE",
    });
  if (implicit && serverPid !== inheritedServer?.[2])
    throw new IdeError(
      "The current pane belongs to a different tmux server. Select a session explicitly.",
      { code: "BROWSER_TARGET_MISMATCH", exitCode: 2 },
    );
  if (options.session && options.pane) {
    const selected = run([
      "display-message",
      "-p",
      "-t",
      `=${options.session}:`,
      "#{session_id}",
    ]).trim();
    if (selected !== session)
      throw new IdeError("The pane does not belong to the requested session.", {
        code: "BROWSER_TARGET_MISMATCH",
        exitCode: 2,
      });
  }
  const args = options.window
    ? ["new-window", "-t", `${session}:`, "-n", "Browser"]
    : [
        "split-window",
        options.split === "down" ? "-v" : "-h",
        "-t",
        `${session}:${window}.${sourcePane}`,
        "-l",
        `${options.size ?? "50"}%`,
      ];
  args.push("-c", resolve(cwd), "-P", "-F", "#{session_id}\t#{window_id}\t#{pane_id}");
  // tmux supplies the new pane's TMUX and TMUX_PANE. Never copy the caller's
  // native-surface route, which belongs to a different pane.
  const childEnvironment: Record<string, string> = { ...namespace };
  for (const key of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
  ])
    if (environment[key] !== undefined) childEnvironment[key] = environment[key];
  for (const [key, value] of Object.entries(childEnvironment)) args.push("-e", `${key}=${value}`);
  // Multiple command arguments use tmux's direct exec path, not shell parsing.
  args.push(executable, "open", ...(url === undefined ? [] : [url]), "--no-merge");
  const [createdSession, createdWindow, pane] = run(args).trim().split("\t");
  if (
    !/^%\d+$/u.test(pane ?? "") ||
    createdSession !== session ||
    !/^@\d+$/u.test(createdWindow ?? "")
  )
    throw new IdeError("tmux did not return the created browser pane ID.", {
      code: "BROWSER_CREATE_FAILED",
    });
  return { pane: pane!, session: createdSession!, window: createdWindow!, status: "created" };
}

/** Seams for tests; the CLI uses the defaults. */
export interface OpenBrowserDependencies {
  notice?: (line: string) => void;
  executable?: () => string;
  create?: typeof createPinnedBrowserPane;
  wait?: ControlsWait;
}

export async function openBrowser(
  url: string | undefined,
  options: OpenBrowserOptions = {},
  dependencies: OpenBrowserDependencies = {},
) {
  validateBrowserOpen(url, options);
  const executable = (dependencies.executable ?? resolveTerminalBrowser)();
  const { result, run } = (dependencies.create ?? createPinnedBrowserPane)(
    executable,
    url,
    options,
  );
  const message = await nativeControlsNotice(run, result.pane, executable, dependencies.wait);
  if (message)
    (dependencies.notice ?? ((line: string) => process.stderr.write(`${line}\n`)))(message);
  return result;
}

function createPinnedBrowserPane(
  executable: string,
  url: string | undefined,
  options: OpenBrowserOptions,
): { result: ReturnType<typeof createBrowserPane>; run: Run } {
  try {
    const namespace = { ...runtimeNamespaceEnvironment(resolveRuntimeNamespace()) };
    const authority = resolveWorkspacePaneTmuxAuthority();
    namespace.TMUX_IDE_BROWSER_TMUX = authority.executablePath;
    const run = createPinnedWorkspaceTmuxRunner(authority, {
      timeoutMs: 10_000,
    });
    const result = createBrowserPane(
      run,
      executable,
      url,
      options,
      process.env,
      process.cwd(),
      namespace,
    );
    return { result, run };
  } catch (error) {
    if (error instanceof IdeError) throw error;
    throw new IdeError(
      "Could not create the browser pane. Check that the target tmux session is running.",
      {
        code: "BROWSER_CREATE_FAILED",
        cause: error instanceof Error ? error : undefined,
      },
    );
  }
}
