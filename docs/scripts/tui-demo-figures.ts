/**
 * The nine landing-page mini-figures (Fig. 02.1–04.3). Each is a before/after
 * pair of real app frames: the page's motion queue swaps them while a named
 * cursor performs the action between them.
 */
import { blank, bold, line, type DemoLine, type DemoPane } from "./tui-demo-fixture.ts";
import type { Scene } from "./tui-demo-scene.tsx";

export type FigureVariant =
  | "names"
  | "status"
  | "navigate"
  | "tmux"
  | "daemon"
  | "opentui"
  | "window"
  | "resize"
  | "focus";

/** A frame of the app, or a plain terminal (the app has quit). */
export type FigureFrame = Scene | { readonly shell: readonly DemoLine[] };

type Cell = readonly [column: number, row: number];
export interface FigureCursor {
  readonly kind: "click" | "drag" | "hover";
  readonly from: Cell;
  readonly at: Cell;
  readonly to: Cell;
}

export interface FigureSpec {
  readonly variant: FigureVariant;
  readonly label: string;
  readonly before: FigureFrame;
  readonly after: FigureFrame;
  /** Top-left cell of the CROP_COLS × CROP_ROWS window shown on the page. */
  readonly crop: readonly [column: number, row: number];
  /**
   * How "You" performs the action, in cropped cells: the cursor enters at
   * `from`, acts at `at` (a click or drag press lands as the frame changes),
   * then settles at `to` (a drag's release point).
   */
  readonly cursor: FigureCursor;
}

export const CROP_COLS = 60;
export const CROP_ROWS = 14;
export const APP_COLS = 100;
export const APP_ROWS = 30;
const COLS = APP_COLS;
const ROWS = APP_ROWS;
const SIDEBAR = 28;
const PANE_ROWS = ROWS - 4;
const TOP_ROWS = 13;

type Agent = NonNullable<DemoPane["agent"]>;
type Status = "working" | "done" | "blocked";
const activity = (status: Status) =>
  status === "working" ? "running" : status === "done" ? "complete" : "waiting";
const claude = (status: Status, name = "Claude Code"): Agent => ({
  name,
  harness: "claude",
  status,
  activity: activity(status),
  attention: status === "blocked",
});
const codex = (status: Status, name = "Codex"): Agent => ({
  name,
  harness: "codex",
  status,
  activity: activity(status),
  attention: status === "blocked",
});

const claudeLines = [
  line(["> Add rate limiting to /api/upload", "muted"]),
  blank,
  bold(["●", "green"], " Update(src/routes/upload.ts)"),
  line(["  ⎿  Updated with 12 additions", "muted"]),
  blank,
  line(["✶ Running tests… ", "orange"], ["(esc to interrupt)", "muted"]),
];
const codexLines = [
  bold(">_ codex  ", ["~/src/acme-web", "muted"]),
  blank,
  line(["› Review the session cookie changes", "accent"]),
  blank,
  line("• Rotation never clears the old cookie."),
  bold("  Allow Codex to apply this edit?"),
  line(["  › 1. Yes, apply", "accent"]),
];
const testLines = [
  line(["$ pnpm vitest --watch", "muted"]),
  line(" ", ["✓", "green"], " src/routes/upload.test.ts ", ["(9)", "muted"]),
  line(" ", ["✓", "green"], " src/auth/session.test.ts ", ["(14)", "muted"]),
  line("      Tests  ", ["29 passed", "green"]),
];
const devLines = [
  line(["$ pnpm dev", "muted"]),
  line(" ", ["✓", "green"], " Ready in 1.4s"),
  line(" POST /api/upload ", ["200", "green"], " in 132ms"),
  line(" POST /api/upload ", ["429", "yellow"], " in 4ms"),
];

interface Workspace {
  readonly left?: Agent;
  readonly right?: Agent;
  readonly sidebar?: boolean;
  /** Column of the vertical divider within the pane area. */
  readonly split?: number;
}

/** The figure fleet's four panes, fitted to the pane area. */
function panes({ left = claude("working"), right = codex("working"), sidebar, split }: Workspace) {
  const width = COLS - (sidebar ? SIDEBAR : 0);
  const middle = split ?? Math.floor(width / 2);
  const pane = (
    id: string,
    title: string,
    column: number,
    row: number,
    span: number,
    lines: DemoPane["lines"],
    agent?: Agent,
  ): DemoPane => ({
    id,
    title,
    left: column,
    top: row,
    width: span,
    height: row === 0 ? TOP_ROWS : PANE_ROWS - TOP_ROWS,
    lines,
    agent,
  });
  return [
    pane("pane.claude", "claude", 0, 0, middle, claudeLines, left),
    pane("pane.codex", "codex", middle, 0, width - middle, codexLines, right),
    pane("pane.tests", "tests", 0, TOP_ROWS, middle, testLines),
    pane("pane.dev", "dev server", middle, TOP_ROWS, width - middle, devLines),
  ];
}

const terminals = (workspace: Workspace, scene: Partial<Scene> = {}): Scene => ({
  cols: COLS,
  rows: ROWS,
  surface: "terminals",
  sidebar: workspace.sidebar === true,
  panes: panes(workspace),
  focusedPane: "pane.claude",
  ...scene,
});

