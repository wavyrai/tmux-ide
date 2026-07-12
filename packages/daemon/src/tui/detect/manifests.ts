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
 * EVIDENCE PROVENANCE (per-manifest `confidence`):
 *   - `tuned` — built from REAL captured screens or the agent's own source
 *     strings. `claude`, `codex`, and `aider` are tuned: codex from live
 *     `tmux capture-pane` frames driven through a real turn (idle / working /
 *     command-approval / trust prompt), aider from the verbatim prompt strings
 *     in its installed source (`io.py` confirm_ask, `waiting.py` spinner).
 *     Each matcher cites the invariant it was built from ("seen: …").
 *   - `conservative` — best-effort from public docs/common knowledge
 *     (`opencode`, `gemini`, `copilot`, `cursor`, `goose`, `amp`, and the
 *     M25.4 breadth set: `devin`, `kimi`, `pi`, `grok`, `kiro`, `cline`,
 *     `droid`, `kilo`). Every matcher is HIGH-PRECISION (esc-to-interrupt /
 *     spinner / explicit y-n / "Do you want") so it can never false-positive
 *     on a plain prompt, but it may miss real states until a live capture
 *     upgrades it. `opencode` was attempted live but its local auth DB errored
 *     and the TUI rendered blank, so it stays conservative. Several M25.4
 *     manifests carry source/binary-VERBATIM markers (see each manifest's
 *     provenance comment) but stay conservative until a live capture confirms
 *     the surrounding chrome.
 *
 * Users can override any of these with a JSON file in
 * `~/.tmux-ide/agent-detection/` (see `manifest-loader.ts`).
 */
import type { AgentManifest } from "./manifest.ts";

// Braille spinner glyphs common to CLI TUIs (claude, codex, ora, …). Scoped to
// a single manifest's region, so it can only fire on that agent's pane.
const BRAILLE_SPINNER = "[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]";

