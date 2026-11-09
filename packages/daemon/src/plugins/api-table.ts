/**
 * The Lua API, described once. `tmux-ide lua api`, `tmux-ide lua describe`
 * and the generated docs read this table, and a test checks that the host's
 * `ide` table has exactly these entries, so the three cannot drift apart.
 */
import { PLUGIN_API_VERSION } from "./protocol.ts";

export type ApiStability = "stable" | "experimental";

export interface ApiEntry {
  /** Dotted Lua name, e.g. `ide.log.info`. */
  readonly name: string;
  readonly kind: "function" | "value" | "global";
  /** Lua-style signature, e.g. `ide.log.info(message, fields?)`. */
  readonly signature: string;
  readonly summary: string;
  readonly details?: string;
  readonly errors?: readonly string[];
  readonly example?: string;
  readonly since: string;
  readonly stability: ApiStability;
}

const v1 = { since: "1.0", stability: "stable" } as const;

const LOG_DETAILS =
  "Writes one line to `~/.tmux-ide/logs/plugins.log` and the daemon's `plugins` log channel, " +
  "tagged with the plugin's name. `fields` is a table encoded as JSON. Each plugin may log " +
  "100 lines per second; extra lines are dropped and counted.";

export const API_ENTRIES: readonly ApiEntry[] = Object.freeze([
  {
    name: "ide.api",
    kind: "value",
    signature: "ide.api",
    summary: `The Lua API version this tmux-ide provides, currently "${PLUGIN_API_VERSION}".`,
    details:
      "Minor versions only add. A plugin declares the versions it works with in its manifest's `api` field.",
    ...v1,
  },
  {
    name: "ide.version",
    kind: "value",
    signature: "ide.version",
    summary: "The tmux-ide version running the script.",
    ...v1,
  },
  {
    name: "ide.plugin.name",
    kind: "value",
    signature: "ide.plugin.name",
    summary:
      'The running plugin\'s name; "init" for ~/.tmux-ide/init.lua, "run" for `tmux-ide lua run`.',
    ...v1,
  },
  {
    name: "ide.settings",
    kind: "value",
    signature: "ide.settings",
    summary: "The plugin's settings: the defaults declared in its manifest.",
    ...v1,
  },
  {
    name: "ide.has",
    kind: "function",
    signature: "ide.has(feature) -> boolean",
    summary:
      "Whether this tmux-ide provides an API feature, so a plugin can degrade without raising its `api` range.",
    details: "Features in 1.0: log, include, require.",
    example: 'if ide.has("include") then ide.include("keys.lua") end',
    ...v1,
  },
  {
    name: "ide.log.debug",
    kind: "function",
    signature: "ide.log.debug(message, fields?)",
    summary: "Log a debug line.",
    details: LOG_DETAILS,
    ...v1,
  },
  {
    name: "ide.log.info",
    kind: "function",
    signature: "ide.log.info(message, fields?)",
    summary: "Log an info line.",
    details: LOG_DETAILS,
    example: 'ide.log.info("loaded", { tasks = 3 })',
    ...v1,
  },
  {
    name: "ide.log.warn",
    kind: "function",
    signature: "ide.log.warn(message, fields?)",
    summary: "Log a warning.",
    details: LOG_DETAILS,
    ...v1,
  },
  {
    name: "ide.log.error",
    kind: "function",
    signature: "ide.log.error(message, fields?)",
    summary: "Log an error.",
    details: LOG_DETAILS,
    ...v1,
  },
  {
    name: "ide.include",
    kind: "function",
    signature: "ide.include(file) -> ...",
    summary: "Run another .lua file and return what it returns.",
    details:
      "`init.lua` includes from `~/.tmux-ide/` and `~/.tmux-ide/lua/`; a plugin includes from its own " +
      "directory. Names must be relative and may not leave those directories. Files over 1 MiB are refused.",
    errors: ["E_INVALID", "E_NOT_FOUND", "E_DENIED"],
    example: 'ide.include("keys.lua")',
    ...v1,
  },
  {
    name: "require",
    kind: "global",
    signature: "require(module) -> value",
    summary: "Load a module once and cache it: `a.b` reads `a/b.lua` or `a/b/init.lua`.",
    details:
      "A plugin searches its own directory, then `~/.tmux-ide/lua/`; `init.lua` searches `~/.tmux-ide/lua/`.",
    errors: ["E_INVALID", "E_NOT_FOUND", "E_DENIED"],
    ...v1,
  },
  {
    name: "print",
    kind: "global",
    signature: "print(...)",
    summary: "Same as ide.log.info with the arguments joined by tabs.",
    ...v1,
  },
  {
    name: "load",
    kind: "global",
    signature: "load(source, name?, mode?, env?) -> function | nil, error",
    summary: "Compile Lua source text. Bytecode and reader functions are refused.",
    ...v1,
  },
] satisfies ApiEntry[]);

/** The `ide.*` names the host must bind (globals are checked separately). */
export function ideTableNames(): string[] {
  return API_ENTRIES.filter((entry) => entry.name.startsWith("ide.")).map((entry) => entry.name);
}

export function findApiEntry(name: string): ApiEntry | undefined {
  return API_ENTRIES.find((entry) => entry.name === name);
}

/** Close matches for an unknown name, for "did you mean" hints. */
export function suggestApiEntries(name: string): ApiEntry[] {
  const needle = name.toLowerCase();
  return API_ENTRIES.filter((entry) => entry.name.toLowerCase().includes(needle)).slice(0, 5);
}
