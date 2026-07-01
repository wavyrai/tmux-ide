/**
 * Bundled detection manifests for known agent commands.
 *
 * These encode CONSERVATIVE, hand-tuned heuristics — the textual evidence
 * seen at the bottom of a pane when an agent is blocked (waiting on input) or
 * working (streaming/spinning). `done` is genuinely hard to read from a single
 * snapshot, so it is left to the classifier's seen-tracking; the rules here
 * stay minimal. Treat every matcher below as a heuristic to tune, not a
 * contract — edit freely as agent UIs change.
 */
import type { AgentManifest } from "./manifest.ts";

// Braille spinner glyphs common to CLI TUIs (claude, codex, ora, …).
const BRAILLE_SPINNER = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

const CLAUDE: AgentManifest = {
  id: "claude",
  commands: ["claude"],
  states: {
    // Approval / confirmation prompts — Claude is waiting on the user.
    blocked: {
      any: [
        { region: "bottom", contains: "Do you want" },
        { region: "bottom", contains: "❯ 1." },
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
        { region: "bottom", contains: "Yes, and" },
      ],
    },
    // Streaming / thinking indicators.
    working: {
      any: [
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        { region: "bottom", contains: "Thinking" },
        { region: "bottom", contains: "Cerebrating" },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
    // done: intentionally omitted — inferred by the classifier's seen-tracking.
  },
};

const CODEX: AgentManifest = {
  id: "codex",
  commands: ["codex"],
  states: {
    blocked: {
      any: [
        { region: "bottom", contains: "Do you want" },
        { region: "bottom", contains: "Allow command", caseInsensitive: true },
        { region: "bottom", contains: "approve", caseInsensitive: true },
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
      ],
    },
    working: {
      any: [
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        { region: "bottom", contains: "Working", caseInsensitive: true },
        { region: "bottom", contains: "Running", caseInsensitive: true },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const SHELL: AgentManifest = {
  id: "shell",
  commands: ["bash", "zsh", "sh", "fish", "nu"],
  states: {
    // Catch-all: a raw shell is almost always idle. We only flag an explicit
    // interactive confirmation as blocked; "working" is unreliable to read
    // from a shell snapshot, so it stays absent (idle by default).
    blocked: {
      any: [
        { region: "bottom", contains: "[y/n]", caseInsensitive: true },
        { region: "bottom", contains: "(yes/no)", caseInsensitive: true },
      ],
    },
  },
};

/** All bundled manifests, in preference order for `pickManifest`. */
export const BUNDLED_MANIFESTS: AgentManifest[] = [CLAUDE, CODEX, SHELL];
