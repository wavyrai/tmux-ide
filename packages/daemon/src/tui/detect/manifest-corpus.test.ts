/**
 * Regression corpus — evaluate the bundled manifests against REAL captured
 * screens (sanitized: private paths/prose replaced with generic text; the UI
 * chrome that detection keys on is preserved verbatim).
 *
 * Evidence was captured with `tmux capture-pane -p` from live Claude Code and
 * Codex panes during the M11.3 evidence pass. Working/blocked Claude screens
 * were RECONSTRUCTED from the observed invariants (no pane was mid-turn during
 * the pass, and triggering an approval dialog was out of scope) — they are
 * flagged inline so a future capture can replace them.
 *
 * The second half is the false-positive guard: a table-driven assertion that
 * NO manifest fires on a plain shell prompt, and that every working-capable
 * manifest fires on a synthetic spinner line.
 */
import { describe, expect, it } from "vitest";
import { evaluateManifest, type AgentManifest } from "./manifest.ts";
import { classifyInstant } from "./classify.ts";
import { BUNDLED_MANIFESTS } from "./manifests.ts";
import { parseSnapshot } from "./snapshot.ts";

function byId(id: string): AgentManifest {
  const m = BUNDLED_MANIFESTS.find((x) => x.id === id);
  if (!m) throw new Error(`no manifest ${id}`);
  return m;
}

const claude = byId("claude");
const codex = byId("codex");
const aider = byId("aider");
const cursor = byId("cursor");

// ── Real captured screens ────────────────────────────────────────────────

// REAL (claude, idle) — the bordered "❯ " input box + bypass-permissions
// footer, preceded by the startup MCP warning banner. Captured verbatim.
const CLAUDE_IDLE = `
 ⚠ 2 MCP servers need authentication · run /mcp
 ▎ Fable 5 is back.
 ▎ Until July 7, you can use up to 50% of your plan's weekly usage limit.
──────────────────────────────────────────────
❯
──────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// REAL (claude, idle) — a finished turn: the "✻ Brewed for 9s" past-tense
// summary + the "new task?" hint + the input box. This MUST read idle, not
// working (past-tense summary is not the "esc to interrupt" streaming hint).
const CLAUDE_IDLE_FINISHED = `
⏺ Everything's complete: the change is verified and deployed. No further action needed.
✻ Brewed for 9s
  new task? /clear to save
───────────────────────────────────────────────────
❯
───────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents
`;

// REAL (claude, idle) — the "How is Claude doing this session?" survey renders
// numbered "1: Bad  2: Fine" colon-options above the editor box. This is the
// key false-positive trap: it must NOT be read as a numbered approval menu.
const CLAUDE_SURVEY = `
⏺ Task finished. Reviewing the changes now.
● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss
─────────────────────────────────────────── Editor ──
❯
──────────────────────────────────────────────────────
  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents · ↓ to manage
`;

// REAL (codex, idle) — the "›" prompt + "gpt-5.5 high · <cwd>   Goal achieved
// (5m)" status line. "Goal achieved" is a finished marker, so idle.
const CODEX_IDLE = `
• Posted the research post.

  I also left the local markdown source at context/research.md.
──────────────────────────────────────────────────────────────────
› Summarize recent commits
  gpt-5.5 high · ~/Developer/project                 Goal achieved (5m)
`;

// RECONSTRUCTED (claude, working) — the streaming status line carries the
// spinner + gerund + the "esc to interrupt" hint for the whole turn. Replace
// with a live capture when a pane is caught mid-turn.
const CLAUDE_WORKING = `
⏺ Reading packages/daemon/src/tui/detect/manifest.ts
✳ Cerebrating… (12s · ↑ 3.1k tokens · esc to interrupt · ctrl+t to hide todos)
`;

// RECONSTRUCTED (claude, blocked) — the approval dialog: a "Do you want …?"
// question above a numbered arrow menu ("❯ 1. Yes"). Replace with a live
// capture (triggering one was out of scope for the evidence pass).
const CLAUDE_BLOCKED = `
⏺ I'd like to run: rm -rf ./dist
Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again this session
  3. No, and tell Claude what to do differently (esc)