/** The app at exactly the crop size, so the figure shows the whole screen. */
function compact(workspace: Workspace, scene: Partial<Scene> = {}): Scene {
  const width = CROP_COLS;
  const height = CROP_ROWS - 4;
  const split = workspace.split ?? Math.floor(width / 2);
  const agentPane = (
    id: string,
    title: string,
    left: number,
    span: number,
    agent: Agent,
    lines: DemoPane["lines"],
  ): DemoPane => ({
    id,
    title,
    left,
    top: 0,
    width: span,
    height,
    agent,
    lines,
  });
  return {
    cols: CROP_COLS,
    rows: CROP_ROWS,
    surface: "terminals",
    sidebar: false,
    panes: [
      agentPane(
        "pane.claude",
        "claude",
        0,
        split,
        workspace.left ?? claude("working"),
        claudeLines,
      ),
      agentPane(
        "pane.codex",
        "codex",
        split,
        width - split,
        workspace.right ?? codex("working"),
        codexLines,
      ),
    ],
    focusedPane: "pane.claude",
    ...scene,
  };
}

/** Only the Codex pane, full width, in the 60×14 app. */
const compactCodex = (agent: Agent, scene: Partial<Scene> = {}): Scene => {
  const base = compact({});
  return {
    ...base,
    panes: [{ ...base.panes![1]!, left: 0, width: CROP_COLS, agent }],
    focusedPane: "pane.codex",
    ...scene,
  };
};

const home = (workspace: Workspace, scene: Partial<Scene> = {}): Scene => ({
  ...terminals(workspace),
  surface: "home",
  ...scene,
});

const shellPane = (title: string, width = COLS, height = PANE_ROWS): DemoPane => ({
  id: "pane.shell",
  title,
  left: 0,
  top: 0,
  width,
  height,
  lines: [line(["~/src/acme-web", "accent"], ["$ ", "muted"])],
  nameSource: "generated",
});

const you = (kind: FigureCursor["kind"], from: Cell, at: Cell, to: Cell): FigureCursor => ({
  kind,
  from,
  at,
  to,
});

export const FIGURES: readonly FigureSpec[] = [
  {
    variant: "names",
    label: "Renaming an agent's pane so the team can refer to it by name",
    before: compactCodex(codex("working"), { rename: { paneId: "pane.codex", value: "Reviewer" } }),
    after: compactCodex(codex("working", "Reviewer")),
    crop: [0, 0],
    cursor: you("click", [40, 12], [9, 8], [12, 2]),
  },
  {
    variant: "status",
    label: "Agent states in the sidebar and in each pane header",
    before: terminals({ sidebar: true }),
    after: terminals({ sidebar: true, left: claude("done"), right: codex("blocked") }),
    crop: [0, 1],
    cursor: you("hover", [40, 9], [3, 3], [6, 3]),
  },
  {
    variant: "navigate",
    label: "Choosing an agent on Home opens its exact pane",
    before: home({ right: codex("blocked") }, { homeSelection: "codex" }),
    after: terminals({ right: codex("blocked") }, { focusedPane: "pane.codex" }),
    crop: [0, 1],
    cursor: you("click", [40, 6], [9, 11], [54, 1]),
  },
  {
    variant: "tmux",
    label: "After the app quits, the same sessions are still running in tmux",
    before: terminals({}),
    after: {
      shell: [
        line(["$ ", "muted"], "tmux ls"),
        line("acme-web: 2 windows (created Mon Oct  5 09:12:44 2026)"),
        line("docs-site: 1 windows (created Mon Oct  5 09:14:02 2026)"),
        line("infra: 1 windows (created Mon Oct  5 11:40:17 2026)"),
        line(["$ ", "muted"], "tmux-ide app"),
      ],
    },
    crop: [0, 0],
    cursor: you("hover", [40, 9], [14, 1], [16, 1]),
  },
  {
    variant: "daemon",
    label: "Daemon-observed agent state across every session on Home",
    before: home({}),
    after: home({ left: claude("done"), right: codex("blocked") }),
    crop: [6, 1],
    cursor: you("hover", [40, 12], [3, 11], [5, 11]),
  },
  {
    variant: "opentui",
    label: "The command palette over agent-aware panes",
    before: compact({ right: codex("blocked") }),
    after: compact({ right: codex("blocked") }, { paletteOpen: true }),
    crop: [0, 0],
    cursor: you("click", [30, 10], [50, 13], [12, 5]),
  },
  {
    variant: "window",
    label: "Adding a window from the window strip",
    // The whole app in a 60×14 terminal (compact chrome): the window tabs
    // and the new-window button only share one view at this size.
    before: compact({}),
    after: compact(
      {},
      {
        windows: ["warm-redwood"],
        activeWindow: 1,
        panes: [shellPane("warm-redwood", CROP_COLS, CROP_ROWS - 4)],
        backgroundPanes: compact({}).panes,
        focusedPane: "pane.shell",
      },
    ),
    crop: [0, 0],
    cursor: you("click", [40, 8], [58, 1], [24, 1]),
  },
  {
    variant: "resize",
    label: "Dragging the divider between two panes",
    before: compact({}),
    after: compact({ split: 40 }),
    crop: [0, 0],
    cursor: you("drag", [30, 10], [30, 6], [40, 6]),
  },
  {
    variant: "focus",
    label: "Moving focus to another pane",
    before: compact({}),
    after: compact({}, { focusedPane: "pane.codex" }),
    crop: [0, 0],
    cursor: you("click", [14, 10], [40, 6], [42, 7]),
  },
];
