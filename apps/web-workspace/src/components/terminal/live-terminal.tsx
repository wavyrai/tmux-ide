import {
  createWidgetMarkerByteWatcher,
  detectWidgetMarker,
  type WidgetMarker,
} from "@tmux-ide/contracts";
import {
  readWidgetCellRows,
  WIDGET_SCAN_MAX_ROWS,
} from "../../../../desktop-renderer/src/terminal/widgets/xterm-cell-rows";
import { WidgetRenderer, type WidgetAssetReader } from "../widgets/widget-renderer";
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { Theme } from "@superlogical/shared/themes";
import type { WorkspacePaneCompositor } from "../../../../desktop-renderer/src/terminal/workspace-pane-compositor";
export function LiveTerminal({
  readAsset,
  inputEnabled,
  onInput,
  pane,
  cols,
  rows,
  compositor,
  theme,
  fontSize,
  onCell,
}: {
  readAsset: WidgetAssetReader;
  pane: string;
  inputEnabled: boolean;
  onInput: (bytes: Uint8Array) => void;
  cols: number;
  rows: number;
  compositor: WorkspacePaneCompositor;
  theme: Theme;
  fontSize: number;
  onCell: (value: { width: number; height: number }) => void;
}) {
  const [widget, setWidget] = useState<WidgetMarker | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const currentInput = useRef({ inputEnabled, onInput });
  currentInput.current = { inputEnabled, onInput };
  const mount = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!mount.current) return;
    let disposed = false;
    const pending = new Set<() => void>();
    const watcher = createWidgetMarkerByteWatcher();
    let scanTimer: ReturnType<typeof setTimeout> | null = null;
    let widgetKey = "";
    let hasWidget = false;
    const scheduleWidget = () => {
      if (scanTimer || disposed) return;
      scanTimer = setTimeout(() => {
        scanTimer = null;
        if (disposed) return;
        const marker = detectWidgetMarker(readWidgetCellRows(term, WIDGET_SCAN_MAX_ROWS));
        const key = marker ? JSON.stringify([marker.id, marker.args]) : "";
        hasWidget = marker !== null;
        if (key !== widgetKey) {
          widgetKey = key;
          setWidget(marker);
          setShowTerminal(false);
        }
      }, 40);
    };
    const term = new Terminal({
      cols,
      rows,
      disableStdin: true,
      allowTransparency: true,
      theme: { ...theme.terminal, background: "#00000000" },
      fontFamily: '"Geist Mono Variable", monospace',
      fontSize,
      lineHeight: 1.25,
      scrollback: 0,
      cursorBlink: false,
    });
    terminal.current = term;
    term.open(mount.current);
    const data = term.onData((text) => {
      if (currentInput.current.inputEnabled)
        currentInput.current.onInput(new TextEncoder().encode(text));
    });
    const binary = term.onBinary((text) => {
      if (currentInput.current.inputEnabled)
        currentInput.current.onInput(Uint8Array.from(text, (c) => c.charCodeAt(0)));
    });
    const measure = () => {
      const screen = mount.current?.querySelector(".xterm-screen");
      if (screen) {
        const r = screen.getBoundingClientRect();
        if (r.width && r.height)
          onCell({ width: r.width / term.cols, height: r.height / term.rows });
      }
    };
    const write = (bytes: Uint8Array) =>
      new Promise<void>((resolve) => {
        if (disposed) {
          resolve();
          return;
        }
        const done = () => {
          pending.delete(done);
          resolve();
        };
        pending.add(done);
        const scan = watcher.observe(bytes) || hasWidget;
        term.write(bytes, () => {
          if (scan) scheduleWidget();
          done();
        });
      });
    const unregister = compositor.registerPaneSink(pane, {
      async applySeedBatch(batch) {
        if (disposed) return;
        term.reset();
        if (batch.reset) term.resize(batch.reset.cols, batch.reset.rows);
        const chunks = [batch.seed, ...batch.held];
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        await write(bytes);
        scheduleWidget();
        measure();
      },
      applyGeometry(c, r) {
        if (!disposed) {
          term.resize(c, r);
          measure();
        }
      },
      applyOutput: write,
      applyCursor() {
        /* Canonical ANSI updates already carry the authoritative cursor. */
      },
    });
    const observer = new ResizeObserver(measure);
    observer.observe(mount.current);
    measure();
    return () => {
      disposed = true;
      observer.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
      data.dispose();
      binary.dispose();
      unregister();
      for (const done of pending) done();
      terminal.current = null;
      term.dispose();
    };
  }, [pane, compositor]);
  useEffect(() => {
    if (terminal.current) terminal.current.options.disableStdin = !inputEnabled;
  }, [inputEnabled]);
  useEffect(() => {
    if (terminal.current) {
      terminal.current.options.theme = { ...theme.terminal, background: "#00000000" };
      terminal.current.options.fontSize = fontSize;
    }
  }, [theme, fontSize]);
  return (
    <div className="live-terminal-host" data-slot="terminal-surface" data-widget={widget?.id}>
      <div
        className="live-terminal"
        ref={mount}
        onPointerDown={() => {
          if (currentInput.current.inputEnabled) terminal.current?.focus();
        }}
        aria-label={`Terminal ${pane}`}
      />
      {widget && !showTerminal && (
        <section
          className="live-widget-overlay"
          aria-label={`${widget.id} widget`}
          onMouseUp={(event) => {
            if (
              !(event.target as Element).closest("button,a,input") &&
              document.getSelection()?.isCollapsed &&
              inputEnabled
            )
              terminal.current?.focus();
          }}
        >
          <div className="live-widget-toolbar">
            <span>{widget.id}</span>
            <button
              onClick={() => {
                setShowTerminal(true);
                terminal.current?.focus();
              }}
            >
              Show terminal
            </button>
          </div>
          <div className="live-widget-content">
            <WidgetRenderer
              marker={widget}
              readAsset={readAsset}
              onAction={
                inputEnabled
                  ? (text) => currentInput.current.onInput(new TextEncoder().encode(text))
                  : undefined
              }
            />
          </div>
        </section>
      )}
      {widget && showTerminal && (
        <button className="live-widget-restore" onClick={() => setShowTerminal(false)}>
          Show widget
        </button>
      )}
    </div>
  );
}
