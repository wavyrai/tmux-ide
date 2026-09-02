export const PANE_DISPLAY_NAME_SOURCES = [
  "manual",
  "agent",
  "process",
  "title",
  "generated",
] as const;

export type PaneDisplayNameSource = (typeof PANE_DISPLAY_NAME_SOURCES)[number];

export interface PaneDisplayName {
  readonly name: string;
  readonly source: PaneDisplayNameSource;
}

const ADJECTIVES = Object.freeze([
  "amber",
  "brave",
  "bright",
  "calm",
  "clever",
  "cosmic",
  "curious",
  "daring",
  "eager",
  "electric",
  "gentle",
  "golden",
  "happy",
  "lively",
  "lucky",
  "merry",
  "nimble",
  "patient",
  "quiet",
  "rapid",
  "shiny",
  "steady",
  "stellar",
  "swift",
  "talented",
  "tidy",
  "vivid",
  "warm",
  "witty",
  "zesty",
]);

const NOUNS = Object.freeze([
  "badger",
  "beacon",
  "comet",
  "condor",
  "coral",
  "dolphin",
  "falcon",
  "fern",
  "firefly",
  "gecko",
  "harbor",
  "heron",
  "jaguar",
  "lantern",
  "lemur",
  "lynx",
  "meteor",
  "nebula",
  "octopus",
  "otter",
  "panda",
  "phoenix",
  "puffin",
  "quasar",
  "raven",
  "redwood",
  "satellite",
  "sparrow",
  "toucan",
  "willow",
]);

const GENERIC_SHELLS = new Set([
  "bash",
  "dash",
  "elvish",
  "fish",
  "ksh",
  "nu",
  "pwsh",
  "sh",
  "tcsh",
  "tmux",
  "xonsh",
  "zsh",
]);

const GENERIC_TITLES = new Set(["shell", "terminal", "tmux"]);

function boundedName(value: string | null | undefined): string | null {
  const name = value?.trim() ?? "";
  return name.length > 0 && name.length <= 80 && !/[\0\r\n\t]/u.test(name) ? name : null;
}

function commandBasename(value: string | null | undefined): string | null {
  const command = boundedName(value);
  if (!command) return null;
  const basename = command.split("/").at(-1)?.trim() ?? "";
  return basename.length > 0 ? basename : null;
}

/** FNV-1a: stable across processes and releases, unlike JS hash implementations. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** A deterministic, memorable fallback. The same semantic pane keeps the same name. */
export function memorablePaneName(seed: string): string {
  const first = stableHash(seed);
  const second = stableHash(`${seed}:noun`);
  return `${ADJECTIVES[first % ADJECTIVES.length]}-${NOUNS[second % NOUNS.length]}`;
}

function meaningfulTitle(
  value: string | null | undefined,
  currentCommand: string | null,
): string | null {
  const title = boundedName(value);
  if (!title || GENERIC_TITLES.has(title.toLowerCase())) return null;
  if (title.startsWith("/") || title.startsWith("~") || title.includes("@")) return null;
  // Interactive shells commonly publish the machine hostname as their tmux
  // title. It identifies the computer, not the work happening in this pane,
  // so keep the memorable pane identity until a real foreground process runs.
  if (
    currentCommand &&
    GENERIC_SHELLS.has(currentCommand.toLowerCase()) &&
    /^[a-z0-9][a-z0-9.-]*\.[a-z0-9-]{2,}$/iu.test(title)
  )
    return null;
  return title;
}

export function resolvePaneDisplayName(
  input: Readonly<{
    semanticPaneId: string;
    configuredName?: string | null;
    configuredNameSource?: string | null;
    currentCommand?: string | null;
    title?: string | null;
    paneType?: string | null;
  }>,
): PaneDisplayName {
  const configuredName = boundedName(input.configuredName);
  const configuredSource = input.configuredNameSource?.trim().toLowerCase() ?? "";
  const generatedName = memorablePaneName(input.semanticPaneId);
  const legacyConfiguredName =
    configuredName &&
    configuredName !== generatedName &&
    !GENERIC_TITLES.has(configuredName.toLowerCase())
      ? configuredName
      : null;

  if (configuredName && configuredSource === "manual")
    return { name: configuredName, source: "manual" };
  if (configuredName && (configuredSource === "agent" || input.paneType === "agent"))
    return { name: configuredName, source: "agent" };
  if (legacyConfiguredName && configuredSource !== "generated")
    return { name: legacyConfiguredName, source: "manual" };

  const command = commandBasename(input.currentCommand);
  if (command && !GENERIC_SHELLS.has(command.toLowerCase()))
    return { name: command, source: "process" };

  const title = meaningfulTitle(input.title, command);
  if (title) return { name: title, source: "title" };

  return {
    name: configuredName && configuredSource === "generated" ? configuredName : generatedName,
    source: "generated",
  };
}
