export interface LandingFaqItem {
  readonly question: string;
  readonly answer: string;
}

export const LANDING_FAQ: readonly LandingFaqItem[] = [
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
      "The OpenTUI is designed to recognize major coding-agent processes and project their live state into agent-aware pane chrome and the workspace sidebar. Ordinary shells and terminal programs continue to work alongside them.",
  },
  {
    question: "Can I jump directly to a specific agent?",
    answer:
      "Yes. Selecting an agent resolves its exact tmux session, window, and pane, then focuses that pane. Memorable automatic names make the same targets easier to identify and discuss.",
  },
  {
    question: "Does it work over SSH?",
    answer:
      "Yes. The OpenTUI and tmux are terminal-native, so the same agent workspace, pane controls, navigation, and durable sessions remain available over SSH.",
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
    title: "Memorable names instead of pane IDs",
    body: "New agents and panes get human names such as talented-toucan and warm-redwood. Rename them at any time, then use those names when people and agents coordinate work.",
    figure: { number: "02.1", label: "Agent identity / memorable naming" },
  },
  {
    index: "02",
    eyebrow: "Monitor",
    title: "Live agent indicators",
    body: "Working, idle, attention, and done states appear in the sidebar and pane chrome, so a multi-agent workspace remains readable without opening every terminal.",
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
    items: ["new windows", "memorable names"],
    visual: "window",
    figure: { number: "04.1", label: "Create / windows and names" },
  },
  {
    index: "02",
    title: "Arrange",
    body: "Split and resize the workspace while the real tmux layout remains the source of truth.",
    items: ["split panes", "coherent resize"],
    visual: "resize",
    figure: { number: "04.2", label: "Arrange / splits and resize" },
  },
  {
    index: "03",
    title: "Operate",
    body: "Focus exact agent targets and close panes deliberately without disturbing the session.",
    items: ["precise focus", "explicit close"],
    visual: "focus",
    figure: { number: "04.3", label: "Operate / focus and close" },
  },
] as const;

export const LANDING_ARCHITECTURE = [
  {
    owner: "tmux",
    responsibility: "processes · PTYs · sessions · windows · panes",
    outcome: "The durable source of truth",
    figure: { number: "03.1", label: "tmux / durable process ownership" },
  },
  {
    owner: "tmux-ide daemon",
    responsibility: "discovery · lifecycle · agent state · pane streams",
    outcome: "A coherent workspace model",
    figure: { number: "03.2", label: "Daemon / coherent workspace projection" },
  },
  {
    owner: "OpenTUI",
    responsibility: "navigation · agent chrome · controls · input",
    outcome: "The interface you operate",
    figure: { number: "03.3", label: "OpenTUI / agent-aware control surface" },
  },
] as const;