`;

describe("manifest corpus — real Claude screens", () => {
  it("idle input box → not working/blocked (idle)", () => {
    const snap = parseSnapshot(CLAUDE_IDLE);
    expect(evaluateManifest(snap, claude).state).toBe(null);
    expect(classifyInstant(snap, claude)).toBe("idle");
  });

  it("finished-turn summary (✻ Brewed for 9s) → idle, not working", () => {
    const snap = parseSnapshot(CLAUDE_IDLE_FINISHED);
    expect(classifyInstant(snap, claude)).toBe("idle");
  });

  it("session survey (1: Bad 2: Fine) → idle, NOT a numbered approval", () => {
    const snap = parseSnapshot(CLAUDE_SURVEY);
    expect(evaluateManifest(snap, claude).state).toBe(null);
    expect(classifyInstant(snap, claude)).toBe("idle");
  });

  it("streaming status line (esc to interrupt) → working", () => {
    const snap = parseSnapshot(CLAUDE_WORKING);
    expect(evaluateManifest(snap, claude).state).toBe("working");
    expect(classifyInstant(snap, claude)).toBe("working");
  });

  it("approval dialog (Do you want / ❯ 1.) → blocked", () => {
    const snap = parseSnapshot(CLAUDE_BLOCKED);
    expect(evaluateManifest(snap, claude).state).toBe("blocked");
    expect(classifyInstant(snap, claude)).toBe("blocked");
  });
});

describe("manifest corpus — real Codex screens", () => {
  it("idle › prompt + Goal achieved → idle", () => {
    const snap = parseSnapshot(CODEX_IDLE);
    expect(evaluateManifest(snap, codex).state).toBe(null);
    expect(classifyInstant(snap, codex)).toBe("idle");
  });
});

// ── Real captured Codex screens (codex-cli v0.142.5, driven live) ───────────

// REAL (codex, idle) — the bordered banner + the "›" input box with the "Find
// and fix a bug in @filename" placeholder and the "gpt-5.5 xhigh · <cwd>"
// status line. Captured verbatim after accepting the trust prompt.
const CODEX_IDLE_LIVE = `
╭────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.142.5)                             │
│                                                        │
│ model:     gpt-5.5 xhigh   /model to change            │
│ directory: /Users/dev/project                          │
╰────────────────────────────────────────────────────────╯
  Tip: Try the Codex App. Run 'codex app' or visit https://chatgpt.com/codex
• You have 4 usage limit resets available. Run /usage to use one.
› Find and fix a bug in @filename
  gpt-5.5 xhigh · /Users/dev/project
`;

// REAL (codex, working) — the "• Working (2s • esc to interrupt)" status line
// appears below the submitted prompt while the turn runs. Captured verbatim.
const CODEX_WORKING_LIVE = `
› Write a haiku about tmux, then stop. Do not run any commands.
• Working (2s • esc to interrupt)
› Find and fix a bug in @filename
  gpt-5.5 xhigh · /Users/dev/project
`;

// REAL (codex, blocked) — the command-approval dialog: a "Would you like to run
// the following command?" question, a "$ <cmd>" preview, and a "› 1." numbered
// menu. Captured verbatim (codex launched with `-a untrusted -s read-only`,
// then asked to run a write command). Note the "›" arrow, NOT claude's "❯".
const CODEX_BLOCKED_LIVE = `
• Running touch /tmp/newfile.txt
  Would you like to run the following command?
  Environment: local
  $ touch /tmp/newfile.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`touch /tmp/newfile.txt\` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel
`;

// REAL (codex, blocked) — the directory-trust prompt shown on first launch in
// an untrusted directory. Captured verbatim.
const CODEX_TRUST_LIVE = `
> You are in /Users/dev/project
  Do you trust the contents of this directory? Working with untrusted contents
  comes with higher risk of prompt injection. Trusting the directory allows
  project-local config, hooks, and exec policies to load.
› 1. Yes, continue
  2. No, quit
  Press enter to continue
`;

describe("manifest corpus — real Codex screens (live capture, v0.142.5)", () => {
  it("idle input box (Find and fix a bug placeholder) → idle", () => {
    const snap = parseSnapshot(CODEX_IDLE_LIVE);
    expect(evaluateManifest(snap, codex).state).toBe(null);
    expect(classifyInstant(snap, codex)).toBe("idle");
  });

  it("working status line (• Working (2s • esc to interrupt)) → working", () => {
    const snap = parseSnapshot(CODEX_WORKING_LIVE);
    expect(evaluateManifest(snap, codex).state).toBe("working");
    expect(classifyInstant(snap, codex)).toBe("working");
  });

  it("command-approval dialog (Would you like to run / › 1. Yes) → blocked", () => {
    const snap = parseSnapshot(CODEX_BLOCKED_LIVE);
    expect(evaluateManifest(snap, codex).state).toBe("blocked");
    expect(classifyInstant(snap, codex)).toBe("blocked");
  });

  it("directory-trust prompt (Do you trust the contents) → blocked", () => {
    const snap = parseSnapshot(CODEX_TRUST_LIVE);
    expect(evaluateManifest(snap, codex).state).toBe("blocked");
    expect(classifyInstant(snap, codex)).toBe("blocked");
  });
});

