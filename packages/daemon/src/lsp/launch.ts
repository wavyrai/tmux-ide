/**
 * Language-server launch table (G21-P4).
 *
 * The map below lists every language the daemon's LSP service knows
 * how to spawn. Adding a new language is a single-entry change here +
 * a workspace-relative path-extension lookup. The client wires
 * `createLspClient` to this dispatch so the rest of the daemon never
 * names individual servers.
 *
 * Degraded mode: `launchLanguageServer(...)` returns `null` when the
 * server binary can't be resolved on the host. Callers MUST treat
 * `null` as "no-op LSP" — return empty hover / definition / diagnostics
 * — rather than throwing. The user may have a `.py` file in their repo
 * without `pyright-langserver` installed; the language is known, the
 * server isn't, and the agent should keep working.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, extname, join } from "node:path";

export type Language = "typescript" | "python" | "rust" | "go";

export interface LaunchResult {
  process: ChildProcessWithoutNullStreams;
  command: string;
}

/** Per-language launcher metadata. `extensions` drives file → language
 *  routing; `languageId` is the LSP wire's `textDocument/didOpen`
 *  identifier. `resolve` returns either an absolute path or a bare
 *  command name that's expected on PATH — or `null` when neither
 *  resolution path finds the binary (degraded no-op mode). */
export interface LanguageServerConfig {
  language: Language;
  extensions: ReadonlyArray<string>;
  /** Map a per-file extension → LSP `languageId`. Falls back to
   *  `language` itself for the simple 1:1 cases (rust → "rust"). */
  languageIdFor: (file: string) => string;
  /** Args appended after the resolved command. */
  args: ReadonlyArray<string>;
  /** Optional environment variable that overrides the default binary
   *  path. Useful for users with a non-standard install. */
  binaryEnvVar?: string;
  /** Bare binary name to look up on PATH when the env override is
   *  unset and no workspace-local copy is found. */
  defaultBinary: string;
  /** Workspace-local search paths (relative to the workspace root)
   *  to try before falling back to PATH. Each entry is a file path
   *  candidate. Only used when present + executable. */
  workspaceLookups?: ReadonlyArray<string>;
}

const PATH_DELIM = delimiter;

function findOnPath(binary: string): string | null {
  const envPath = process.env.PATH ?? "";
  for (const dir of envPath.split(PATH_DELIM)) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBinary(config: LanguageServerConfig, workspaceRoot: string): string | null {
  const override = config.binaryEnvVar ? process.env[config.binaryEnvVar] : undefined;
  if (override && override.trim().length > 0) {
    return override;
  }
  for (const rel of config.workspaceLookups ?? []) {
    const candidate = join(workspaceRoot, rel);
    if (existsSync(candidate)) return candidate;
  }
  // PATH lookup fallback. `spawn(bareName)` would also find it via the
  // shell's PATH search on POSIX, but resolving first lets us return
  // `null` (degraded mode) without paying the spawn-fail roundtrip.
  return findOnPath(config.defaultBinary);
}

export const LANGUAGE_SERVERS: ReadonlyArray<LanguageServerConfig> = [
  {
    language: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    languageIdFor: (file) => {
      const ext = extname(file).toLowerCase();
      switch (ext) {
        case ".ts":
        case ".mts":
        case ".cts":
          return "typescript";
        case ".tsx":
          return "typescriptreact";
        case ".jsx":
          return "javascriptreact";
        default:
          return "javascript";
      }
    },
    defaultBinary: "typescript-language-server",
    binaryEnvVar: "TMUX_IDE_LSP_TYPESCRIPT",
    args: ["--stdio"],
    workspaceLookups: [join("node_modules", ".bin", "typescript-language-server")],
  },
  {
    language: "python",
    // Pyright's stock LSP id is "python" — same as VS Code. `.pyi` is
    // a stub-only file but pyright handles it under the same id.
    extensions: [".py", ".pyi"],
    languageIdFor: () => "python",
    defaultBinary: "pyright-langserver",
    binaryEnvVar: "TMUX_IDE_LSP_PYRIGHT",
    args: ["--stdio"],
  },
  {
    language: "rust",
    extensions: [".rs"],
    languageIdFor: () => "rust",
    defaultBinary: "rust-analyzer",
    binaryEnvVar: "TMUX_IDE_LSP_RUST_ANALYZER",
    // rust-analyzer reads stdio by default; no args needed.
    args: [],
  },
  {
    language: "go",
    extensions: [".go"],
    languageIdFor: () => "go",
    defaultBinary: "gopls",
    binaryEnvVar: "TMUX_IDE_LSP_GOPLS",
    args: [],
  },
];

const CONFIG_BY_LANGUAGE = new Map<Language, LanguageServerConfig>(
  LANGUAGE_SERVERS.map((c) => [c.language, c]),
);

const CONFIG_BY_EXTENSION = new Map<string, LanguageServerConfig>();
for (const config of LANGUAGE_SERVERS) {
  for (const ext of config.extensions) {
    CONFIG_BY_EXTENSION.set(ext.toLowerCase(), config);
  }
}

export function languageServerConfig(language: Language): LanguageServerConfig {
  const config = CONFIG_BY_LANGUAGE.get(language);
  if (!config) throw new Error(`Unknown LSP language: ${language}`);
  return config;
}

export function languageServerConfigForFile(file: string): LanguageServerConfig | undefined {
  return CONFIG_BY_EXTENSION.get(extname(file).toLowerCase());
}

/** Spawn the language server for `language` rooted at `workspaceRoot`.
 *  Returns `null` when the binary can't be resolved — callers MUST
 *  treat that as the degraded no-op mode (return empty
 *  hover/diagnostics/etc.) rather than throwing. The user might not
 *  have a given language server installed and the agent should keep
 *  going. */
export function launchLanguageServer(
  language: Language,
  workspaceRoot: string,
): LaunchResult | null {
  const config = languageServerConfig(language);
  const resolved = resolveBinary(config, workspaceRoot);
  if (!resolved) return null;
  const proc = spawn(resolved, [...config.args], {
    cwd: workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  }) as ChildProcessWithoutNullStreams;
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    throw new Error(`${config.defaultBinary} stdio pipes unavailable`);
  }
  return { process: proc, command: resolved };
}

// ----------------------------------------------------------------------
// Back-compat — keep the original typescript-only helper exported so
// any downstream code that imported the pre-G21-P4 API keeps working.
// ----------------------------------------------------------------------

export function launchTypescriptLanguageServer(workspaceRoot: string): LaunchResult {
  const result = launchLanguageServer("typescript", workspaceRoot);
  if (!result) {
    throw new Error(
      "typescript-language-server not found. Install it globally (`npm i -g typescript-language-server`) " +
        "or add it to your workspace's devDependencies, or set TMUX_IDE_LSP_TYPESCRIPT to an explicit path.",
    );
  }
  return result;
}
