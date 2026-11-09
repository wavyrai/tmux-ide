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
    details:
      "Features in 1.0: log, include, require, actions, exec, panes, timers, json, store, notify.",
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
    name: "ide.action.register",
    kind: "function",
    signature:
      "ide.action.register{ id, title, run, category?, description?, dangerous?, params? }",
    summary:
      "Offer a named action in the command palette and to `tmux-ide action run plugin.<plugin>.<id>`.",
    details:
      "`run(ctx, args)` runs when the action is invoked; `ctx` has `source` (palette, cli, key…) and, " +
      "when known, `session`, `window` and `pane`. Each param is `{ name, type, label?, description?, " +
      "optional?, pattern?, choices?, default? }`, where type is string, text, number, boolean or choice, " +
      "`pattern` is a Lua pattern, and `choices` and `default` may be functions of `ctx`. Arguments are " +
      "checked before `run` is called. `dangerous = true` makes every caller confirm first. Registering " +
      "an id again replaces it. At most 200 actions per plugin, 32 params per action.",
    errors: ["E_INVALID"],
    example:
      'ide.action.register{ id = "hello", title = "Say hello", params = { { name = "who" } }, ' +
      'run = function(ctx, args) ide.log.info("hello " .. args.who) end }',
    ...v1,
  },
  {
    name: "ide.action.unregister",
    kind: "function",
    signature: "ide.action.unregister(id) -> boolean",
    summary: "Remove an action this plugin registered; false if there was none.",
    ...v1,
  },
  {
    name: "ide.exec",
    kind: "function",
    signature:
      "ide.exec{ cmd, args?, cwd?, env?, stdin?, timeout_ms?, context?, shell? } -> { code, signal, stdout, stderr, timed_out, truncated }",
    summary: "Run a program the manifest lists under capabilities.exec, and wait for it.",
    details:
      "`cmd` is a program name looked up on PATH; `args` are passed as they are, with no shell. " +
      "`shell = true` runs `cmd` as a /bin/sh command line and needs capabilities.shell. " +
      '`context` is a tmux pane id like "%3" (or a pane): the program gets that pane\'s cwd, ' +
      "TMUX and TMUX_PANE. It starts from a minimal environment plus `env`, runs in an OS " +
      "sandbox that cannot write tmux-ide's own files (only ~/.tmux-ide/plugin-data/<plugin>), " +
      "is killed with everything it started after `timeout_ms` (default 30 s, at most 10 min), " +
      "and keeps at most 1 MiB of each output. Output is redacted.",
    errors: ["E_DENIED", "E_INVALID", "E_NOT_FOUND", "E_UNAVAILABLE"],
    example:
      'local r = ide.exec{ cmd = "git", args = { "status", "--short" }, context = ctx.pane }',
    ...v1,
  },
  {
    name: "ide.panes",
    kind: "function",
    signature: "ide.panes{ session?, workspace? } -> { pane… }",
    summary: "The panes tmux-ide manages, as pane objects.",
    details:
      "A pane has `id`, `workspace`, `session` and `title`, and methods `read()`, " +
      '`send(text, { enter = true })`, `split{ dir = "right"|"down", title? }`, `zoom(on?)`, ' +
      "`focus()`, `rename(name)`, `kill()`, `rename_window(name)` and `kill_window()`. They go " +
      "through the same daemon actions and automation API as the app and the CLI.",
    example: 'for _, pane in ipairs(ide.panes{ session = "demo" }) do print(pane.title) end',
    ...v1,
  },
  {
    name: "ide.session",
    kind: "function",
    signature: "ide.session(workspace) -> { rename(name), kill() }",
    summary: "A workspace's tmux session, to rename or kill.",
    ...v1,
  },
  {
    name: "ide.notify",
    kind: "function",
    signature: "ide.notify(text, { level? })",
    summary: "Show a short message (200 characters) in every attached client's status line.",
    ...v1,
  },
  {
    name: "ide.json.encode",
    kind: "function",
    signature: "ide.json.encode(value) -> string",
    summary: "Encode a Lua value as JSON. Tables that contain themselves are refused.",
    ...v1,
  },
  {
    name: "ide.json.decode",
    kind: "function",
    signature: "ide.json.decode(text) -> value",
    summary: "Decode JSON text. null becomes nil.",
    errors: ["E_INVALID"],
    ...v1,
  },
  {
    name: "ide.store.get",
    kind: "function",
    signature: "ide.store.get(key) -> value | nil",
    summary: "Read a value this plugin stored.",
    details: "Each plugin has its own store, kept across restarts: at most 1000 keys and 1 MiB.",
    ...v1,
  },
  {
    name: "ide.store.set",
    kind: "function",
    signature: "ide.store.set(key, value)",
    summary: "Store a JSON-able value under `key`; nil deletes it.",
    errors: ["E_INVALID", "E_LIMIT"],
    ...v1,
  },
  {
    name: "ide.store.delete",
    kind: "function",
    signature: "ide.store.delete(key)",
    summary: "Delete a stored value.",
    ...v1,
  },
  {
    name: "ide.store.keys",
    kind: "function",
    signature: "ide.store.keys() -> { key… }",
    summary: "The stored keys, sorted.",
    ...v1,
  },
  {
    name: "ide.timer.after",
    kind: "function",
    signature: "ide.timer.after(ms, fn) -> { id, cancel() }",
    summary: "Call `fn` once after `ms` milliseconds, under the callback budget.",
    details: "At most 64 timers per plugin. Unloading or reloading the plugin cancels them.",
    ...v1,
  },
  {
    name: "ide.timer.every",
    kind: "function",
    signature: "ide.timer.every(ms, fn) -> { id, cancel() }",
    summary: "Call `fn` every `ms` milliseconds (at least 250).",
    ...v1,
  },
  {
    name: "require",
    kind: "global",
    signature: "require(module) -> value",
    summary: "Load a module once and cache it: `a.b` reads `a/b.lua` or `a/b/init.lua`.",
    details:
      "A plugin searches only its own directory, which its consent covers; `init.lua` searches `~/.tmux-ide/lua/`.",
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