// ── aider screens (tuned from installed source strings, v0.86.2) ────────────

// aider's WaitingSpinner renders "[░█   ] Waiting for <model>" while a turn
// runs (waiting.py + base_coder.py). "Waiting for " is the exact invariant.
const AIDER_WORKING = `
> add a haiku to README
[░█        ] Waiting for gpt-4o
`;

// Every aider confirmation appends " (Y)es/(N)o …[Yes]:" via io.confirm_ask.
const AIDER_BLOCKED_ADD = `
Add file to the chat? (Y)es/(N)o/(A)ll/(S)kip all [Yes]:
`;
const AIDER_BLOCKED_EDIT = `
Allow edits to file that has not been added to the chat? (Y)es/(N)o [Yes]:
`;

// aider idle: the ">" prompt after a finished turn — no spinner, no confirm.
const AIDER_IDLE = `
Tokens: 2.1k sent, 340 received.
main (diff)
>
`;

describe("manifest corpus — aider (source-tuned, v0.86.2)", () => {
  it("WaitingSpinner (Waiting for gpt-4o) → working", () => {
    const snap = parseSnapshot(AIDER_WORKING);
    expect(evaluateManifest(snap, aider).state).toBe("working");
    expect(classifyInstant(snap, aider)).toBe("working");
  });

  it("confirm_ask add-file ((Y)es/(N)o) → blocked", () => {
    const snap = parseSnapshot(AIDER_BLOCKED_ADD);
    expect(evaluateManifest(snap, aider).state).toBe("blocked");
    expect(classifyInstant(snap, aider)).toBe("blocked");
  });

  it("confirm_ask allow-edits → blocked", () => {
    const snap = parseSnapshot(AIDER_BLOCKED_EDIT);
    expect(classifyInstant(snap, aider)).toBe("blocked");
  });

  it("idle > prompt → idle", () => {
    const snap = parseSnapshot(AIDER_IDLE);
    expect(evaluateManifest(snap, aider).state).toBe(null);
    expect(classifyInstant(snap, aider)).toBe("idle");
  });
});

// ── cursor-agent (conservative; real pre-auth screen must read idle) ────────

// REAL (cursor-agent) — the pre-auth splash captured live (no account). This
// MUST read idle: "Cursor Agent" / "Press any key to log in…" is not a working
// or blocked signal.
const CURSOR_PREAUTH = `
                     Cursor Agent
                     v2026.04.30-4edb302
                     Press any key to log in...
`;

describe("manifest corpus — cursor-agent (conservative)", () => {
  it("pre-auth login splash → idle, not working/blocked", () => {
    const snap = parseSnapshot(CURSOR_PREAUTH);
    expect(evaluateManifest(snap, cursor).state).toBe(null);
    expect(classifyInstant(snap, cursor)).toBe("idle");
  });
});

// ── M25.4 breadth — kilo (synthesized from binary-verbatim strings) ─────────

// SYNTHESIZED (kilo, blocked) — assembled from strings extracted VERBATIM from
// the shipped @kilocode/cli binary (v7.4.5): the permission dialog's
// "△ Permission required" header and its "Allow once" / "Allow always" /
// "Reject" options. The layout around them is our reconstruction (no account
// was available to drive a live capture); replace with a real capture when one
// exists.
const KILO_BLOCKED = `
 △ Permission required
   Bash: rm -rf ./dist
 ❯ Allow once
   Allow always
   Reject
`;

// SYNTHESIZED (kilo, idle) — a bare prompt with the documented slash-command
// hint chrome; must NOT read blocked/working.
const KILO_IDLE = `
 Welcome to Kilo Code
 >
 /connect /models /new /status /exit
`;

describe("manifest corpus — kilo (binary-verbatim strings, v7.4.5)", () => {
  const kilo = byId("kilo");

  it("permission dialog (Permission required / Allow once) → blocked", () => {
    const snap = parseSnapshot(KILO_BLOCKED);
    expect(evaluateManifest(snap, kilo).state).toBe("blocked");
    expect(classifyInstant(snap, kilo)).toBe("blocked");
  });

  it("idle prompt chrome → idle", () => {
    const snap = parseSnapshot(KILO_IDLE);
    expect(evaluateManifest(snap, kilo).state).toBe(null);
    expect(classifyInstant(snap, kilo)).toBe("idle");
  });
});

// ── M25.4 breadth — droid (REAL login capture + docs-derived blocked) ───────

