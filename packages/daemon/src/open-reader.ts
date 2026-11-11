import { realpathSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { resolveCliCommand } from "./lib/cli-command.ts";
import { IdeError } from "./lib/errors.ts";
import { resolveRuntimeNamespace, runtimeNamespaceEnvironment } from "./lib/runtime-namespace.ts";
import {
  createPinnedWorkspaceTmuxRunner,
  resolveWorkspacePaneTmuxAuthority,
} from "./lib/workspace-pane-creation.ts";
import {
  openPaneArgs,
  resolveOpenPaneTarget,
  validateBrowserOpen,
  type OpenBrowserOptions,
  type Run,
} from "./open-browser.ts";
import { isMarkdownPath } from "./terminal/protocol/reader-option.ts";

export type OpenTarget =
  | { kind: "browser" }
  | {
      kind: "reader";
      /** Absolute real path. */
      path: string;
      /** The path as the user named it, relative to their cwd. */
      display: string;
    };

const SCHEME_URL = /^[a-z][a-z0-9+.-]*:\/\//iu;
const MARKDOWN_ARGUMENT = /\.(?:md|markdown)$/iu;

/**
 * Decides what `tmux-ide open <arg>` opens. A Markdown file name with no
 * `scheme://` is read in the native reader and must exist; everything else
 * goes to the browser exactly as before.
 */
export function classifyOpenTarget(
  arg: string | undefined,
  cwd: string,
  fs: { realpath(path: string): string; isFile(path: string): boolean } = {
    realpath: (path) => realpathSync(path),
    isFile: (path) => statSync(path).isFile(),
  },
): OpenTarget {
  if (arg === undefined || SCHEME_URL.test(arg) || !MARKDOWN_ARGUMENT.test(arg))
    return { kind: "browser" };
  const named = resolve(cwd, arg);
  const display = relative(cwd, named) || named;
  let path: string;
  try {
    path = fs.realpath(named);
    if (!fs.isFile(path)) throw new Error("not a file");
  } catch {
    throw new IdeError(`No Markdown file at ${display}.`, {
      code: "FILE_NOT_FOUND",
      exitCode: 2,
    });
  }
  if (!isMarkdownPath(path))
    throw new IdeError(`${display} does not resolve to a Markdown file.`, {
      code: "NOT_MARKDOWN",
      exitCode: 2,
    });
  return { kind: "reader", path, display };
}

export interface ReaderPaneResult {
  pane: string;
  session: string;
  window: string;
  status: "created";
  kind: "reader";
}

/**
 * Splits a pane running `tmux-ide show <file>` (the TUI renderer, which also
 * watches the file) and stamps `@tmux_ide_reader` with that process's pid,
 * which is what lets the Mac app paint its native reader over the pane.
 */
export function createReaderPane(
  run: Run,
  cli: readonly string[],
  path: string,
  options: OpenBrowserOptions,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  namespace: Readonly<Record<string, string>>,
): ReaderPaneResult {
  validateBrowserOpen(undefined, options);
  const target = resolveOpenPaneTarget(run, options, environment, "READER");
  const args = openPaneArgs(
    target,
    options,
    environment,
    cwd,
    namespace,
    [...cli, "show", path],
    "#{session_id}\t#{window_id}\t#{pane_id}\t#{pane_pid}",
    "Reader",
  );
  const [session, window, pane, pid] = run(args).trim().split("\t");
  if (
    !/^%\d+$/u.test(pane ?? "") ||
    session !== target.session ||
    !/^@\d+$/u.test(window ?? "") ||
    !/^[1-9]\d{0,9}$/u.test(pid ?? "")
  )
    throw new IdeError("tmux did not return the created reader pane.", {
      code: "READER_CREATE_FAILED",
    });
  run([
    "set-option",
    "-p",
    "-t",
    pane!,
    "@tmux_ide_reader",
    JSON.stringify({ version: 1, pid: Number(pid), path }),
  ]);
  return { pane: pane!, session: session!, window: window!, status: "created", kind: "reader" };
}

export async function openReader(
  target: Extract<OpenTarget, { kind: "reader" }>,
  options: OpenBrowserOptions = {},
): Promise<ReaderPaneResult> {
  validateBrowserOpen(undefined, options);
  try {
    const namespace = { ...runtimeNamespaceEnvironment(resolveRuntimeNamespace()) };
    const run = createPinnedWorkspaceTmuxRunner(resolveWorkspacePaneTmuxAuthority(), {
      timeoutMs: 10_000,
    });
    return createReaderPane(
      run,
      resolveCliCommand(),
      target.path,
      options,
      process.env,
      process.cwd(),
      namespace,
    );
  } catch (error) {
    if (error instanceof IdeError) throw error;
    throw new IdeError(
      "Could not create the reader pane. Check that the target tmux session is running.",
      { code: "READER_CREATE_FAILED", cause: error instanceof Error ? error : undefined },
    );
  }
}
