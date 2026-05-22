/**
 * /terminal/:id — Solid port of the standalone terminal route.
 *
 * Renders a single full-window xterm bound to the daemon's PTY at
 * `/ws/pty/:id`. The Solid Terminal host (G16-P2) handles the
 * WebSocket plumbing; this route is just chrome around it.
 */

import { A, useParams } from "@solidjs/router";
import { Terminal } from "@/components/Terminal";

export default function TerminalRoute() {
  const params = useParams<{ id: string }>();
  const id = () => params.id ?? "";

  return (
    <div
      data-testid="v2-terminal-route"
      class="flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex h-7 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 text-sm tabular-nums">
        <A
          href="/"
          class="mr-2 inline-flex items-center gap-1 text-[var(--dim)] hover:text-[var(--fg)]"
        >
          <span aria-hidden="true">◇</span>
          <span>tmux-ide</span>
        </A>
        <span class="mx-1 text-[var(--dimmer)]">/</span>
        <span aria-hidden="true" class="mr-1">
          {">_"}
        </span>
        <span class="font-medium text-[var(--accent)]">terminal</span>
        <span class="mx-2 text-[var(--dimmer)]">·</span>
        <span class="text-[var(--dim)]">{id()}</span>
        <span class="flex-1" />
        <A href="/" class="text-[var(--dim)] hover:text-[var(--fg)]">
          ← back
        </A>
      </header>

      <main class="flex flex-1 min-h-0 flex-col">
        <Terminal id={id()} showHeader={false} />
      </main>

      <footer class="flex h-6 shrink-0 items-center border-t border-[var(--border)] bg-[var(--bg-strong)] px-3 text-xs tabular-nums text-[var(--dim)]">
        <span class="text-[var(--accent)]">terminal</span>
        <span class="mx-2 opacity-30">│</span>
        <span>{id()}</span>
        <span class="flex-1" />
        <span>tmux-ide v2</span>
      </footer>
    </div>
  );
}