// REAL (droid, auth-gated login) — Factory CLI v0.114.1 captured live (no
// account, so this is the only reachable screen). MUST read idle: the login
// menu is not working/blocked evidence. (Also verified live: droid runs as its
// OWN process — `pane_current_command` = "droid".)
const DROID_LOGIN = `
                     v0.114.1 (ctrl+j for changelog)
          TIP: Use /settings to customize your experience
         shift+tab to cycle modes · ctrl+N to cycle models
              ctrl+L for autonomy · tab for reasoning
               Skills (4) ✓  MCPs (0) ✗  AGENTS.md ✗
╭──────────────────────────────────────────────╮
│ Welcome to Factory CLI                        │
╰──────────────────────────────────────────────╯
Please login with your Factory account to continue.
> Login
  Exit
`;

// SYNTHESIZED (droid, blocked) — the Spec-mode proceed menu, assembled from
// the docs-verbatim autonomy-level option labels (docs.factory.ai auto-run).
// Pending live-capture confirmation; replace when an authenticated pane exists.
const DROID_BLOCKED = `
 Ready to proceed with this plan?
 ❯ Proceed, manual approval (Low)
   Proceed, allow safe commands (Medium)
   Proceed, allow all commands (High)
`;

describe("manifest corpus — droid (login captured live, blocked docs-derived)", () => {
  const droid = byId("droid");

  it("auth-gated login menu → idle, not working/blocked", () => {
    const snap = parseSnapshot(DROID_LOGIN);
    expect(evaluateManifest(snap, droid).state).toBe(null);
    expect(classifyInstant(snap, droid)).toBe("idle");
  });

  it("Spec-mode proceed menu (Proceed, manual approval …) → blocked", () => {
    const snap = parseSnapshot(DROID_BLOCKED);
    expect(evaluateManifest(snap, droid).state).toBe("blocked");
    expect(classifyInstant(snap, droid)).toBe("blocked");
  });
});

// ── M25.4 breadth — devin / kimi / pi / grok / kiro / cline ─────────────────
// All SYNTHESIZED from documented output (each fixture's markers are verbatim
// from the agent's own source or docs — see the manifest comments for the
// provenance trail); layout around the markers is our reconstruction.

// devin (docs.devin.ai changelog): the plan-mode approval menu.
const DEVIN_BLOCKED = `
 Plan is ready.
 ❯ Yes, implement plan and accept edits
   Yes, implement plan and bypass permissions
   No, plan needs changes
`;

// kimi (MoonshotAI/kimi-cli _approval_panel.py): the tool-approval panel.
const KIMI_BLOCKED = `
 Bash is requesting approval to run \`rm -rf dist\`
 ❯ Approve once
   Approve for this session
   Reject
   Reject, tell the model what to do instead
`;

// pi (interactive-mode.ts): the literal working status line.
const PI_WORKING = `
> fix the failing test
Working... (esc to interrupt)
`;

// grok (superagent-ai/grok-cli app.tsx + headless output.ts).
const GROK_WORKING = `
⏳ Processing...
Queue a follow-up... (esc to interrupt)
`;

// kiro (aws/amazon-q-developer-cli chat-cli mod.rs): tool approval + spinner.
const KIRO_BLOCKED = `
Using tool: execute_bash
Allow this action? Use 't' to trust (always allow) this tool for the session. [y/n/t]:
`;
const KIRO_WORKING = `
Thinking...
`;

// cline (apps/cli tui components): approval dialog + streaming status.
const CLINE_BLOCKED = `
 Cline needs permission
 Approve tool call?
 write_to_file: src/index.ts
 [y] Approve   [n] deny
`;
const CLINE_WORKING = `
Thinking... (esc to cancel)
`;

describe("manifest corpus — M25.4 breadth (synthesized from documented output)", () => {
  const cases: Array<[string, string, "blocked" | "working"]> = [
    ["devin", DEVIN_BLOCKED, "blocked"],
    ["kimi", KIMI_BLOCKED, "blocked"],
    ["pi", PI_WORKING, "working"],
    ["grok", GROK_WORKING, "working"],
    ["kiro", KIRO_BLOCKED, "blocked"],
    ["kiro", KIRO_WORKING, "working"],
    ["cline", CLINE_BLOCKED, "blocked"],
    ["cline", CLINE_WORKING, "working"],
  ];
  for (const [id, screen, expected] of cases) {
    it(`${id}: documented ${expected} screen → ${expected}`, () => {
      const snap = parseSnapshot(screen);
      expect(evaluateManifest(snap, byId(id)).state).toBe(expected);
      expect(classifyInstant(snap, byId(id))).toBe(expected);
    });
  }

  it("pi ships NO blocked rule — its core has no distinctive approval wording", () => {
    expect(byId("pi").states.blocked).toBeUndefined();
  });
});

