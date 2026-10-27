import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
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
export function resolveTerminalBrowser(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.TMUX_IDE_TERMINAL_BROWSER_BIN;
  const candidates = configured
    ? [configured]
    : (environment.PATH ?? "")
        .split(delimiter)
        .filter(isAbsolute)
        .map((dir) => join(dir, "terminal-browser"));
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

export function openBrowser(url: string | undefined, options: OpenBrowserOptions = {}) {
  validateBrowserOpen(url, options);
  const executable = resolveTerminalBrowser();
  try {
    const namespace = { ...runtimeNamespaceEnvironment(resolveRuntimeNamespace()) };
    const authority = resolveWorkspacePaneTmuxAuthority();
    namespace.TMUX_IDE_BROWSER_TMUX = authority.executablePath;
    const run = createPinnedWorkspaceTmuxRunner(authority, {
      timeoutMs: 10_000,
    });
    return createBrowserPane(run, executable, url, options, process.env, process.cwd(), namespace);
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
