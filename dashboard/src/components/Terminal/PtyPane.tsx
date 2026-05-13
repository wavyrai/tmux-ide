/**
 * PtyPane — renders the active session's FrontendPty into the
 * visible slot (G20-P2).
 *
 * Behaviour:
 *   - `onMount` calls `session.connect(opts)` if the session is
 *     fresh, then mounts the FrontendPty's owned container.
 *   - `onCleanup` calls `pty.unmount()` so the container parks in
 *     the off-screen host. The session + xterm stay alive.
 *   - ResizeObserver fits xterm and calls
 *     `paneSizing.reportDimensions(cols, rows)` so background
 *     sessions catch up.
 *
 * The pane does NOT dispose the session — tab close in
 * `TerminalSurface` calls `releaseSession(id)` for that.
 */

import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { FitAddon } from "@xterm/addon-fit";
import { acquireSession } from "@/lib/pty/sessionPool";
import { usePaneSizingContext } from "@/lib/pty/PaneSizingContext";
import type { FrontendPtyOptions } from "@/lib/pty/FrontendPty";
import { useTerminalSearch } from "@/lib/pty/useTerminalSearch";
import { TerminalSearchOverlay } from "./TerminalSearchOverlay";

interface PtyPaneProps {
  sessionId: string;
  /** Connect options used on first mount (cwd / cmd / initial size). */
  options?: FrontendPtyOptions;
  /** Optional status-line header above the terminal. */
  showHeader?: boolean;
}

export function PtyPane(props: PtyPaneProps) {
  let host!: HTMLDivElement;
  const session = acquireSession(props.sessionId);
  const [statusText, setStatusText] = createSignal<string>(session.status());
  const sizing = usePaneSizingContext();

  const search = useTerminalSearch({
    getTerminal: () => session.pty?.terminal ?? null,
    onCloseFocus: () => {
      try {
        session.pty?.terminal.focus();
      } catch {
        // ignore — disposed terminal
      }
    },
  });

  // Mirror the session's reactive status into our own signal so
  // the header banner re-renders.
  createEffect(() => {
    setStatusText(session.status());
  });

  onMount(() => {
    if (!session.pty) {
      session.connect(props.options ?? {});
    }
    const pty = session.pty;
    if (!pty) return;

    pty.mount(host);

    // ResizeObserver → fit + report dims. We use a fresh FitAddon
    // here rather than reusing FrontendPty's, because FitAddon
    // measures the visible parent — not the off-screen host.
    const localFit = new FitAddon();
    let detached = false;
    try {
      pty.terminal.loadAddon(localFit);
    } catch {
      // ignore; xterm may have one loaded already
    }

    const fitNow = () => {
      if (detached) return;
      try {
        localFit.fit();
        sizing?.reportDimensions(pty.terminal.cols, pty.terminal.rows);
      } catch {
        // ignore — terminal might be transitioning
      }
    };

    const observer = new ResizeObserver(() => fitNow());
    observer.observe(host);
    // Initial fit on the next animation frame so the canvas backing
    // surface has its real dimensions.
    requestAnimationFrame(fitNow);

    // Cmd/Ctrl+F → open search overlay (scoped to this pane).
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        // Only intercept when focus is inside this pane — otherwise
        // we'd hijack the global Cmd-F (palette / browser find).
        const target = e.target as Node | null;
        if (target && host.contains(target)) {
          e.preventDefault();
          search.show();
        }
      }
    };
    host.addEventListener("keydown", onKeyDown, true);

    onCleanup(() => {
      detached = true;
      observer.disconnect();
      host.removeEventListener("keydown", onKeyDown, true);
      try {
        localFit.dispose();
      } catch {
        // ignore
      }
      pty.unmount();
    });
  });

  return (
    <div
      data-testid="v2-pty-pane"
      data-session-id={props.sessionId}
      class="relative flex h-full min-h-0 w-full min-w-0 flex-col bg-[var(--term-bg,#101010)]"
    >
      <Show when={props.showHeader}>
        <div class="flex h-6 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-2 text-[10px] uppercase tracking-wide text-[var(--dim)]">
          <span data-testid="pty-pane-id">{props.sessionId.slice(0, 12)}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="pty-pane-status">{statusText()}</span>
        </div>
      </Show>
      <div
        ref={host}
        data-testid="pty-pane-host"
        class="min-h-0 flex-1"
      />
      <TerminalSearchOverlay handle={search} />
    </div>
  );
}
