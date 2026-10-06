/**
 * Fixture fleet for the docs demo renders (`pnpm demo:tui`).
 *
 * One local machine with three sessions; the active session runs two agents,
 * a test watcher and a dev server. Names, paths and output are invented but
 * shaped like the real tools so the figure reads as a working day, not a mock.
 */

export type DemoActivity = "running" | "waiting" | "complete" | "idle";
export type DemoStatus = "working" | "blocked" | "done" | "idle";

type Ink = keyof typeof INK;
type Segment = string | readonly [text: string, ink: Ink];

export interface DemoLine {
  readonly segments: readonly (readonly [text: string, ink: Ink | null])[];
  readonly bold?: boolean;
}

/** One terminal line from plain or colored segments. */
function line(...segments: Segment[]): DemoLine {
  return {
    segments: segments.map((segment) =>
      typeof segment === "string" ? ([segment, null] as const) : segment,
    ),
  };
}
const bold = (...segments: Segment[]): DemoLine => ({ ...line(...segments), bold: true });
const blank = line("");

/** Claude Code's rounded welcome box, sized from its widest row. */
function welcomeBox(rows: readonly Segment[][]): DemoLine[] {
  const width = Math.max(
    ...rows.map((row) =>
      row.reduce((sum, part) => sum + [...(typeof part === "string" ? part : part[0])].length, 0),
    ),
  );
  const pad = (row: Segment[]) => {
    const used = row.reduce(
      (sum, part) => sum + [...(typeof part === "string" ? part : part[0])].length,
      0,
    );
    return " ".repeat(width - used + 1);
  };
  return [
    line([`╭${"─".repeat(width + 2)}╮`, "orange"]),
    ...rows.map((row) => line(["│ ", "orange"], ...row, [`${pad(row)}│`, "orange"])),
    line([`╰${"─".repeat(width + 2)}╯`, "orange"]),
  ];
}

export interface DemoPane {
  readonly id: string;
  readonly title: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly agent?: {
    readonly name: string;
    readonly harness: string;
    readonly status: DemoStatus;
    readonly activity: DemoActivity;
    readonly attention: boolean;
  };
  readonly lines: readonly DemoLine[];
}

/** Terminal ink, picked from the dark terminal palette the app projects. */
export const INK = {
  text: 0xdedee6,
  muted: 0x8b8b99,
  faint: 0x5c5c6b,
  accent: 0x62d9e8,
  green: 0x72d49b,
  red: 0xf07178,
  yellow: 0xe6c07b,
  violet: 0xb4a1ff,
  orange: 0xe8925f,
} as const;

export const MACHINE = { id: "local", label: "Local" } as const;
export const ACTIVE_SESSION = "acme-web";
export const WINDOW = { id: "window.agents", name: "agents" } as const;
export const SESSIONS = [
  { name: "acme-web", status: "blocked" as const, panes: 4 },
  { name: "docs-site", status: "done" as const, panes: 2 },
  { name: "infra", status: "idle" as const, panes: 1 },
];

/** A finished agent in another session, so Home shows more than one place. */
export const OTHER_AGENTS = [
  {
    id: "docs-site:claude",
    sessionName: "docs-site",
    paneId: "pane.docs.agent",
    name: "Claude Code",
    harness: "claude",
    activity: "complete" as const,
    attention: false,
  },
];

export const PANES: readonly DemoPane[] = [
  {
    id: "pane.claude",
    title: "claude",
    left: 0,
    top: 0,
    width: 66,
    height: 24,
    agent: {
      name: "Claude Code",
      harness: "claude",
      status: "working",
      activity: "running",
      attention: false,
    },
    lines: [
      ...welcomeBox([
        [["✻", "orange"], " Welcome to Claude Code"],
        [["  cwd: ~/src/acme-web", "muted"]],
      ]),
      blank,
      line(["> Add rate limiting to the /api/upload route", "muted"]),
      blank,
      line("● I'll put a token-bucket limiter in front of the"),
      line("  upload handler and cover it with tests."),
      blank,
      bold(["●", "green"], " Read(src/routes/upload.ts)"),
      line(["  ⎿  Read 84 lines", "muted"]),
      blank,
      bold(["●", "green"], " Update(src/routes/upload.ts)"),
      line(["  ⎿  Updated src/routes/upload.ts with 12 additions", "muted"]),
      blank,
      bold(["●", "green"], " Bash(pnpm vitest run src/routes)"),
      line(["  ⎿  Running…", "muted"]),
      blank,
      line(["✶ Running tests… ", "orange"], ["(12s · esc to interrupt)", "muted"]),
    ],
  },
  {
    id: "pane.codex",
    title: "codex",
    left: 66,
    top: 0,
    width: 66,
    height: 24,
    agent: {
      name: "Codex",
      harness: "codex",
      status: "blocked",
      activity: "waiting",
      attention: true,
    },
    lines: [
      bold(">_ codex  ", ["~/src/acme-web", "muted"]),
      blank,
      line(["› Review the session cookie changes on this branch", "accent"]),
      blank,
      bold("• Explored"),
      line(["  └ Read auth/session.ts, auth/session.test.ts", "muted"]),
      blank,
      line("• The rotation path never clears the old cookie"),
      line("  when `remember` is false. Proposed change:"),
      blank,
      line(["  auth/session.ts", "muted"]),
      line(["  - res.cookie(name, next, opts)", "red"]),
      line(["  + res.clearCookie(name)", "green"]),
      line(["  + res.cookie(name, next, opts)", "green"]),
      blank,
      bold("  Allow Codex to apply this edit?"),
      line(["  › 1. Yes, apply", "accent"]),
      line(["    2. Yes, and don't ask again this session", "muted"]),
      line(["    3. No, tell Codex what to do differently", "muted"]),
    ],
  },
  {
    id: "pane.tests",
    title: "tests",
    left: 0,
    top: 24,
    width: 66,
    height: 16,
    lines: [
      line(["$ pnpm vitest --watch", "muted"]),
      blank,
      line(" ", ["✓", "green"], " src/routes/upload.test.ts (9 tests) ", ["41ms", "muted"]),
      line(" ", ["✓", "green"], " src/auth/session.test.ts (14 tests) ", ["63ms", "muted"]),
      line(" ", ["✓", "green"], " src/lib/rate-limit.test.ts (6 tests) ", ["12ms", "muted"]),
      blank,
      line(" Test Files  ", ["3 passed", "green"], " (3)"),
      line("      Tests  ", ["29 passed", "green"], " (29)"),
      line(["   Duration  812ms", "muted"]),
      blank,
      line(" ", ["PASS", "green"], ["  Waiting for file changes...", "muted"]),
    ],
  },
  {
    id: "pane.dev",
    title: "dev server",
    left: 66,
    top: 24,
    width: 66,
    height: 16,
    lines: [
      line(["$ pnpm dev", "muted"]),
      blank,
      bold("  ▲ Next.js 16.3.0"),
      line("  - Local:   ", ["http://localhost:3000", "accent"]),
      blank,
      line(" ", ["✓", "green"], " Ready in 1.4s"),
      line([" ○ Compiling /api/upload ...", "muted"]),
      line(" ", ["✓", "green"], " Compiled /api/upload in 310ms"),
      line(" GET /dashboard ", ["200", "green"], " in 48ms"),
      line(" POST /api/upload ", ["200", "green"], " in 132ms"),
      line(" POST /api/upload ", ["429", "yellow"], " in 4ms"),
    ],
  },
];
