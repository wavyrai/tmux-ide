/**
 * The CLI scene: the three coordination primitives, run for real against a live
 * (staged) fleet.
 *
 *   tmux-ide team --json                              read the fleet's status
 *   tmux-ide send %2 "…"                              task another agent
 *   tmux-ide wait output %2 --match "tests passed"    block until it finishes
 *
 * Click a command and it RUNS: the output is the shape the real CLI prints (the
 * `Sent to "claude" (%2): …` line is send.ts's own format; the JSON is the
 * `FleetJson` shape), and the fleet column on the right reacts — %2 flips to
 * working the moment the message lands, then to done when the match fires. The
 * point is that these aren't three unrelated snippets: they're one loop, and you
 * can watch state move through it.
 *
 * The fleet is staged (no tmux in a browser); the sidebar rendering it is the
 * app's own component.
 */
import { For, createSignal, onCleanup } from "solid-js";
import { Sidebar } from "@daemon/tui/mirror/sidebar.tsx";
import type { AgentRowInput } from "@daemon/tui/mirror/agent-rows.ts";
import type { AgentStatus } from "@daemon/tui/detect/classify.ts";
import {
  ACCENT,
  DEFAULT_BG,
  DEFAULT_FG,
  MUTED,
  SIDEBAR_BG,
  TAB_ACTIVE_BG,
} from "@daemon/tui/mirror/theme.ts";
import { STATUS_COLOR } from "@daemon/tui/mirror/status-grammar.ts";

const SESSION = "checkout-api";
const TERM_W = 84;
const SIDEBAR_W = 30;
const ROWS = 20;

type Line = { text: string; tone: "cmd" | "out" | "dim" | "ok" | "warn" };

interface Step {
  /** The chip label — also the command that runs. */
  cmd: string;
  hint: string;
}

const STEPS: Step[] = [
  { cmd: "tmux-ide team --json", hint: "read the fleet's status" },
  { cmd: 'tmux-ide send %2 "implement /login, then run the tests"', hint: "task another agent" },
  { cmd: 'tmux-ide wait output %2 --match "tests passed"', hint: "block until it finishes" },
];

/**
 * The fleet, as `team --json` prints it — the real FleetJson shape. Kept to 11
 * lines because the terminal only shows ~15: the full pretty-printed payload
 * scrolls its own head off, which reads like the command printed nothing.
 * Objects that fit on one line are collapsed rather than fields being invented
 * away.
 */
function fleetJson(state: AgentStatus): string[] {
  return [
    "{",
    '  "projects": [{',
    `    "name": "${SESSION}",`,
    '    "running": true,',
    `    "status": "${state}",`,
    '    "sessions": [{',
    `      "name": "${SESSION}", "status": "${state}",`,
    '      "agents": [',
    `        { "paneId": "%2", "kind": "claude", "state": "${state}" },`,
    '        { "paneId": "%3", "kind": "codex", "state": "idle" }',
    "      ]}]}]",
    "}",
  ];
}