const CLAUDE: AgentManifest = {
  id: "claude",
  commands: ["claude"],
  confidence: "tuned",
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
  commands: ["codex", "codex.exe"],
  confidence: "tuned",
  states: {
    // TUNED against real captures (codex-cli v0.142.5, driven through a turn).
    // The command-approval dialog and the directory-trust prompt are the two
    // "blocked" screens. Codex's approval menu uses a "› 1." numbered arrow —
    // note the arrow is "›" (U+203A), NOT claude's "❯".
    blocked: {
      any: [
        // seen (command approval): "Would you like to run the following
        // command?" above a "$ <cmd>" preview and the numbered menu.
        { region: "bottom", contains: "Would you like to run", caseInsensitive: true },
        // seen: the highlighted approval option "› 1. Yes, proceed".
        { region: "bottom", contains: "Yes, proceed" },
        // seen: "3. No, and tell Codex what to do differently (esc)".
        { region: "bottom", contains: "No, and tell Codex" },
        // seen: the confirm footer under the approval menu.
        { region: "bottom", contains: "Press enter to confirm", caseInsensitive: true },
        // seen (directory-trust prompt on first launch in an untrusted dir):
        // "Do you trust the contents of this directory?" + "1. Yes, continue".
        { region: "bottom", contains: "Do you trust the contents", caseInsensitive: true },
      ],
    },
    working: {
      any: [
        // seen (verbatim): the working status line is
        //   "• Working (6s • esc to interrupt)".
        // Both the "Working (" prefix and the shared "esc to interrupt" hint
        // are present for the whole turn.
        { region: "bottom", regex: "Working \\(\\d" },
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
    // done: omitted. NOTE (seen, NOT used): a finished turn leaves the agent's
    // answer above the idle "›" input box (placeholder "Find and fix a bug in
    // @filename") and a "gpt-5.5 xhigh · <cwd>" status line; older builds also
    // showed "Goal achieved (5m)". None are working/blocked evidence, so codex
    // correctly falls through to idle and the classifier infers done.
  },
};

const OPENCODE: AgentManifest = {
  id: "opencode",
  commands: ["opencode", "opencode.exe"],
  confidence: "conservative",
  states: {
    // conservative — a live capture was attempted (opencode v1.17.10) but its
    // local auth DB errored ("no such column: name") and the TUI rendered
    // blank, so these stay best-effort. High-precision only.
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
  confidence: "conservative",
  states: {
    // conservative — gemini-cli needs a Google account/API key to reach a
    // working state, so no live capture was taken. High-precision only.
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
  confidence: "tuned",
  states: {
    // TUNED from aider's installed source (v0.86.2). Every confirmation renders
    // through `io.confirm_ask` (io.py), which appends the literal option string
    // " (Y)es/(N)o" (plus "/(A)ll/(S)kip all" or "/(D)on't ask again") and a
    // "[Yes]:"/"[No]:" default — so "(Y)es/(N)o" is aider's exact, universal
    // blocked marker. The specific questions below are verbatim from
    // base_coder.py / commands.py.
    blocked: {
      any: [
        { region: "bottom", contains: "(Y)es/(N)o", caseInsensitive: true },
        { region: "bottom", contains: "Add file to the chat", caseInsensitive: true },
        { region: "bottom", contains: "Allow edits to file", caseInsensitive: true },
        { region: "bottom", contains: "Add command output to the chat", caseInsensitive: true },
        { region: "bottom", contains: "Run pip install", caseInsensitive: true },
      ],
    },
    // TUNED: while a turn runs aider shows a `WaitingSpinner` (waiting.py)
    // rendered as "[░█   ] Waiting for <model>" — the text is literally
    // "Waiting for LLM" or "Waiting for " + the model name (base_coder.py:1440).
    // aider's spinner uses a "░█" scanner, NOT braille, so "Waiting for " is the
    // real invariant; the braille probe is kept only as a harmless fallback.
    working: {
      any: [
        { region: "bottom", contains: "Waiting for ", caseInsensitive: false },
        { region: "bottom", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const COPILOT: AgentManifest = {
  id: "copilot",
  commands: ["copilot", "github-copilot", "github-copilot-cli"],
  confidence: "conservative",
  states: {
    // conservative — github-copilot-cli needs a GitHub account, so no live
    // capture was taken. High-precision only.
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

const CURSOR: AgentManifest = {
  id: "cursor",
  commands: ["cursor-agent", "cursor"],
  confidence: "conservative",
  states: {
    // conservative — cursor-agent (Cursor CLI) was launched live but sits on a
    // "Press any key to log in…" pre-auth screen without an account, so no
    // working/blocked turn could be captured. The pre-auth splash ("Cursor
    // Agent" / "Press any key to log in") is idle chrome and deliberately NOT
    // matched here. Markers below are high-precision guesses from public
    // knowledge of its approval/streaming UI. NOTE: cursor-agent runs under
    // `node`, so it resolves via the process-tree (argv0 basename), not the
    // pane's `current_command`.
    blocked: {
      any: [
        { region: "bottom", contains: "Do you want", caseInsensitive: false },
        { region: "bottom", contains: "Run this command", caseInsensitive: true },
        { region: "bottom", contains: "Apply this edit", caseInsensitive: true },
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
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

const GOOSE: AgentManifest = {
  id: "goose",
  commands: ["goose"],
  confidence: "conservative",
  states: {
    // conservative — Block's goose CLI needs a configured provider, so no live
    // capture was taken. High-precision only; markers are best-effort from
    // public knowledge of its confirmation/streaming UI.
    blocked: {
      any: [
        { region: "bottom", contains: "Do you want", caseInsensitive: false },
        { region: "bottom", contains: "Allow this tool", caseInsensitive: true },
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
        { region: "bottom", contains: "[y/n]", caseInsensitive: true },
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

const AMP: AgentManifest = {
  id: "amp",
  commands: ["amp"],
  confidence: "conservative",
  states: {
    // conservative — Sourcegraph's amp CLI needs an account, so no live capture
    // was taken. High-precision only; markers are best-effort from public
    // knowledge of its approval/streaming UI.
    blocked: {
      any: [
        { region: "bottom", contains: "Do you want", caseInsensitive: false },
        { region: "bottom", contains: "Allow", caseInsensitive: false },
        { region: "bottom", contains: "(y/n)", caseInsensitive: true },
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

const DEVIN: AgentManifest = {
  id: "devin",
  commands: ["devin"],
  confidence: "conservative",
  states: {
    // conservative — Devin CLI (Cognition; closed-source native Rust binary,
    // needs an account). Blocked markers are VERBATIM from docs.devin.ai
    // (cli/changelog + essential-commands via llms-full.txt): the plan-mode
    // approval menu and the always-allow option. Devin has NO verified working
    // text (its spinner is unlabeled; docs say interrupt is Ctrl+C, not esc),
    // so working keeps only the shared spinner probe.
    blocked: {
      any: [
        // seen (docs): "Yes, implement plan and accept edits" / "…and bypass
        // permissions" — the shared prefix covers both.
        { region: "bottom", contains: "Yes, implement plan and" },
        { region: "bottom", contains: "No, plan needs changes" },
        { region: "bottom", contains: "Yes, always allow" },
      ],
    },
    working: {
      any: [
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const KIMI: AgentManifest = {
  id: "kimi",
  commands: ["kimi"],
  confidence: "conservative",
  states: {
    // conservative — kimi CLI (MoonshotAI/kimi-cli, Python/prompt_toolkit).
    // Blocked markers are VERBATIM from its source (_approval_panel.py): the
    // approval panel's "<tool> is requesting approval to …" header and its
    // option labels. Its working spinner is a text-less moon animation (not
    // braille), so working may under-detect until tuned — the braille probe is
    // kept only as the shared fallback. ("Thinking"/"Thought for" deliberately
    // NOT matched: they persist in the transcript after the turn.)
    blocked: {
      any: [
        { region: "bottom", contains: " is requesting approval to " },
        { region: "bottom", contains: "Approve for this session" },
        { region: "bottom", contains: "Reject, tell the model" },
      ],
    },
    working: {
      any: [
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const PI: AgentManifest = {
  id: "pi",
  commands: ["pi"],
  confidence: "conservative",
  states: {
    // conservative — pi (@mariozechner/pi-coding-agent, node). Working marker
    // is VERBATIM from its source (interactive-mode.ts): the status line is
    // `Working... (esc to interrupt)`, with `(esc to cancel)` retry/compacting
    // variants. Its core has NO distinctive approval wording (generic Yes/No
    // via extensions), so blocked is deliberately ABSENT — authority
    // self-reporting or the classifier's fallback carry it.
    working: {
      any: [
        { region: "bottom", contains: "Working... (esc to interrupt)" },
        { region: "bottom", contains: "(esc to cancel)" },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const GROK: AgentManifest = {
  id: "grok",
  commands: ["grok"],
  confidence: "conservative",
  states: {
    // conservative — the community grok CLI (@vibe-kit/grok-cli /
    // superagent-ai/grok-cli, node/OpenTUI). Working markers are VERBATIM from
    // its source (app.tsx / headless output.ts): the mid-turn placeholder
    // carries "(esc to interrupt)" and headless prints "⏳ Processing...".
    // Its ConfirmationDialog wording could not be verified, so blocked keeps
    // only a high-precision generic. NOTE: xAI's separate official
    // `grok-build` binary substring-matches this manifest but has no verified
    // strings — it will simply read idle until evidence exists.
    blocked: {
      any: [{ region: "bottom", contains: "(y/n)", caseInsensitive: true }],
    },
    working: {
      any: [
        { region: "bottom", contains: "esc to interrupt", caseInsensitive: true },
        { region: "bottom", contains: "⏳ Processing" },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const KIRO: AgentManifest = {
  id: "kiro",
  commands: ["kiro-cli", "kiro"],
  confidence: "conservative",
  states: {
    // conservative — Kiro CLI (AWS; the rebranded Amazon Q Developer CLI, a
    // native Rust binary). Markers are VERBATIM from the open-source
    // predecessor (aws/amazon-q-developer-cli chat-cli/src/cli/chat/mod.rs):
    // the tool-approval question and the Spinners::Dots "Thinking..." status.
    // The closed Kiro build may drift — same lineage, pending live capture.
    // NOTE: the predecessor's 1-char `q` binary is deliberately NOT a command
    // token (a single letter substring-matches far too much).
    blocked: {
      any: [
        { region: "bottom", contains: "Allow this action?" },
        { region: "bottom", contains: "to trust (always allow) this tool" },
      ],
    },
    working: {
      any: [
        { region: "bottom", contains: "Thinking..." },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const CLINE: AgentManifest = {
  id: "cline",
  commands: ["cline"],
  confidence: "conservative",
  states: {
    // conservative — cline CLI (cline.bot; CLI 2.0 ships prebuilt platform
    // binaries, OpenTUI). Markers are VERBATIM from its source: the approval
    // dialog's "Cline needs permission" title + "Approve tool call?" header
    // (tui/components/dialogs/tool-approval.tsx) and the streaming
    // "Thinking... (esc to cancel)" status (chat-message-list.tsx).
    blocked: {
      any: [
        { region: "bottom", contains: "Cline needs permission" },
        { region: "bottom", contains: "Approve tool call?" },
        { region: "bottom", contains: "[y] Approve" },
      ],
    },
    working: {
      any: [
        { region: "bottom", contains: "esc to cancel", caseInsensitive: true },
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const DROID: AgentManifest = {
  id: "droid",
  commands: ["droid"],
  confidence: "conservative",
  states: {
    // conservative — droid (Factory CLI) was launched live (v0.114.1) but sits
    // on an auth-gated login menu without a Factory account, so only the login
    // splash could be captured (it reads IDLE and is deliberately not matched:
    // "Please login with your Factory account to continue." / "> Login").
    // Verified live: droid runs as its OWN process (`pane_current_command` =
    // "droid"), so command matching needs no process-tree help.
    // Blocked markers are docs-derived (docs.factory.ai auto-run levels,
    // corroborated third-party walkthrough) — the Spec-mode proceed menu names
    // its autonomy levels verbatim. Pending live-capture confirmation.
    blocked: {
      any: [
        { region: "bottom", contains: "Proceed, manual approval" },
        { region: "bottom", contains: "Proceed, allow safe commands" },
        { region: "bottom", contains: "Proceed, allow all commands" },
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

const KILO: AgentManifest = {
  id: "kilo",
  commands: ["kilo", ".kilo", "kilocode"],
  confidence: "conservative",
  states: {
    // conservative, but the blocked markers are VERBATIM from the shipped
    // @kilocode/cli binary (v7.4.5, strings-extracted — no account to drive a
    // live capture): the permission dialog renders a "△ Permission required"
    // header over an "Allow once" / "Allow always" / "Reject" option list.
    // NOTE: the CLI's npm launcher (`bin/kilo`, node) execs the platform
    // binary installed as `bin/.kilo`, hence the ".kilo" command token.
    blocked: {
      any: [
        { region: "bottom", contains: "Permission required" },
        { region: "bottom", contains: "Allow once" },
        { region: "bottom", contains: "Allow always" },
      ],
    },
    // No working-state string was found in the binary (its status UI renders
    // from dynamic parts) — only the shared spinner probe, so kilo may read
    // idle while working until a live capture tunes it.
    working: {
      any: [
        { region: "bottom", regex: BRAILLE_SPINNER },
        { region: "title", regex: BRAILLE_SPINNER },
      ],
    },
  },
};

const SHELL: AgentManifest = {
  id: "shell",
  commands: ["bash", "zsh", "sh", "fish", "nu"],
  confidence: "conservative",
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
  CURSOR,
  GOOSE,
  AMP,
  DEVIN,
  KIMI,
  PI,
  GROK,
  KIRO,
  CLINE,
  DROID,
  KILO,
  SHELL,
];
