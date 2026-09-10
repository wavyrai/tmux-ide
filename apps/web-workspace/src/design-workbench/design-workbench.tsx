import { AppChrome } from "./app-chrome";
import { PaneActions } from "./pane-actions";
import { WorkbenchTabs } from "./workbench-tabs";
import { SplitView } from "./split-view";
import { WorkbenchSidebar, type WorkbenchWindow } from "./workbench-sidebar";
import { useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { Group, Panel, Separator } from "motion-panels/react";
import { themes } from "../../shared/themes";
import { AgentIcon } from "../agent-icon";
import { Terminal, Plus } from "../icons";
import { MarkdownDocument } from "../components/widgets/markdown-document";
import {
  initialLayout,
  paneIds,
  removePane,
  splitPane,
  movePane,
  swapPanes,
  setSplitRatio,
  type LayoutNode,
} from "./layout-model";
import { fixturePanes, type FixturePane } from "./fixture-content";
import "./design-workbench.css";

const initialWindows: WorkbenchWindow[] = [
  { id: "agents", name: "agents", machine: "Local", session: "tmux-ide", layout: initialLayout },
  {
    id: "widgets",
    name: "widgets",
    machine: "Local",
    session: "tmux-ide",
    layout: {
      type: "split",
      id: "widgets-split",
      axis: "horizontal",
      ratio: 0.65,
      first: { type: "pane", id: "notes" },
      second: { type: "pane", id: "activity" },
    },
  },
  {
    id: "api",
    name: "api",
    machine: "mini",
    session: "api-service",
    layout: { type: "pane", id: "remote" },
  },
];
const notes =
  "# Workspace notes\n\nA quiet place for the work around your terminals.\n\n## Ready to explore\n\n- Drag a pane title to move it\n- Drop in the center to swap\n- Drop near an edge to split\n- Resize any divider with the pointer or arrow keys\n- Double-click a title to zoom\n\n## One component system\n\n| Surface | Rule |\n| --- | --- |\n| Typography | System sans + terminal mono |\n| Layout | Shared spacing and size tokens |\n| Color | Native TUI themes |\n\nThis is an interactive design fixture. It does not send commands to a daemon.";
const noAnimation = { duration: 0 };
export default function DesignWorkbench() {
  const [windows, setWindows] = useState(initialWindows);
  const [panes, setPanes] = useState(fixturePanes);
  const [active, setActive] = useState("agents");
  const [selected, setSelected] = useState("claude");
  const [zoom, setZoom] = useState<string | null>(null);
  const [home, setHome] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [themeId, setThemeId] = useState("dark");
  const [notice, setNotice] = useState("Design workspace · All interactions are local");
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<{
    id: string;
    edge: "left" | "right" | "top" | "bottom" | "center";
  } | null>(null);
  const [sidebarSize, setSidebarSize] = useState<number | null>(null);
  const [bounds, setBounds] = useState({ min: 0, max: Infinity });
  const root = useRef<HTMLDivElement>(null);
  const nextId = useRef(0);
  const theme = themes.find((t) => t.id === themeId) ?? themes[0]!;
  const current = windows.find((w) => w.id === active) ?? windows[0]!;
  const visibleWindows = windows.filter(
    (w) => w.machine === current.machine && w.session === current.session,
  );
  useEffect(() => {
    if (!root.current) return;
    const css = getComputedStyle(root.current);
    setSidebarSize(parseFloat(css.getPropertyValue("--dw-sidebar-width")));
    setBounds({
      min: parseFloat(css.getPropertyValue("--dw-sidebar-min")),
      max: parseFloat(css.getPropertyValue("--dw-sidebar-max")),
    });
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !document.querySelector(".dw-chrome-popover")
      ) {
        setDrag(null);
        setDrop(null);
        setZoom(null);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  function update(fn: (node: LayoutNode | null) => LayoutNode | null) {
    setWindows((all) => all.map((w) => (w.id === active ? { ...w, layout: fn(w.layout) } : w)));
  }
  function selectWindow(id: string, pane?: string) {
    setActive(id);
    setHome(false);
    setZoom(null);
    setSelected(pane ?? paneIds(windows.find((w) => w.id === id)?.layout ?? null)[0] ?? "");
  }
  function split(id: string, edge: "right" | "bottom") {
    const fresh = `shell-${++nextId.current}`;
    setPanes((all) => ({
      ...all,
      [fresh]: {
        ...fixturePanes.shell!,
        id: fresh,
        title: "Terminal",
        lines: ["~/Developer/tmux-ide", "❯ "],
      },
    }));
    update((node) => (node ? splitPane(node, id, fresh, edge) : { type: "pane", id: fresh }));
    setSelected(fresh);
    setZoom(null);
  }
  function target(event: DragEvent<HTMLElement>, id: string) {
    event.preventDefault();
    if (!drag || drag === id) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width,
      y = (event.clientY - box.top) / box.height;
    const edge =
      x < 0.25 ? "left" : x > 0.75 ? "right" : y < 0.25 ? "top" : y > 0.75 ? "bottom" : "center";
    setDrop({ id, edge });
    event.dataTransfer.dropEffect = "move";
  }
  function commitDrop(event: DragEvent<HTMLElement>, id: string) {
    event.preventDefault();
    if (drag && drop?.id === id) {
      update((node) =>
        node
          ? drop.edge === "center"
            ? swapPanes(node, drag, id)
            : movePane(node, drag, id, drop.edge)
          : node,
      );
      setNotice("Pane layout updated");
    }
    setDrag(null);
    setDrop(null);
  }
  function renderPane(id: string) {
    const pane = panes[id];
    if (!pane) return null;
    return (
      <section
        key={id}
        className="dw-pane"
        data-active={selected === id}
        data-drop-target={drop?.id === id}
        onPointerDownCapture={() => setSelected(id)}
        onDragOver={(event) => target(event, id)}
        onDrop={(event) => commitDrop(event, id)}
        aria-label={pane.title}
      >
        <header className="dw-pane-header">
          {/(claude|codex|opencode)/.test(pane.command) ? (
            <AgentIcon name={pane.command} />
          ) : (
            <Terminal size={14} />
          )}
          <button
            className="dw-pane-title"
            draggable={!zoom}
            onDragStart={(event) => {
              setDrag(id);
              event.dataTransfer.setData("text/plain", id);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragEnd={() => {
              setDrag(null);
              setDrop(null);
            }}
            onDoubleClick={() => setZoom(zoom === id ? null : id)}
            onClick={() => setSelected(id)}
            title="Drag to move · double-click to zoom"
          >
            {pane.title}
          </button>
          <span className="dw-status">
            {pane.state === "working" ? "●" : pane.state === "needs input" ? "!" : "○"} {pane.state}
          </span>
          <PaneActions
            portal={root}
            title={pane.title}
            zoomed={zoom === id}
            targets={paneIds(current.layout)
              .filter((other) => other !== id)
              .map((other) => ({ id: other, title: panes[other]?.title ?? "Terminal" }))}
            onSplit={(edge) => split(id, edge)}
            onZoom={() => setZoom(zoom === id ? null : id)}
            onClose={() => {
              const next = current.layout ? removePane(current.layout, id) : null;
              update(() => next);
              setSelected(paneIds(next)[0] ?? "");
              setZoom(null);
            }}
            onSwap={(other) => {
              update((node) => (node ? swapPanes(node, id, other) : node));
              setNotice("Panes swapped");
            }}
          />
        </header>
        <div className="dw-pane-content">
          {pane.kind === "markdown" ? (
            <MarkdownDocument text={notes} />
          ) : pane.kind === "activity" ? (
            <div className="dw-section">
              <h2>Agent activity</h2>
              {[
                "Claude Code read 12 files",
                "Codex finished contract checks",
                "Dev server is ready",
              ].map((text) => (
                <p key={text}>{text}</p>
              ))}
            </div>
          ) : (
            <FixtureTerminal pane={pane} />
          )}
        </div>
        {drop?.id === id && (
          <div className="dw-drop-zone" data-edge={drop.edge}>
            {drop.edge === "center" ? "Swap panes" : `Move ${drop.edge}`}
          </div>
        )}
      </section>
    );
  }
  const css = {
    "--chrome": theme.chrome,
    "--text": theme.text,
    "--muted": theme.muted,
    "--accent": theme.accent,
    "--border": theme.border,
    "--panel-fill": theme.panelFill,
    "--tab-surface": theme.tabSurface,
    "--tab-shadow": theme.tabShadow,
    colorScheme: theme.mode,
  } as CSSProperties;
  return (
    <div
      ref={root}
      className="design-workbench"
      data-workspace-shell
      data-design-fixture
      style={css}
    >
      <AppChrome
        sidebarOpen={sidebar}
        onToggleSidebar={() => setSidebar((value) => !value)}
        portal={root}
        commands={[
          { id: "home", label: "Go to Home", group: "Navigation", run: () => setHome(true) },
          {
            id: "terminals",
            label: "Go to Terminals",
            group: "Navigation",
            run: () => setHome(false),
          },
          {
            id: "sidebar",
            label: sidebar ? "Hide sidebar" : "Show sidebar",
            group: "Layout",
            run: () => setSidebar((value) => !value),
          },
          ...(selected && paneIds(current.layout).includes(selected)
            ? [
                {
                  id: "zoom",
                  label: zoom ? "Restore pane layout" : "Zoom selected pane",
                  group: "Layout",
                  run: () => setZoom(zoom ? null : selected),
                },
              ]
            : []),
          ...windows.flatMap((w) =>
            paneIds(w.layout).map((id) => ({
              id: `pane:${w.id}:${id}`,
              label: `Open ${panes[id]?.title} · ${w.machine} / ${w.name}`,
              group: "Panes",
              run: () => selectWindow(w.id, id),
            })),
          ),
          ...themes.map((t) => ({
            id: `theme:${t.id}`,
            label: `Theme: ${t.name}`,
            group: "Appearance",
            run: () => setThemeId(t.id),
          })),
        ]}
      />
      <Group orientation="horizontal" transition={noAnimation} className="dw-root-group">
        {sidebarSize !== null && (
          <>
            <Panel
              collapsed={!sidebar}
              keepMounted
              size={sidebarSize}
              minSize={bounds.min}
              maxSize={bounds.max}
              onSizeChange={setSidebarSize}
              transition={noAnimation}
            >
              <WorkbenchSidebar
                windows={windows}
                panes={panes}
                active={active}
                selected={selected}
                home={home}
                onHome={() => setHome(true)}
                onTerminals={() => setHome(false)}
                onSelect={selectWindow}
              />
            </Panel>
            <Separator className="dw-divider" data-axis="horizontal" aria-label="Resize sidebar" />
          </>
        )}
        <Panel className="dw-main">
          <header className="dw-toolbar">
            <WorkbenchTabs
              items={visibleWindows.map((w) => ({
                id: w.id,
                name: w.name,
                count: paneIds(w.layout).length,
                command: panes[paneIds(w.layout)[0] ?? ""]?.command,
              }))}
              value={home ? "" : active}
              onSelect={selectWindow}
              onMove={(source, target) =>
                setWindows((all) => {
                  const from = all.findIndex((w) => w.id === source),
                    to = all.findIndex((w) => w.id === target);
                  if (from < 0 || to < 0 || from === to) return all;
                  const next = [...all];
                  next.splice(to, 0, next.splice(from, 1)[0]!);
                  return next;
                })
              }
              onClose={(id) => {
                const remaining = visibleWindows.filter((w) => w.id !== id);
                if (!remaining.length) return;
                setWindows((all) => all.filter((w) => w.id !== id));
                if (active === id) selectWindow(remaining[0]!.id);
              }}
            />
            <button
              className="dw-button"
              onClick={() => {
                const id = `window-${++nextId.current}`;
                const paneId = `${id}-terminal`;
                setPanes((all) => ({
                  ...all,
                  [paneId]: { ...fixturePanes.shell!, id: paneId, title: "Terminal" },
                }));
                setWindows((all) => [
                  ...all,
                  {
                    id,
                    name: "terminal",
                    machine: current.machine,
                    session: current.session,
                    layout: { type: "pane", id: paneId },
                  },
                ]);
                setActive(id);
                setSelected(paneId);
                setHome(false);
                setZoom(null);
              }}
              aria-label="New window"
            >
              <Plus size={14} />
            </button>
            <select
              className="dw-theme"
              aria-label="Theme"
              value={themeId}
              onChange={(e) => setThemeId(e.target.value)}
            >
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button
              className="dw-button"
              onClick={() => {
                setWindows(initialWindows);
                setPanes(fixturePanes);
                setActive("agents");
                setSelected("claude");
                setZoom(null);
                setHome(false);
              }}
            >
              Reset
            </button>
          </header>
          <div className="dw-layout-area">
            {home ? (
              <div className="dw-home">
                <span className="dw-section-label">Your workspace</span>
                <h1>Everything in view.</h1>
                <p>Two machines. Three agents. One place to work.</p>
                <div className="dw-home-grid">
                  {[fixturePanes.claude!, fixturePanes.codex!, fixturePanes.remote!].map((p) => (
                    <button
                      key={p.id}
                      className="dw-card"
                      onClick={() => selectWindow(p.id === "remote" ? "api" : "agents", p.id)}
                    >
                      <AgentIcon name={p.command} />
                      <strong>{p.title}</strong>
                      <span>{p.state}</span>
                    </button>
                  ))}
                </div>
                <MarkdownDocument text={notes} />
              </div>
            ) : zoom ? (
              renderPane(zoom)
            ) : current.layout ? (
              <SplitView
                key={current.id}
                node={current.layout}
                renderPane={renderPane}
                onResize={(id, ratio) =>
                  update((node) => (node ? setSplitRatio(node, id, ratio) : node))
                }
              />
            ) : (
              <div className="dw-home">
                <h2>No panes in this window</h2>
                <button className="dw-button" onClick={() => split("", "right")}>
                  New terminal
                </button>
              </div>
            )}
          </div>
          <footer className="dw-footer" role="status">
            {notice}
            <span>
              {zoom
                ? "Zoomed · Esc to restore"
                : "Drag titles · resize dividers · double-click to zoom"}
            </span>
          </footer>
        </Panel>
      </Group>
    </div>
  );
}
function FixtureTerminal({ pane }: { pane: FixturePane }) {
  const [history, setHistory] = useState<string[]>([]);
  const [input, setInput] = useState("");
  return (
    <div className="dw-terminal">
      <pre>{[...pane.lines, ...history].join("\n")}</pre>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) {
            setHistory((lines) => [
              ...lines,
              `❯ ${input}`,
              "Design fixture — no command was executed.",
            ]);
            setInput("");
          }
        }}
      >
        <span>❯ </span>
        <input
          className="dw-terminal-input"
          aria-label={`Input ${pane.title}`}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          spellCheck={false}
        />
      </form>
    </div>
  );
}
