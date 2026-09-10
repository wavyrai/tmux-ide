import { Input } from "@base-ui/react/input";
import * as stylex from "@stylexjs/stylex";
import type { Pane } from "@superlogical/shared/model";
import type { Theme } from "@superlogical/shared/themes";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Terminal } from "@xterm/xterm";
import { AnimatePresence, motion } from "motion/react";
import { memo, useEffect, useRef, useState } from "react";
import { socketUrl } from "./client";
import { ChevronDown, ChevronUp, Columns2, RotateCcw, Rows2, X } from "./icons";
import { spring, useReducedMotion } from "./motion";
import { PaneAgentIndicators } from "./pane-agent-indicators";
import { PaneHeading } from "./pane-heading";
import { s } from "./styles";
import { terminalHandles } from "./terminal-handles";
import { type Scrollback, TerminalScrollbar } from "./terminal-scrollbar";
import { Button } from "./ui/button";

function canFocusTerminal() {
  return !(
    document.querySelector('[role="dialog"]') ||
    document.activeElement?.closest(
      'button, [role="tab"], [role="scrollbar"], [role="separator"], input',
    )
  );
}
interface Props {
  active: boolean;
  focused: boolean;
  fontSize: number;
  home: string;
  onClose: () => void;
  onFocus: () => void;
  onReady: (id: string) => void;
  onRestart: () => void;
  onSplit: (direction: "horizontal" | "vertical") => void;
  pane: Pane;
  theme: Theme;
}
export const TerminalPane = memo(function TerminalPaneContent({
  pane,
  theme,
  fontSize,
  active,
  focused,
  home,
  onReady,
  onFocus,
  onSplit,
  onClose,
  onRestart,
}: Props) {
  const reduced = useReducedMotion();
  const host = useRef<HTMLDivElement>(null),
    terminal = useRef<Terminal | null>(null),
    searchAddon = useRef<SearchAddon | null>(null),
    fitRef = useRef<() => void>(() => {
      /* Optional callback is inactive until connected. */
    }),
    scrollTo = useRef<(offset: number) => void>(() => {
      /* Optional callback is inactive until connected. */
    });
  const [scrollback, setScrollback] = useState<Scrollback>({
    offset: 0,
    rows: 30,
    total: 0,
  });
  const latest = useRef({ active, focused, fontSize, theme });
  latest.current = { active, focused, fontSize, theme };
  const [status, setStatus] = useState("Connecting"),
    [showStatus, setShowStatus] = useState(false),
    [search, setSearch] = useState(false),
    [query, setQuery] = useState(""),
    [matches, setMatches] = useState("");
  useEffect(() => {
    if (pane.status === "exited") {
      onReady(pane.id);
    }
  }, [pane.id, pane.status, onReady]);
  useEffect(() => {
    if (status === "Live") {
      setShowStatus(false);
      return;
    }
    const timer = setTimeout(() => setShowStatus(true), 1000);
    return () => clearTimeout(timer);
  }, [status]);
  useEffect(() => {
    const t = new Terminal({
      allowProposedApi: true,
      allowTransparency: true,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Geist Mono Variable", monospace',
      fontSize: latest.current.fontSize,
      lineHeight: 1.35,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: true,
      screenReaderMode: true,
      scrollback: 10_000,
      theme: { ...latest.current.theme.terminal, background: "#00000000" },
    });
    const fit = new FitAddon(),
      finder = new SearchAddon();
    t.loadAddon(fit);
    t.loadAddon(finder);
    const element = host.current;
    if (!element) {
      return;
    }
    t.open(element);
    terminal.current = t;
    searchAddon.current = finder;
    t.attachCustomKeyEventHandler(
      (e) =>
        !(
          e.metaKey &&
          e.shiftKey &&
          [
            "t",
            "w",
            "d",
            "e",
            "f",
            "p",
            "b",
            ",",
            "<",
            "arrowleft",
            "arrowright",
            "arrowup",
            "arrowdown",
          ].includes(e.key.toLowerCase())
        ),
    );
    let ws: WebSocket | null = null,
      disposed = false,
      retry = 0,
      backoff = 400,
      raf = 0,
      ready = false,
      lastSize = "";
    scrollTo.current = (offset) => {
      if (ready && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ offset, type: "scrollTo" }));
      }
    };
    let wheelRemainder = 0;
    t.attachCustomWheelEventHandler((event) => {
      // Mouse-aware applications retain their native mouse protocol. Shells
      // and history use xterm selection plus the companion's scrollback.
      if (t.modes.mouseTrackingMode !== "none") {
        return true;
      }
      if (event.ctrlKey || !event.deltaY) {
        return false;
      }
      event.preventDefault();
      const lineHeight = latest.current.fontSize * 1.35;
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? event.deltaY * t.rows
          : event.deltaMode === WheelEvent.DOM_DELTA_LINE
            ? event.deltaY
            : event.deltaY / lineHeight;
      if (Math.sign(delta) !== Math.sign(wheelRemainder)) {
        wheelRemainder = 0;
      }
      wheelRemainder += delta;
      const lines = Math.trunc(wheelRemainder);
      if (lines && ready && ws?.readyState === WebSocket.OPEN) {
        wheelRemainder -= lines;
        t.clearSelection();
        ws.send(
          JSON.stringify({
            lines: -Math.max(-1000, Math.min(1000, lines)),
            type: "scrollBy",
          }),
        );
      }
      return false;
    });
    const resize = () => {
      if (!(latest.current.active && host.current?.clientWidth && host.current?.clientHeight)) {
        return;
      }
      fit.fit();
      // Measure only the terminal host: its parent has already removed pane
      // chrome and padding. xterm uses measured font metrics and whole cells.
      element.dataset.cols = String(t.cols);
      element.dataset.rows = String(t.rows);
      const size = `${t.cols}:${t.rows}`;
      if (ready && ws?.readyState === WebSocket.OPEN && size !== lastSize) {
        lastSize = size;
        ws.send(JSON.stringify({ cols: t.cols, rows: t.rows, type: "resize" }));
      }
    };
    fitRef.current = resize;
    // Fit again after the local font is decoded so columns use Geist's real metrics.
    void document.fonts.load(`${latest.current.fontSize}px "Geist Mono Variable"`).then(() => {
      if (!disposed) {
        resize();
      }
    });
    const connect = () => {
      if (disposed) {
        return;
      }
      setStatus("Connecting");
      ready = false;
      lastSize = "";
      ws = new WebSocket(socketUrl(`/ws/terminal/${pane.id}`));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "scrollback") {
          setScrollback({ offset: m.offset, rows: m.rows, total: m.total });
        } else if (m.type === "snapshot") {
          t.reset();
          t.resize(m.cols, m.rows);
          t.write(m.data, () => {
            if (disposed) {
              return;
            }
            ready = true;
            setStatus("Live");
            backoff = 400;
            resize();
            requestAnimationFrame(() => {
              if (!disposed) {
                onReady(pane.id);
              }
            });
            if (latest.current.focused && latest.current.active && canFocusTerminal()) {
              t.focus();
            }
          });
        } else if (m.type === "output") {
          t.write(m.data);
        } else if (m.type === "size") {
          t.resize(m.cols, m.rows);
        }
      };
      ws.onclose = () => {
        if (disposed) {
          return;
        }
        ready = false;
        setStatus("Reconnecting");
        retry = window.setTimeout(connect, backoff);
        backoff = Math.min(5000, backoff * 1.7);
      };
    };
    const input = t.onData((data) => {
      if (ready && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ data, type: "input" }));
      }
    });
    const binaryInput = t.onBinary((data) => {
      if (ready && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ data, type: "inputBinary" }));
      }
    });
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(resize);
    });
    observer.observe(element);
    const searchEvent = finder.onDidChangeResults((e) =>
      setMatches(e.resultCount ? `${e.resultIndex + 1}/${e.resultCount}` : "No matches"),
    );
    terminalHandles.set(pane.id, {
      find: () => setSearch(true),
      focus: () => t.focus(),
    });
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      cancelAnimationFrame(raf);
      observer.disconnect();
      input.dispose();
      binaryInput.dispose();
      searchEvent.dispose();
      ws?.close();
      terminalHandles.delete(pane.id);
      t.dispose();
      terminal.current = null;
    };
  }, [pane.id, onReady]);
  useEffect(() => {
    if (terminal.current) {
      // The pane owns the default background. Explicit ANSI cell backgrounds remain intact.
      terminal.current.options.theme = { ...theme.terminal, background: "#00000000" };
      terminal.current.options.fontSize = fontSize;
      fitRef.current();
    }
  }, [theme, fontSize]);
  useEffect(() => {
    if (active) {
      fitRef.current();
      if (focused && !search && canFocusTerminal()) {
        terminal.current?.focus();
      }
    }
  }, [active, focused, search]);
  const find = (q: string, previous = false, incremental = false) => {
    setQuery(q);
    if (!q) {
      searchAddon.current?.clearDecorations();
      setMatches("");
      return;
    }
    searchAddon.current?.[previous ? "findPrevious" : "findNext"](q, {
      decorations: {
        activeMatchBackground: "#ad7139",
        activeMatchBorder: "#d79b60",
        activeMatchColorOverviewRuler: "#d79b60",
        matchBackground: "#967942",
        matchBorder: "#b99a61",
        matchOverviewRuler: "#b99a61",
      },
      incremental,
    });
  };
  const closeSearch = () => {
    setSearch(false);
    searchAddon.current?.clearDecorations();
    terminal.current?.focus();
  };
  const path =
    pane.cwd === home
      ? "~"
      : pane.cwd.startsWith(`${home}/`)
        ? `~${pane.cwd.slice(home.length)}`
        : pane.cwd;
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Delegate focus and Escape from the interactive terminal and search controls without adding a redundant tab stop.
    <section
      {...stylex.props(s.pane, focused && s.focusedPane)}
      aria-label={`Terminal ${path}`}
      data-pane-id={pane.id}
      onFocusCapture={onFocus}
      onKeyDown={(event) => {
        if (search && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeSearch();
        }
      }}
      onPointerDown={onFocus}
    >
      <header {...stylex.props(s.paneHeader)} data-pane-header>
        <PaneHeading
          cwd={pane.cwd}
          label={pane.agent ? pane.agent.name : `${path} — ${pane.command}`}
          focused={focused}
          agent={Boolean(pane.agent)}
          onClose={onClose}
        />
        <PaneAgentIndicators pane={pane} />
        {showStatus && status !== "Live" && <span {...stylex.props(s.badge)}>{status}</span>}
        <Button
          {...stylex.props(s.iconButton, s.paneAction)}
          aria-label="Split right"
          onClick={() => onSplit("horizontal")}
          title="Split right · ⌘⇧D"
        >
          <Columns2 size={16} />
        </Button>
        <Button
          {...stylex.props(s.iconButton, s.paneAction)}
          aria-label="Split down"
          onClick={() => onSplit("vertical")}
          title="Split down · ⌘⇧E"
        >
          <Rows2 size={16} />
        </Button>
      </header>
      <div {...stylex.props(s.terminal)}>
        <div
          id={`terminal-content-${pane.id}`}
          ref={host}
          style={{ height: "100%", width: "100%" }}
        />
        <TerminalScrollbar
          id={`terminal-content-${pane.id}`}
          onScroll={(offset) => scrollTo.current(offset)}
          state={scrollback}
          target={host}
        />
        {pane.status === "exited" && (
          <div {...stylex.props(s.exit)}>
            <Button {...stylex.props(s.primary)} onClick={onRestart}>
              <RotateCcw size={13} />
              Shell exited · Restart
            </Button>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>
        {Boolean(search) && (
          <motion.div
            {...stylex.props(s.search)}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -2 }}
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: -4 }}
            transition={spring}
          >
            <Input
              {...stylex.props(s.searchInput)}
              aria-label="Find in terminal"
              autoFocus
              onChange={(e) => find(e.target.value, false, true)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  closeSearch();
                }
                if (e.key === "Enter") {
                  e.preventDefault();
                  find(query, e.shiftKey);
                }
              }}
              placeholder="Find in terminal…"
              value={query}
            />
            <span {...stylex.props(s.subtle)}>{matches}</span>
            <Button
              {...stylex.props(s.iconButton, s.tinyButton)}
              aria-label="Previous match"
              onClick={() => find(query, true)}
            >
              <ChevronUp size={14} />
            </Button>
            <Button
              {...stylex.props(s.iconButton, s.tinyButton)}
              aria-label="Next match"
              onClick={() => find(query)}
            >
              <ChevronDown size={14} />
            </Button>
            <Button
              {...stylex.props(s.iconButton, s.tinyButton)}
              aria-label="Close search"
              onClick={closeSearch}
            >
              <X size={14} />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
});