// ── M25.4 cross-check — new manifests must stay silent on the OTHER agents'
//    screens (and every manifest on the new agents' idle screens) ───────────

/** Every idle/quiet screen in this corpus — no manifest may fire on ANY of
 *  them (a state on someone else's idle screen is a cross-agent misfire). */
const IDLE_SCREENS: Array<[string, string]> = [
  ["claude idle", CLAUDE_IDLE],
  ["claude finished", CLAUDE_IDLE_FINISHED],
  ["claude survey", CLAUDE_SURVEY],
  ["codex idle", CODEX_IDLE],
  ["codex idle (live)", CODEX_IDLE_LIVE],
  ["aider idle", AIDER_IDLE],
  ["cursor pre-auth", CURSOR_PREAUTH],
  ["droid login", DROID_LOGIN],
  ["kilo idle", KILO_IDLE],
];

/** The M25.4 additions under cross-check. */
const NEW_IDS = ["devin", "kimi", "pi", "grok", "kiro", "cline", "droid", "kilo"];

describe("cross-check — M25.4 manifests never fire on any idle screen", () => {
  for (const id of NEW_IDS) {
    const manifest = byId(id);
    for (const [label, screen] of IDLE_SCREENS) {
      it(`${id} on "${label}" → no state`, () => {
        expect(evaluateManifest(parseSnapshot(screen), manifest).state).toBe(null);
      });
    }
  }

  // And the reverse: NO manifest (old or new) fires on the new agents' idle
  // screens (the new chrome must not read as someone else's evidence).
  for (const manifest of BUNDLED_MANIFESTS) {
    for (const [label, screen] of [
      ["droid login", DROID_LOGIN],
      ["kilo idle", KILO_IDLE],
    ] as const) {
      it(`${manifest.id} on ${label} → no state`, () => {
        expect(evaluateManifest(parseSnapshot(screen), manifest).state).toBe(null);
      });
    }
  }
});

// ── False-positive guard (table-driven, EVERY manifest) ────────────────────

// A realistic idle shell prompt (oh-my-zsh powerline style) + a plain one.
const PLAIN_SHELL = parseSnapshot(
  ["░▒▓   …/project   main $✘!?⇡   v24.2.0   09:25", "user@host ~/project %", "❯"].join("\n"),
);

// A synthetic braille-spinner working line (the shared CLI-TUI invariant).
const SPINNER = parseSnapshot("⠹ doing something (12s)");

describe("false-positive guard — no manifest fires on a plain shell prompt", () => {
  for (const manifest of BUNDLED_MANIFESTS) {
    it(`${manifest.id}: plain prompt → no state`, () => {
      expect(evaluateManifest(PLAIN_SHELL, manifest).state).toBe(null);
    });
  }
});

describe("manifest confidence metadata", () => {
  // The manifests built from real captures / verbatim source strings.
  const TUNED = new Set(["claude", "codex", "aider"]);

  for (const manifest of BUNDLED_MANIFESTS) {
    it(`${manifest.id}: confidence is set and matches its provenance`, () => {
      expect(manifest.confidence).toBeDefined();
      expect(manifest.confidence).toBe(TUNED.has(manifest.id) ? "tuned" : "conservative");
    });
  }

  it("newly added agents are present and conservative", () => {
    for (const id of [
      "cursor",
      "goose",
      "amp",
      // M25.4 breadth:
      "devin",
      "kimi",
      "pi",
      "grok",
      "kiro",
      "cline",
      "droid",
      "kilo",
    ]) {
      const m = BUNDLED_MANIFESTS.find((x) => x.id === id);
      expect(m, `manifest ${id} missing`).toBeDefined();
      expect(m?.confidence).toBe("conservative");
    }
  });
});

describe("working matchers fire on a synthetic spinner line", () => {
  // Every agent manifest declares a spinner working matcher (shell does not —
  // a raw shell has no reliable working signal).
  const spinnerCapable = BUNDLED_MANIFESTS.filter((m) => m.id !== "shell");
  for (const manifest of spinnerCapable) {
    it(`${manifest.id}: spinner → working`, () => {
      expect(evaluateManifest(SPINNER, manifest).state).toBe("working");
    });
  }

  it("shell has no working rule → spinner stays idle", () => {
    expect(evaluateManifest(SPINNER, byId("shell")).state).toBe(null);
  });
});