export function CliScene() {
  const [lines, setLines] = createSignal<Line[]>([
    { text: "# click a command to run it", tone: "dim" },
  ]);
  const [done, setDone] = createSignal<number>(-1);
  const [claude, setClaude] = createSignal<AgentStatus>("idle");
  const [waiting, setWaiting] = createSignal(false);
  const [spin, setSpin] = createSignal(0);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const [since, setSince] = createSignal(nowSec());

  const timers: ReturnType<typeof setTimeout>[] = [];
  const spinner = setInterval(() => setSpin((s) => s + 1), 120);
  onCleanup(() => {
    clearInterval(spinner);
    timers.forEach(clearTimeout);
  });

  const push = (...ls: Line[]) => setLines((prev) => [...prev, ...ls].slice(-(ROWS - 4)));

  const agents = (): AgentRowInput[] => [
    {
      paneId: "%2",
      windowIndex: 0,
      session: SESSION,
      kind: "claude",
      state: claude(),
      since: since(),
      statusText: claude() === "working" ? "implementing /login" : undefined,
    },
    {
      paneId: "%3",
      windowIndex: 0,
      session: SESSION,
      kind: "codex",
      state: "idle",
      since: since(),
    },
  ];

  const run = (i: number) => {
    if (waiting()) return;
    const step = STEPS[i]!;
    push({ text: `$ ${step.cmd}`, tone: "cmd" });

    if (i === 0) {
      push(...fleetJson(claude()).map((text) => ({ text, tone: "out" as const })));
      setDone((d) => Math.max(d, 0));
      return;
    }

    if (i === 1) {
      // send.ts prints exactly this.
      push({ text: '  Sent to "claude" (%2): implement /login, then run the tests', tone: "ok" });
      push({ text: "  → the message is typed into %2; its hooks stamp working", tone: "dim" });
      setSince(nowSec());
      setClaude("working");
      setDone((d) => Math.max(d, 1));
      return;
    }

    // wait output: blocks until the pane's output matches. Here, ~4s of work.
    setWaiting(true);
    push({ text: "  waiting for %2 to print /tests passed/…", tone: "dim" });
    timers.push(
      setTimeout(() => {
        push({ text: "  %2 › tests passed (18 assertions)", tone: "out" });
        push({ text: "  ✓ match — wait exits 0", tone: "ok" });
        setSince(nowSec());
        setClaude("done");
        setWaiting(false);
        setDone(2);
      }, 4000),
    );
  };

  const reset = () => {
    timers.forEach(clearTimeout);
    setWaiting(false);
    setClaude("idle");
    setSince(nowSec());
    setDone(-1);
    setLines([{ text: "# click a command to run it", tone: "dim" }]);
  };

  const toneFg = (tone: Line["tone"]) =>
    tone === "cmd"
      ? ACCENT
      : tone === "ok"
        ? STATUS_COLOR.idle
        : tone === "out"
          ? DEFAULT_FG
          : MUTED;

  const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

  return (
    <box flexDirection="row" backgroundColor={DEFAULT_BG}>
      <box flexDirection="column" width={TERM_W} height={ROWS} paddingLeft={1} overflow="hidden">
        {/* The three commands, as clickable chips — the loop, in order. */}
        <box flexDirection="column">
          <For each={STEPS}>
            {(step, i) => (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={done() >= i() ? TAB_ACTIVE_BG : SIDEBAR_BG}
                onMouse={(e) => {
                  if (e.type === "down") run(i());
                }}
              >
                <text fg={done() >= i() ? STATUS_COLOR.idle : ACCENT}>
                  {done() >= i() ? " ✓ " : ` ${i() + 1} `}
                </text>
                <text fg={DEFAULT_FG}>{step.cmd.slice(0, TERM_W - 30)}</text>
                <box flexGrow={1} />
                <text fg={MUTED}>{`# ${step.hint} `}</text>
              </box>
            )}
          </For>
          <box flexDirection="row" gap={1}>
            <text fg={MUTED} onMouse={(e) => e.type === "down" && reset()}>
              {"   [reset]"}
            </text>
            <text fg={waiting() ? ACCENT : SIDEBAR_BG}>
              {waiting() ? `${SPIN[spin() % SPIN.length]} blocking…` : ""}
            </text>
          </box>
        </box>

        <box height={1} />

        <box flexDirection="column">
          <For each={lines()}>
            {(l) => <text fg={toneFg(l.tone)}>{l.text.slice(0, TERM_W - 2)}</text>}
          </For>
        </box>
      </box>

      {/* The fleet, reacting. The app's own sidebar component. */}
      <Sidebar
        width={SIDEBAR_W}
        sessions={[{ name: SESSION, status: claude() }]}
        agents={agents()}
        current={SESSION}
        nowSec={nowSec()}
        isHovered={() => false}
        flashed={() => false}
        hint={{ pre: "the fleet, ", btn: "live", post: "" }}
      />
    </box>
  );
}
