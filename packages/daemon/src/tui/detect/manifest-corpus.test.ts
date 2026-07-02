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
