/**
 * Bundled detection manifests for known agent commands.
 *
 * These encode CONSERVATIVE, hand-tuned heuristics — the textual evidence
 * seen at the bottom of a pane when an agent is blocked (waiting on input) or
 * working (streaming/spinning). `done` is genuinely hard to read from a single
 * snapshot, so it is left to the classifier's seen-tracking; the rules here
 * stay minimal. Treat every matcher below as a heuristic to tune, not a
 * contract — edit freely as agent UIs change.
 *
 * EVIDENCE PROVENANCE. The `claude` and `codex` manifests are tuned against
 * REAL captured screens (see `manifest-corpus.test.ts` for the sanitized
 * fixtures). Each matcher cites the invariant it was built from ("seen: …").
 * The remaining manifests (`opencode`, `gemini`, `aider`, `copilot`) are
 * best-effort from public docs/common knowledge — every one of their matchers
 * is marked "untuned — needs real captures" and kept HIGH-PRECISION
 * (esc-to-interrupt / spinner / explicit y-n) so they can never false-positive
 * on a plain prompt. Users can override any of these with a JSON file in
 * `~/.tmux-ide/agent-detection/` (see `manifest-loader.ts`).
 */
import type { AgentManifest } from "./manifest.ts";

// Braille spinner glyphs common to CLI TUIs (claude, codex, ora, …). Scoped to
// a single manifest's region, so it can only fire on that agent's pane.
const BRAILLE_SPINNER = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

const CLAUDE: AgentManifest = {
  id: "claude",
  commands: ["claude"],
  states: {
    // Approval / confirmation prompts — Claude is waiting on the user.
    // Claude's approval UI is a bordered box asking a "Do you want …?" question
    // with a numbered arrow menu ("❯ 1. Yes" / "3. No, and tell Claude …").
    // These phrases are approval-specific and never appear in the idle chrome
    // (a bare "❯ " input box) or the "How is Claude doing this session?" survey
    // (which uses "1: Bad" colon-style options, not "❯ 1.").
    blocked: {
      any: [
        // seen (approval dialogs): "Do you want to proceed?" / "Do you want to
        // make this edit to …"
        { region: "bottom", contains: "Do you want" },
        // seen: the highlighted first option of the numbered approval menu.
        { region: "bottom", contains: "❯ 1." },
        // seen: "2. Yes, and don't ask again this session"
        { region: "bottom", contains: "Yes, and" },
        // seen: "3. No, and tell Claude what to do differently"
        { region: "bottom", contains: "No, and tell Claude" },
      ],
    },
    // Streaming / thinking indicators. While Claude works the bottom line shows
    // a spinner + gerund + the interrupt hint, e.g.
    //   "✳ Cerebrating… (esc to interrupt · ctrl+t to hide todos)".
    working: {
      any: [
        // seen: the interrupt hint is present for the entire duration of a turn
        // — the single most reliable "working" invariant.
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        // seen: the animated status verb ("Thinking…", "Cerebrating…").
        { region: "bottom", contains: "Thinking" },
        { region: "bottom", contains: "Cerebrating" },
        // The leading braille spinner glyph, in the body or (rarely) the title.
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
    // done: intentionally omitted — inferred by the classifier's seen-tracking.
    // NOTE (seen, NOT used): idle Claude shows a bordered "❯ " input box with a
    // "⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents" or
    // "? for shortcuts · ← for agents" footer, and finished turns leave a
    // "✻ Brewed for 9s" summary — none of these are working/blocked evidence,
    // so they are deliberately absent and fall through to idle.
  },
};

const CODEX: AgentManifest = {
  id: "codex",
  commands: ["codex"],
  states: {
    blocked: {
      any: [
        // untuned — needs real captures. Codex approval prompts (docs/common
        // knowledge): a command-approval question before running a shell
        // command. Kept high-precision so it can't fire on the idle "›" box.
        { region: "bottom", contains: "Allow command", caseInsensitive: true },
        { region: "bottom", contains: "Do you want" },
        { region: "bottom", contains: "approve", caseInsensitive: true },
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
      ],
    },
    working: {
      any: [
        // untuned for the exact string — Codex shows an elapsed-time working
        // line with an interrupt hint while a turn runs. "esc to interrupt" is
        // the shared CLI-TUI invariant; the spinner is the fallback.
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
    // done: omitted. NOTE (seen, NOT used): idle Codex shows a "›" input prompt
    // and a "gpt-5.5 high · <cwd>            Goal achieved (5m)" status line —
    // "Goal achieved" is a finished/idle marker, not "working", so it is left
    // out (a done rule would collapse to idle in the instant classifier anyway).
  },
};

const OPENCODE: AgentManifest = {
  id: "opencode",
  commands: ["opencode"],
  states: {
    // untuned — needs real captures. High-precision only.
    blocked: {
      any: [
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
        { region: "bottom", contains: "[y/n]", caseInsensitive: true },
        { region: "bottom", contains: "Do you want" },
      ],
    },
    working: {
      any: [
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const GEMINI: AgentManifest = {
  id: "gemini",
  commands: ["gemini"],
  states: {
    // untuned — needs real captures. gemini-cli. High-precision only.
    blocked: {
      any: [
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
        { region: "bottom", contains: "Apply this change", caseInsensitive: true },
        { region: "bottom", contains: "Allow execution", caseInsensitive: true },
      ],
    },
    working: {
      any: [
        // gemini-cli shows an "(esc to cancel)" hint during a turn.
        { region: "bottom", contains: "esc to cancel", caseInsensitive: true },
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const AIDER: AgentManifest = {
  id: "aider",
  commands: ["aider"],
  states: {
    // untuned — needs real captures. aider uses "(Y)es/(N)o" confirmation
    // prompts, which are its most reliable blocked signal.
    blocked: {
      any: [
        { region: "bottom", contains: "(Y)es/(N)o", caseInsensitive: true },
        { region: "bottom", contains: "? [Yes]", caseInsensitive: true },
        { region: "bottom", contains: "Add file to the chat", caseInsensitive: true },
      ],
    },
    // working: aider streams tokens without a stable status line, so we leave
    // it to idle-by-default rather than risk a false positive.
    working: {
      any: [{ region: "bottom", regex: BRAILLE_SPINNER }],
    },
  },
};

const COPILOT: AgentManifest = {
  id: "copilot",
  commands: ["copilot", "github-copilot", "github-copilot-cli"],
  states: {
    // untuned — needs real captures. github-copilot-cli. High-precision only.
    blocked: {
      any: [
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
        { region: "bottom", contains: "Select an option", caseInsensitive: true },
        { region: "bottom", contains: "Allow", caseInsensitive: false },
      ],
    },
    working: {
      any: [
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
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

/**
 * All bundled manifests, in preference order for `pickManifest` and for the
 * tree-walk priority in `resolveAgentCommand` (earlier = higher priority). The
 * `shell` catch-all is intentionally LAST so a real agent that has spawned a
 * transient shell child still resolves to the agent.
 */
export const BUNDLED_MANIFESTS: AgentManifest[] = [
  CLAUDE,
  CODEX,
  OPENCODE,
  GEMINI,
  AIDER,
  COPILOT,
  SHELL,
];
