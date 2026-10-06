import { INSTALL_COMMAND, SITE_TAGLINE } from "@/lib/site";

/**
 * The hero is one constant so the headline can change in a single place.
 */
export const LANDING_HERO = {
  title: SITE_TAGLINE,
  // The lede leads with one foreground sentence; the rest reads in the muted tone.
  ledeLead:
    "Run and coordinate a team of coding agents, such as Claude Code and Codex, in the tmux sessions you already use.",
  lede: "See what every agent is doing, and jump straight to the one that needs you.",
} as const;

export interface InstallMethod {
  readonly id: "curl" | "npm";
  readonly label: string;
  readonly command: string;
  readonly note: string;
}

/** Only methods the release actually supports (see public/install.sh and the README). */
export const INSTALL_METHODS: readonly InstallMethod[] = [
  {
    id: "curl",
    label: "curl",
    command: INSTALL_COMMAND,
    note: "macOS and glibc Linux. Installs under ~/.local without sudo.",
  },
  {
    id: "npm",
    label: "npm",
    command: "npm install -g tmux-ide",
    note: "Requires Node.js 20 or newer.",
  },
] as const;

export interface LandingFaqItem {
  readonly question: string;
  readonly answer: string;
}

export const LANDING_FAQ: readonly LandingFaqItem[] = [
  {
    question: "What is tmux-ide?",
    answer:
      "tmux-ide is an open-source (MIT) terminal app for running coding agents such as Claude Code and Codex inside ordinary tmux sessions. Home lists every agent across your local and SSH machines and shows which ones are working or need you. Terminals mirrors the live tmux session with clickable windows, pane headers and controls. tmux keeps owning processes, panes and persistence, so closing tmux-ide never stops an agent.",
  },
  {
    question: "Is tmux-ide a new terminal multiplexer?",
    answer:
      "No. tmux remains responsible for processes, PTYs, sessions, windows, panes, and persistence. tmux-ide is a visual, agent-aware control surface for the tmux sessions you already own.",
  },
  {
    question: "What happens when I close tmux-ide?",
    answer:
      "Your work keeps running in tmux. Open tmux-ide again, attach with an ordinary tmux client, or reconnect over SSH and continue from the same durable session.",
  },
  {
    question: "Which coding agents does it recognize?",
    answer:
      "Claude Code, Codex and Aider, with detection tuned on their real output, plus conservative rules for 14 other agent CLIs. Any agent can report its own state with one tmux option, and ordinary shells keep working alongside them.",
  },
  {
    question: "Does it work with Claude Code agent teams?",
    answer:
      "Yes. With teammateMode set to tmux, each teammate opens in its own pane, and tmux-ide groups them under their team with their teammate names and live status. Claude Code still owns the team, tasks and messaging; in-process teammates have no pane of their own.",
  },
  {
    question: "Can I jump directly to a specific agent?",
    answer:
      "Yes. Selecting an agent resolves its exact tmux session, window, and pane, then focuses that pane. The names you give agents and panes make targets easy to identify; routing always uses the exact pane, never the name.",
  },
  {
    question: "Does it work over SSH?",
    answer:
      "Yes. The app and tmux are terminal-native, so the same agents, pane controls, navigation and durable sessions work over SSH, either by running tmux-ide on the remote machine or with `tmux-ide app --ssh <host>`.",
  },
  {
    question: "Can it restore my sessions after the tmux server crashes?",
    answer:
      "Yes. While tmux-ide's background updater runs, which starts once you adopt a session or create one from the app, it snapshots your sessions about every 30 seconds. After a crash, `tmux-ide restore --resume-agents` rebuilds windows, layouts and directories and resumes supported agent conversations, such as Claude Code once `tmux-ide integration install claude` is set up.",
  },
  {
    question: "Do I need a workspace configuration file?",
    answer:
      "No. tmux-ide discovers ordinary live tmux sessions by default. A .tmux-ide/workspace.yml file is optional when you want a repeatable declarative layout.",
  },
] as const;

export const LANDING_AGENT_FEATURES = [
  {
    index: "01",
    eyebrow: "Name",
    title: "Names you can talk about",
    body: "Name an agent when you create it — Architect, Reviewer — or rename any pane from its menu. Unnamed agents show their harness, Claude Code or Codex; other new panes get a memorable fallback such as warm-redwood until a title or running program names them.",
    link: { label: "Coordinate a team of agents", href: "/docs/multi-agent-teams" },
    figure: { number: "02.1", label: "Agent identity / named agents and panes" },
  },
  {
    index: "02",
    eyebrow: "Monitor",
    title: "Live agent indicators",
    body: "Working, blocked, done and idle states appear in the sidebar and pane headers, so a multi-agent workspace stays readable without opening every terminal.",
    link: {
      label: "How agent status is detected",
      href: "/docs/agent-detection#which-agents-are-detected",
    },
    figure: { number: "02.2", label: "Agent state / live indicators" },
  },
  {
    index: "03",
    eyebrow: "Navigate",
    title: "Exact agent-to-pane navigation",
    body: "Click an agent or choose it from the keyboard. tmux-ide resolves the exact session, window, and pane before transferring focus—no scanning a wall of terminals.",
    figure: { number: "02.3", label: "Agent routing / exact pane focus" },
  },
] as const;

export const LANDING_CAPABILITIES = [
  {
    index: "01",
    title: "Create",
    body: "Open clean windows and give agents, panes, and sessions names your team can remember.",
    items: ["new windows", "named agents and panes"],
    visual: "window",
    figure: { number: "05.1", label: "Create / windows and names" },
  },
  {
    index: "02",
    title: "Arrange",
    body: "Split and resize the workspace while the real tmux layout remains the source of truth.",
    items: ["split panes", "pane resize"],
    visual: "resize",
    figure: { number: "05.2", label: "Arrange / splits and resize" },
  },
  {
    index: "03",
    title: "Operate",
    body: "Focus exact agent targets and close panes deliberately without disturbing the session.",
    items: ["precise focus", "explicit close"],
    visual: "focus",
    figure: { number: "05.3", label: "Operate / focus and close" },
  },
] as const;
