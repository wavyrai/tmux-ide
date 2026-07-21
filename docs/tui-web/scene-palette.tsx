/**
 * The ⌘K command palette — the app's real one.
 *
 * The action list comes from `staticPaletteActions` and the filtering from
 * `fuzzyFilter`, both imported from packages/daemon: the same subsequence
 * matcher and the same rows the terminal shows, including the matched-character
 * positions the real palette highlights. Type "ses" here and it ranks
 * "Attach session: …" exactly as it does in the app.
 *
 * NOT hijacked: the real ⌘K. This page's search already owns that chord, so the
 * demo opens on a click of its own [⌘K] chip and captures keys only while it has
 * focus (esc releases it). Stealing a browser chord to demo a terminal chord
 * would be a bad trade.
 */
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { staticPaletteActions, type PaletteAction } from "@daemon/tui/mirror/palette.ts";
import { fuzzyFilter } from "@daemon/tui/team/fuzzy.ts";
import type { AgentRowInput } from "@daemon/tui/mirror/agent-rows.ts";
import { ACCENT, DEFAULT_BG, DEFAULT_FG, MUTED, TAB_ACTIVE_BG } from "@daemon/tui/mirror/theme.ts";
import { STATUS_COLOR } from "@daemon/tui/mirror/status-grammar.ts";
import { DEMO_PANEL_BG } from "./demo-theme.ts";

const W = 74;
const ROWS = 9;

const SESSIONS = ["checkout-api", "marketing-site"];

/** A fleet for the palette's agent rows — the same shape the app passes. */
const AGENTS: AgentRowInput[] = [
  {
    paneId: "%2",
    windowIndex: 0,
    session: "checkout-api",
    kind: "claude",
    state: "blocked",
    since: null,
  },
  {
    paneId: "%3",
    windowIndex: 0,
    session: "checkout-api",
    kind: "codex",
    state: "working",
    since: null,
  },
  {
    paneId: "%7",
    windowIndex: 0,
    session: "marketing-site",
    kind: "cursor",
    state: "idle",
    since: null,
  },
];

export function PaletteScene() {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [sel, setSel] = createSignal(0);
  const [ran, setRan] = createSignal<string | null>(null);

  // The app's real action list for this context.
  const actions = createMemo<PaletteAction[]>(() =>
    staticPaletteActions(SESSIONS, {
      terminal: true,
      surface: "terminal",
      agents: AGENTS,
      againName: "claude",
    }),
  );

  /** Rows + the matched-character positions, straight from the app's matcher. */
  const rows = createMemo<{ action: PaletteAction; positions: number[] }[]>(() => {
    const q = query();
    if (!q) return actions().map((action) => ({ action, positions: [] }));
    return fuzzyFilter(q, actions(), (a) => a.label).map((m) => ({
      action: m.item,
      positions: m.positions,
    }));
  });

  const visible = createMemo(() => rows().slice(0, ROWS));

  const onKey = (e: KeyboardEvent) => {
    if (!open()) return;
    if (e.key === "Escape") {
      setOpen(false);
      setQuery("");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, Math.max(0, visible().length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const row = visible()[sel()];
      if (row) {
        setRan(row.action.label);
        setOpen(false);
        setQuery("");
      }
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      setQuery((q) => q.slice(0, -1));
      setSel(0);
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      setQuery((q) => q + e.key);
      setSel(0);
    }
  };

  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  /** Matched characters take the accent — the real palette's own highlight. */
  const Label = (p: { text: string; positions: number[]; selected: boolean }) => (
    <box flexDirection="row">
      <For each={[...p.text]}>
        {(ch, i) => (
          <text
            fg={p.positions.includes(i()) ? ACCENT : p.selected ? DEFAULT_FG : MUTED}
            attributes={p.positions.includes(i()) ? 1 : 0}
          >
            {ch}
          </text>
        )}
      </For>
    </box>
  );

  return (
    <box flexDirection="column" width={W} backgroundColor={DEFAULT_BG}>
      {/* The chip that opens it. The app's chord is ⌘K; on this page the chord
        belongs to the site search, so the demo opens on click. */}
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <text
          fg={open() ? DEFAULT_FG : ACCENT}
          bg={open() ? TAB_ACTIVE_BG : DEMO_PANEL_BG}
          onMouse={(e) => {
            if (e.type !== "down") return;
            setOpen((o) => !o);
            setQuery("");
            setSel(0);
            setRan(null);
          }}
        >
          {open() ? " ⌘K  open — type to filter " : " ⌘K  click to open the palette "}
        </text>
        <Show when={ran()}>
          <text fg={STATUS_COLOR.idle}>{`✓ ran: ${ran()}`}</text>
        </Show>
      </box>

      <box height={1} />

      <Show
        when={open()}
        fallback={
          <box flexDirection="column" paddingLeft={1}>
            <text fg={MUTED}>The palette is every verb in the app, one keystroke away:</text>
            <text fg={MUTED}>switch tabs, attach a session, jump to a blocked agent,</text>
            <text fg={MUTED}>spawn / restart / stop an agent, run a layout, quit.</text>
            <text fg={MUTED}> </text>
            <text fg={MUTED}>Open it and type — the ranking is the app&apos;s own matcher.</text>
          </box>
        }
      >
        <box flexDirection="column" paddingLeft={1}>
          {/* Query line */}
          <box flexDirection="row" backgroundColor={DEMO_PANEL_BG}>
            <text fg={ACCENT}>{"> "}</text>
            <text fg={DEFAULT_FG}>{query() + "▌"}</text>
            <box flexGrow={1} />
            <text fg={MUTED}>{`${rows().length} actions `}</text>
          </box>

          <For each={visible()}>
            {(row, i) => (
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={i() === sel() ? TAB_ACTIVE_BG : DEFAULT_BG}
                onMouse={(e) => {
                  if (e.type === "move") setSel(i());
                  if (e.type === "down") {
                    setRan(row.action.label);
                    setOpen(false);
                    setQuery("");
                  }
                }}
              >
                <text fg={i() === sel() ? ACCENT : DEMO_PANEL_BG}>{i() === sel() ? "›" : " "}</text>
                <Label
                  text={row.action.label.slice(0, W - 6)}
                  positions={row.positions}
                  selected={i() === sel()}
                />
              </box>
            )}
          </For>

          <Show when={visible().length === 0}>
            <text fg={MUTED}> no matches</text>
          </Show>

          <box height={1} />
          <text fg={MUTED}> ↑↓ move · ⏎ run · esc close · type to filter</text>
        </box>
      </Show>
    </box>
  );
}
