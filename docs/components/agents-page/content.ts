import type { TuiFigureVariant } from "@/components/marketing/tui-mini-figure";

/** Path, title and description of the page; check-agents-page.mjs asserts them in the build. */
export const AGENTS_PAGE = {
  path: "/tmux-for-coding-agents",
  title: "tmux for coding agents: Claude Code, Codex, more",
  description:
    "Run Claude Code, Codex and other coding agents in tmux panes. See each agent's status, jump to the one that needs you, and resume after a crash.",
  eyebrow: "Claude Code, Codex, Aider and other agent CLIs",
  lede: "tmux-ide runs Claude Code, Codex and other coding agents in your tmux sessions, shows each one's live status, and can resume their conversations after a crash.",
} as const;

export interface CommandLine {
  readonly command: string;
  readonly comment?: string;
}

export interface AgentSection {
  readonly id: string;
  readonly index: string;
  readonly eyebrow: string;
  readonly title: string;
  /** Plain text with `code` spans. */
  readonly body: readonly string[];
  readonly commands: readonly CommandLine[];
  readonly links: readonly { readonly label: string; readonly href: string }[];
  readonly figure?: {
    readonly variant: TuiFigureVariant;
    readonly number: string;
    readonly label: string;
  };
}

export const AGENT_SECTIONS: readonly AgentSection[] = [
  {
    id: "claude-code-and-codex-in-tmux",
    index: "01",
    eyebrow: "Claude Code and Codex",
    title: "Run Claude Code and Codex in tmux",
    body: [
      "Start `claude` or `codex` in any tmux pane. tmux-ide finds the agent from the pane's process and screen, so you don't need a config file. Detection is tuned for Claude Code, Codex and Aider, and conservative rules cover other agent CLIs.",
      "tmux keeps owning every process, so closing tmux-ide never stops an agent.",
    ],
    commands: [
      { command: "tmux-ide app" },
      { command: "tmux-ide integration install claude", comment: "exact Claude Code status" },
    ],
    links: [{ label: "Install and run your first agent", href: "/docs/getting-started" }],
    figure: {
      variant: "tmux",
      number: "2",
      label: "Plain tmux / the sessions keep running after the app quits",
    },
  },
  {
    id: "agent-teams",
    index: "02",
    eyebrow: "Agent teams",
    title: "Many agents side by side, Claude Code agent teams included",
    body: [
      "Give each agent its own pane and a name, such as Architect or Reviewer. Group any panes, Claude Code or Codex, into a named team, and hand work between them with `send` and `wait`.",
      "With Claude Code agent teams, each teammate opens in its own split pane. tmux-ide shows it by teammate name, under its team, with live status. Claude Code still runs the team.",
    ],
    commands: [
      { command: 'tmux-ide team assign %2 "Release crew"' },
      { command: 'tmux-ide send %2 "Run the tests"' },
      { command: 'tmux-ide wait output %2 --match "tests passed"' },
    ],
    links: [
      { label: "Multi-agent teams", href: "/docs/multi-agent-teams" },
      { label: "Claude Code agent teams", href: "/docs/claude-code-agent-teams" },
    ],
    figure: {
      variant: "names",
      number: "3",
      label: "Agent names / renaming a pane so the team can refer to it",
    },
  },
  {
    id: "agent-status",
    index: "03",
    eyebrow: "tmux agent status",
    title: "Agent status and attention in the sidebar",
    body: [
      "Every agent pane is working, blocked, done or idle. You see the state on Home, in each pane header and in the sidebar (`F10`). Attention (`F7`) lists the sessions with an agent that needs you.",
      "Claude Code reports its exact state through its hooks integration. Any other agent can report its own with one tmux option, or tmux-ide reads it from the screen. In plain tmux, `tmux-ide adopt <session>` adds status glyphs to the status bar and a sidebar on `prefix b`.",
    ],
    commands: [
      { command: 'tmux set-option -p @agent_state "working:$(date +%s)"' },
      { command: "tmux-ide agent explain %3", comment: "why a pane has its state" },
    ],
    links: [
      { label: "How agent status is detected", href: "/docs/agent-detection" },
      { label: "tmux chrome", href: "/docs/the-dock#agent-sidebar-for-tmux" },
    ],
    figure: {
      variant: "status",
      number: "4",
      label: "Agent status / the sidebar and each pane header",
    },
  },
  {
    id: "restore-and-resume",
    index: "04",
    eyebrow: "Restore and resume",
    title: "Restore sessions and resume agent conversations",
    body: [
      "While the background updater runs, tmux-ide snapshots your sessions about every 30 seconds. After a tmux crash or a reboot, one command rebuilds the windows, split layouts, working directories and pane titles.",
      "With `--resume-agents`, Claude Code, Codex, Cursor CLI and opencode panes reopen their previous conversation. Restore skips a session that is already live under the same name, and it doesn't re-run commands unless you pass `--run-commands`.",
    ],
    commands: [
      { command: "tmux-ide restore --dry-run", comment: "preview the plan" },
      { command: "tmux-ide restore --resume-agents" },
    ],
    links: [{ label: "Restore and resume", href: "/docs/restore-resume" }],
  },
];
