import { Group as PanelGroup, Panel, Separator } from "motion-panels/react";
import { LiveWorkspace } from "./live-workspace";
import { subscribeWorkspace, retryConnection } from "./client";
import { HomeOverview } from "./home-overview";
import { LiveSidebar } from "./components/workspace/live-sidebar";
import { selectedSidebarPane } from "./design-workbench/sidebar-model";
import { AppChrome } from "./design-workbench/app-chrome";
import "./design-workbench/design-workbench.css";
import { WidgetPane } from "./widget-pane";
import { Input } from "@base-ui/react/input";
import { Tabs } from "@base-ui/react/tabs";
import * as stylex from "@stylexjs/stylex";
import { leaves, type Settings, type Tab, type Workspace } from "@superlogical/shared/model";
import type { ActionInput } from "@superlogical/shared/protocol";
import { themes } from "@superlogical/shared/themes";
import { AnimatePresence, MotionConfig, motion, Reorder } from "motion/react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { action, bootstrap, type Machine } from "./client";
import { GlassIcon } from "./glass-icon";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Columns2,
  Keyboard,
  Laptop,
  Layers,
  Moon,
  Palette,
  Plus,
  Rows2,
  Search,
  SlidersHorizontal,
  Sun,
  Terminal,
  Trash2,
  X,
} from "./icons";
import { Modal } from "./modal";
import { StateIcon, spring, useReducedMotion } from "./motion";
import { SplitTree } from "./split-tree";
import { s } from "./styles";
import { terminalHandles } from "./terminal-handles";
import { TerminalPane } from "./terminal-pane";
import { Button } from "./components/ui/button";
import { CommandPalette } from "./components/ui/command-palette";
import { OverlayContainer } from "./components/ui/dialog";
import { RadioGroup } from "./components/ui/radio-group";
import { TextField } from "./components/ui/text-field";

const defaultSettings: Settings = {
  darkTheme: "midnight",
  fontSize: 17,
  lightTheme: "paper",
  mode: "system",
};
const shortcuts = [
  ["New terminal", "⌘⇧T"],
  ["Close current tab", "⌘⇧W"],
  ["Split right", "⌘⇧D"],
  ["Split down", "⌘⇧E"],
  ["Find in terminal", "⌘⇧F"],
  ["Command palette", "⌘⇧P"],
  ["Background sessions", "⌘⇧B"],
  ["Previous / next tab", "⌘⇧← / →"],
  ["Previous / next pane", "⌘⇧↑ / ↓"],
  ["Appearance", "⌘⇧,"],
];
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing workspace orchestration keeps the complete action/render dispatch in one place; extracted subsystems remain independently checked.
export default function App() {
  const reduced = useReducedMotion();
  const overlayContainer = useRef<HTMLDivElement>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null),
    [machine, setMachine] = useState<Machine | null>(null),
    [connection, setConnection] = useState<"connecting" | "paired" | "unpaired" | "offline">(
      bootstrap ? "paired" : "connecting",
    );
  const [activeId, setActiveId] = useState(() => localStorage.getItem("superlogical.active") || ""),
    [focusedId, setFocusedId] = useState(""),
    [modal, setModal] = useState<
      "themes" | "background" | "commands" | "shortcuts" | "rename" | null
    >(null);
  const [home, setHome] = useState(true);
  const [themeQuery, setThemeQuery] = useState("");
  const [compact, setCompact] = useState(() => matchMedia("(max-width: 600px)").matches);
  const [toast, setToast] = useState(""),
    [busy, setBusy] = useState(false),
    [systemDark, setSystemDark] = useState(
      () => matchMedia("(prefers-color-scheme: dark)").matches,
    ),
    [query, setQuery] = useState(""),
    [rename, setRename] = useState(""),
    [renameId, setRenameId] = useState(""),
    [terminateId, setTerminateId] = useState<string | null>(null),
    [pairingKey, setPairingKey] = useState(""),
    [pairingError, setPairingError] = useState(""),
    [error, setError] = useState(""),
    [renameError, setRenameError] = useState("");
  const toastTimer = useRef(0),
    reorderRef = useRef<string[] | null>(null),
    [order, setOrder] = useState<string[] | null>(null);
  const settings = workspace?.settings || defaultSettings,
    mode = settings.mode === "system" ? (systemDark ? "dark" : "light") : settings.mode,
    theme =
      themes.find((t) => t.id === (mode === "dark" ? settings.darkTheme : settings.lightTheme)) ||
      themes[0];
  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 4500);
  }, []);
  const select = useCallback((id: string) => {
    setActiveId(id);
    localStorage.setItem("superlogical.active", id);
  }, []);
  const apply = useCallback(
    (state: Workspace) =>
      setWorkspace((current) => (!current || state.revision >= current.revision ? state : current)),
    [],
  );
  const run = useCallback(
    async (a: ActionInput) => {
      try {
        const result = await action(a);
        apply(result.state);
        if (result.selectedTab) {
          select(result.selectedTab);
        }
        return result;
      } catch (e) {
        setError(
          `${(e as Error).message.replace(/[.!?]\s*$/, "")}. Try again; if the companion is offline, start it and reconnect.`,
        );
        return null;
      }
    },
    [apply, select],
  );
  useEffect(() => {
    const media = matchMedia("(max-width: 600px)");
    const listener = () => setCompact(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => setSystemDark(media.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: This effect deliberately reruns when the rendered layout changes, even though those values are not read inside the DOM measurement.
  useLayoutEffect(() => {
    const style = document.createElement("style");
    style.textContent = "*,*::before,*::after{transition:none!important}";
    document.head.append(style);
    void document.body.offsetHeight;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => style.remove());
    });
    return () => {
      cancelAnimationFrame(frame);
      style.remove();
    };
  }, [theme.id]);
  useEffect(() => {
    document.documentElement.style.colorScheme = mode;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.chrome);
  }, [mode, theme]);
  useEffect(
    () =>
      subscribeWorkspace((snapshot) => {
        apply(snapshot.state);
        setMachine(snapshot.machine);
        setConnection(snapshot.connection);
        setError(snapshot.reason ?? "");
      }),
    [apply],
  );

  const visible = workspace?.tabs.filter((t) => !t.hidden) || [],
    background = workspace?.tabs.filter((t) => t.hidden) || [],
    active = visible.find((t) => t.id === activeId) || visible[0];
  const tabStrip = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: This effect deliberately reruns when the rendered layout changes, even though those values are not read inside the DOM measurement.
  useEffect(() => {
    tabStrip.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id, compact]);
  const [readyPanes, setReadyPanes] = useState<Set<string>>(() => new Set());
  const markReady = useCallback((id: string) => {
    setReadyPanes((current) => (current.has(id) ? current : new Set([...current, id])));
  }, []);
  const startupReady = active
    ? leaves(active.layout).every((id) => readyPanes.has(id))
    : connection !== "connecting";
  useEffect(() => {
    if (!startupReady) {
      return;
    }
    // Reveal the whole workspace after xterm's queued render frame.
    const frame = requestAnimationFrame(() => {
      delete document.documentElement.dataset.starting;
      performance.mark("workspace-ready");
    });
    return () => cancelAnimationFrame(frame);
  }, [startupReady]);
  useEffect(() => {
    // A failed companion must still expose its reconnect/pairing controls.
    const timeout = setTimeout(() => {
      delete document.documentElement.dataset.starting;
    }, 1500);
    return () => clearTimeout(timeout);
  }, []);
  const focused =
    active && leaves(active.layout).includes(focusedId)
      ? focusedId
      : active
        ? leaves(active.layout)[0]
        : "";
  const ordered =
    order &&
    order.length === visible.length &&
    order.every((id) => visible.some((t) => t.id === id))
      ? order.flatMap((id) => visible.filter((t) => t.id === id))
      : visible;
  const newTerminal = useCallback(async () => {
    setBusy(true);
    await run({ type: "create" });
    setBusy(false);
  }, [run]);
  const closeModal = () => {
    setModal(null);
    setQuery("");
    setTerminateId(null);
  };
  const split = (direction: "horizontal" | "vertical", paneId = focused, tabId = active?.id) => {
    if (tabId && paneId) {
      void run({ direction, paneId, tabId, type: "split" });
    }
  };
  const notifyClose = (subject: string, result: { closed: number; hidden: number }) => {
    notify(
      result.hidden
        ? result.closed
          ? "Idle terminals closed. Remaining terminals kept in Background sessions."
          : `${subject} moved to Background sessions.`
        : `${subject} closed.`,
    );
  };
  const closeTab = (tabId = active?.id) => {
    if (tabId) {
      void run({ tabId, type: "close" }).then((result) => {
        if (result?.close) {
          notifyClose("Tab", result.close);
        }
      });
    }
  };
  const openRename = (t: Tab) => {
    setRenameError("");
    setRename(t.name);
    setRenameId(t.id);
    setModal("rename");
  };
  const commandList = [
    {
      disabled: busy || connection !== "paired",
      fn: newTerminal,
      hint: "⌘⇧T",
      icon: Plus,
      label: "New terminal",
    },
    {
      disabled: !active,
      fn: () => split("horizontal"),
      hint: "⌘⇧D",
      icon: Columns2,
      label: "Split right",
    },
    {
      disabled: !active,
      fn: () => split("vertical"),
      hint: "⌘⇧E",
      icon: Rows2,
      label: "Split down",
    },
    {
      disabled: !active,
      fn: () => terminalHandles.get(focused)?.find(),
      hint: "⌘⇧F",
      icon: Search,
      label: "Find in terminal",
    },
    {
      disabled: !active,
      fn: () => active && openRename(active),
      hint: "Double-click tab",
      icon: SlidersHorizontal,
      label: "Rename tab",
    },
    {
      disabled: !active,
      fn: () => closeTab(),
      hint: "⌘⇧W",
      icon: Layers,
      label: "Close current tab",
    },
    {
      fn: () => setModal("background"),
      hint: "⌘⇧B",
      icon: Layers,
      label: "Background sessions",
    },
    {
      fn: () => setModal("themes"),
      hint: "⌘⇧,",
      icon: Palette,
      label: "Appearance",
    },
    {
      fn: () => setModal("shortcuts"),
      hint: "",
      icon: Keyboard,
      label: "Keyboard shortcuts",
    },
  ];
  const keyboardRef = useRef<(e: KeyboardEvent) => void>(() => {
    /* Optional callback is inactive until connected. */
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Existing workspace orchestration keeps the complete action/render dispatch in one place; extracted subsystems remain independently checked.
  keyboardRef.current = (e) => {
    if (!(e.metaKey && e.shiftKey) || e.altKey || e.ctrlKey) {
      return;
    }
    const key = e.key.toLowerCase();
    if (modal) {
      return;
    }
    let handled = true;
    if (key === "t") {
      void newTerminal();
    } else if (key === "w") {
      closeTab();
    } else if (key === "d") {
      split("horizontal");
    } else if (key === "e") {
      split("vertical");
    } else if (key === "f") {
      terminalHandles.get(focused)?.find();
    } else if (key === "p") {
      setModal("commands");
    } else if (key === "b") {
      setModal("background");
    } else if (key === "," || key === "<") {
      setModal("themes");
    } else if (key === "arrowleft" || key === "arrowright") {
      const tabIndex = visible.findIndex((t) => t.id === active?.id);
      const nextTab =
        visible[(tabIndex + (key === "arrowright" ? 1 : -1) + visible.length) % visible.length];
      if (nextTab) {
        select(nextTab.id);
      }
    } else if (key === "arrowup" || key === "arrowdown") {
      if (active) {
        const ids = leaves(active.layout),
          at = ids.indexOf(focused);
        setFocusedId(ids[(at + (key === "arrowdown" ? 1 : -1) + ids.length) % ids.length]);
      }
    } else {
      handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => keyboardRef.current(e);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSize, setSidebarSize] = useState<number | null>(null);
  const [sidebarBounds, setSidebarBounds] = useState({ min: 0, max: Infinity });
  useEffect(() => {
    if (!overlayContainer.current) return;
    const tokens = getComputedStyle(overlayContainer.current);
    setSidebarSize(parseFloat(tokens.getPropertyValue("--dw-sidebar-width")));
    setSidebarBounds({
      min: parseFloat(tokens.getPropertyValue("--dw-sidebar-min")),
      max: parseFloat(tokens.getPropertyValue("--dw-sidebar-max")),
    });
  }, []);
  const css = {
    "--accent": theme.accent,
    "--border": theme.border,
    "--chrome": theme.chrome,

    "--control-ink": theme.controlInk,
    "--danger": theme.danger,
    "--status-success": theme.success || "light-dark(#34713e, #a1c994)",
    "--status-warning": theme.warning || "light-dark(#805900, #dfc382)",
    "--status-info": theme.info || theme.accent,
    "--frame-gradient": theme.frameGradient,
    "--glass-sheen": theme.glassSheen,
    "--muted": theme.muted,
    "--overlay-fill": theme.overlayFill,
    "--overlay-shadow": theme.overlayShadow,
    "--page": theme.page,
    "--panel-active-fill": theme.panelActiveFill,
    "--panel-fill": theme.panelFill,
    "--panel-shadow": theme.panelShadow,
    "--scrim": theme.scrim,
    "--surface": theme.surface,
    "--tab-shadow": theme.tabShadow,
    "--tab-surface": theme.tabSurface,
    "--text": theme.text,
    "--tint": theme.tint,
  } as CSSProperties;
  const updateSettings = (patch: Partial<Settings>) =>
    void run({ settings: { ...settings, ...patch }, type: "settings" });
  return (
    <MotionConfig reducedMotion="user" transition={spring}>
      <OverlayContainer.Provider value={overlayContainer}>
        <div
          ref={overlayContainer}
          {...stylex.props(s.app)}
          className={`${stylex.props(s.app).className} workbench-shell`}
          style={{ ...css, flexDirection: "column" }}
          data-workspace-shell
        >
          <AppChrome
            live
            portal={overlayContainer}
            sidebarOpen={sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((value) => !value)}
            commands={[
              {
                id: "home",
                label: "Go to Home",
                group: "Navigation",
                icon: "home",
                run: () => setHome(true),
              },
              {
                id: "terminals",
                label: "Go to Terminals",
                group: "Navigation",
                icon: "terminal",
                run: () => setHome(false),
              },
              ...visible.map((tab) => ({
                id: `session:${tab.id}`,
                label: tab.name,
                description: tab.machine || "Local",
                group: "Sessions",
                icon: "terminal" as const,
                run: () => {
                  setHome(false);
                  select(tab.id);
                },
              })),
              ...themes.map((t) => ({
                id: `theme:${t.id}`,
                label: `Theme: ${t.name}`,
                group: "Appearance",
                icon: "theme" as const,
                run: () =>
                  updateSettings({
                    mode: t.mode,
                    ...(t.mode === "dark" ? { darkTheme: t.id } : { lightTheme: t.id }),
                  }),
              })),
            ]}
          />
          <PanelGroup
            orientation="horizontal"
            transition={{ duration: 0 }}
            className="dw-live-body"
          >
            {sidebarSize !== null && (
              <>
                <Panel
                  collapsed={!sidebarOpen}
                  keepMounted
                  size={sidebarSize}
                  onSizeChange={setSidebarSize}
                  minSize={sidebarBounds.min}
                  maxSize={sidebarBounds.max}
                  transition={{ duration: 0 }}
                >
                  <LiveSidebar
                    connection={connection}
                    workspace={workspace}
                    active={active?.id ?? ""}
                    selected={selectedSidebarPane(active ? leaves(active.layout) : [], focusedId)}
                    home={home}
                    onHome={() => setHome(true)}
                    onTerminals={() => setHome(false)}
                    onSelect={(tab, pane) => {
                      setHome(false);
                      select(tab);
                      if (pane) setFocusedId(pane);
                    }}
                  />
                </Panel>
                <Separator
                  className="dw-divider"
                  data-axis="horizontal"
                  aria-label="Resize sidebar"
                />
              </>
            )}
            <Panel className="dw-live-main">
              {connection !== "paired" && (
                <div className="live-connection" role="status">
                  {connection === "connecting"
                    ? "Connecting to daemon…"
                    : error || "Daemon disconnected"}
                  <button onClick={retryConnection}>Reconnect</button>
                </div>
              )}
              {home && (
                <HomeOverview
                  workspace={workspace}
                  onOpen={(tab, pane) => {
                    setHome(false);
                    select(tab);
                    if (pane) setFocusedId(pane);
                  }}
                />
              )}
              <Tabs.Root
                onValueChange={(id) => {
                  if (typeof id === "string") {
                    select(id);
                  }
                }}
                render={<main />}
                value={active?.id ?? null}
                {...stylex.props(s.workspace)}
                id="workspace"
                style={{ display: home ? "none" : undefined }}
              >
                {Boolean(active) && <h1 {...stylex.props(s.srOnly)}>Terminal workspace</h1>}
                {Boolean(focused) && (
                  <Button
                    static
                    {...stylex.props(s.skip)}
                    onClick={() => terminalHandles.get(focused)?.focus()}
                  >
                    Skip to terminal
                  </Button>
                )}
                <header
                  {...stylex.props(s.toolbar)}
                  style={active?.fleetSessionId ? { display: "none" } : undefined}
                >
                  <Button
                    {...stylex.props(s.iconButton, s.workspaceMenu)}
                    aria-expanded={modal === "commands"}
                    aria-haspopup="dialog"
                    aria-label="Workspace menu"
                    onClick={() => setModal("commands")}
                    title={`${machine?.name || "This Mac"} · ${connection === "paired" ? "Connected locally" : "Reconnecting"} · Workspace menu (⌘⇧P)`}
                  >
                    <Layers size={18} />
                    {connection !== "paired" && connection !== "connecting" && (
                      <span
                        {...stylex.props(s.connectionDot)}
                        aria-label={
                          connection === "unpaired" ? "Pairing required" : "Connecting to companion"
                        }
                        role="img"
                      />
                    )}
                  </Button>
                  <div ref={tabStrip} {...stylex.props(s.tabStrip)}>
                    <Tabs.List
                      {...stylex.props(s.tabs)}
                      activateOnFocus
                      aria-label="Terminal tabs"
                      render={
                        <Reorder.Group
                          as="div"
                          axis="x"
                          onReorder={(ids) => {
                            setOrder(ids);
                            reorderRef.current = ids;
                          }}
                          values={ordered.map((t) => t.id)}
                        />
                      }
                    >
                      {ordered.map((t) => (
                        <Reorder.Item
                          as="div"
                          key={t.id}
                          value={t.id}
                          {...stylex.props(s.tab, t.id === active?.id && s.tabActive)}
                          onDragEnd={() => {
                            if (reorderRef.current) {
                              void run({
                                ids: reorderRef.current,
                                type: "reorder",
                              }).then(() => setOrder(null));
                              reorderRef.current = null;
                            }
                          }}
                          transition={reduced ? { duration: 0 } : spring}
                          whileDrag={reduced ? { zIndex: 2 } : { scale: 1.03, zIndex: 2 }}
                        >
                          <Tabs.Tab
                            data-workspace-tab
                            value={t.id}
                            {...stylex.props(s.tabTrigger)}
                            onDoubleClick={() => openRename(t)}
                            onKeyDown={(e) => {
                              if (e.altKey && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
                                e.preventDefault();
                                e.preventBaseUIHandler();
                                const ids = ordered.map((tab) => tab.id),
                                  at = ids.indexOf(t.id);
                                const next = Math.max(
                                  0,
                                  Math.min(ids.length - 1, at + (e.key === "ArrowRight" ? 1 : -1)),
                                );
                                [ids[at], ids[next]] = [ids[next], ids[at]];
                                void run({ ids, type: "reorder" }).then((result) => {
                                  if (result) {
                                    notify(`Tab moved to position ${next + 1}.`);
                                  }
                                });
                                return;
                              }
                              if (e.key === "F2") {
                                openRename(t);
                              }
                            }}
                          >
                            <GlassIcon
                              command={workspace?.panes[leaves(t.layout)[0]]?.command}
                              count={leaves(t.layout).length}
                            />
                            <span
                              {...stylex.props(s.tabText)}
                              title={
                                t.customName
                                  ? t.name
                                  : `${t.name} — ${workspace?.panes[leaves(t.layout)[0]]?.command || "zsh"}`
                              }
                            >
                              {t.customName
                                ? t.name
                                : `${t.name} — ${workspace?.panes[leaves(t.layout)[0]]?.command || "zsh"}`}
                            </span>
                          </Tabs.Tab>
                          <Button
                            {...stylex.props(s.iconButton, s.tinyButton)}
                            aria-label={`Close tab ${t.name}`}
                            data-tab-close
                            onClick={(e) => {
                              e.stopPropagation();
                              closeTab(t.id);
                            }}
                            onPointerDown={(e) => e.stopPropagation()}
                            tabIndex={t.id === active?.id ? 0 : -1}
                            title="Close tab · ⌘⇧W"
                          >
                            <X size={15} />
                          </Button>
                        </Reorder.Item>
                      ))}
                    </Tabs.List>
                    {background.length > 0 && (
                      <Button
                        {...stylex.props(s.backgroundTabs)}
                        aria-expanded={modal === "background"}
                        aria-haspopup="dialog"
                        data-background-tabs
                        onClick={() => setModal("background")}
                      >
                        {background.length} background {background.length === 1 ? "tab" : "tabs"}
                      </Button>
                    )}
                  </div>
                  <Button
                    {...stylex.props(s.iconButton)}
                    aria-label="New terminal"
                    disabled={busy || connection !== "paired"}
                    onClick={newTerminal}
                    title="New terminal · ⌘⇧T"
                  >
                    <Plus size={20} strokeWidth={1.6} />
                  </Button>
                </header>
                <div {...stylex.props(s.canvas)}>
                  {workspace !== null &&
                    machine !== null &&
                    visible.map((t) => (
                      <Tabs.Panel
                        keepMounted
                        key={t.id}
                        value={t.id}
                        {...stylex.props(s.tabCanvas, t.id !== active?.id && s.hidden)}
                      >
                        {t.fleetSessionId && t.daemonInstanceId ? (
                          !home && t.id === active?.id ? (
                            <LiveWorkspace
                              selectedPane={focusedId}
                              onSelectedPane={setFocusedId}
                              sessionId={t.fleetSessionId}
                              daemonInstanceId={t.daemonInstanceId}
                              theme={theme}
                              fontSize={settings.fontSize}
                            />
                          ) : null
                        ) : (
                          <SplitTree
                            compact={compact}
                            node={t.layout}
                            onResize={(splitId, ratio) =>
                              void run({
                                ratio,
                                splitId,
                                tabId: t.id,
                                type: "resize",
                              })
                            }
                            renderPane={(id) =>
                              workspace.panes[id].viewOnly ? (
                                <section className="widget-pane">
                                  <header className="widget-header">
                                    {workspace.panes[id].agent?.name || workspace.panes[id].command}
                                  </header>
                                  <div className="markdown-body">
                                    <h2>Session discovered</h2>
                                    <p>
                                      This is live daemon catalog data. Terminal attachment is the
                                      next integration step.
                                    </p>
                                    <p>No input or resize ownership has been requested.</p>
                                  </div>
                                </section>
                              ) : workspace.panes[id].widget ? (
                                <WidgetPane
                                  key={id}
                                  pane={workspace.panes[id]}
                                  focused={focused === id}
                                  onFocus={() => setFocusedId(id)}
                                  onClose={() =>
                                    void run({ type: "closePane", paneId: id, tabId: t.id })
                                  }
                                />
                              ) : (
                                <TerminalPane
                                  active={!home && t.id === active?.id}
                                  focused={id === focused}
                                  fontSize={settings.fontSize}
                                  home={machine.home}
                                  key={id}
                                  onClose={() => {
                                    void run({
                                      paneId: id,
                                      tabId: t.id,
                                      type: "closePane",
                                    }).then((result) => {
                                      if (result?.close) {
                                        notifyClose("Pane", result.close);
                                      }
                                    });
                                  }}
                                  onFocus={() => setFocusedId(id)}
                                  onReady={markReady}
                                  onRestart={() => void run({ paneId: id, type: "restart" })}
                                  onSplit={(direction) => split(direction, id, t.id)}
                                  pane={workspace.panes[id]}
                                  theme={theme}
                                />
                              )
                            }
                          />
                        )}
                      </Tabs.Panel>
                    ))}
                  {!active && connection !== "connecting" && (
                    <div {...stylex.props(s.welcomeScroll)}>
                      <div {...stylex.props(s.welcome)}>
                        <motion.div {...stylex.props(s.welcomeIcon)} initial={false}>
                          <Terminal size={29} strokeWidth={1.5} />
                        </motion.div>
                        <h1 {...stylex.props(s.heading)}>
                          {connection === "unpaired"
                            ? "Meet your Mac."
                            : connection === "offline"
                              ? "Your work is still there."
                              : background.length
                                ? "Out of sight. Still at work."
                                : "Make yourself at home."}
                        </h1>
                        <p {...stylex.props(s.paragraph)}>
                          {connection === "unpaired"
                            ? "Pair this browser with the local companion to use your real terminals."
                            : connection === "offline"
                              ? "Waiting for the local companion to reconnect. Your terminal sessions live on your Mac."
                              : background.length
                                ? "Your sessions are running in the background. Bring one back, or start something new."
                                : "Your terminals, side by side. Start something here. Come back to it whenever."}
                        </p>
                        {connection === "unpaired" ? (
                          <form
                            onSubmit={async (e) => {
                              e.preventDefault();
                              setPairingError("");
                              setBusy(true);
                              try {
                                throw new Error("Pairing is managed by the daemon gateway.");
                              } catch {
                                setPairingError(
                                  "Unable to pair. Check the key, or run npm run open on this Mac for a fresh pairing link.",
                                );
                                setBusy(false);
                              }
                            }}
                            style={{ maxWidth: "100%", width: 300 }}
                          >
                            <TextField
                              autoComplete="off"
                              error={pairingError}
                              id="pairing-key"
                              label="Pairing key"
                              name="pairing-key"
                              onValueChange={setPairingKey}
                              placeholder="Paste pairing key"
                              type="password"
                              value={pairingKey}
                            />
                            <Button
                              disabled={busy}
                              type="submit"
                              {...stylex.props(s.primary)}
                              style={{ marginTop: 12, width: "100%" }}
                            >
                              {busy ? "Connecting…" : "Connect to this Mac"}{" "}
                              <ArrowRight size={14} />
                            </Button>
                            <p {...stylex.props(s.subtle)} style={{ marginTop: 14 }}>
                              Or run <code>npm run open</code> in the project.
                            </p>
                          </form>
                        ) : (
                          <>
                            <Button
                              {...stylex.props(s.primary)}
                              disabled={connection !== "paired" || busy}
                              onClick={newTerminal}
                            >
                              <Plus size={15} />
                              {busy ? "Opening terminal…" : "Open a terminal"}
                              <kbd {...stylex.props(s.key)}>⇧⌘T</kbd>
                            </Button>
                            {background.length > 0 && (
                              <Button
                                {...stylex.props(s.textButton)}
                                onClick={() => setModal("background")}
                              >
                                Browse {background.length} background{" "}
                                {background.length === 1 ? "session" : "sessions"}{" "}
                                <ArrowRight size={13} />
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </Tabs.Root>
            </Panel>
          </PanelGroup>
          <AnimatePresence initial={false} mode="wait">
            {modal === "themes" && (
              <Modal
                error={error}
                key="themes"
                onClose={closeModal}
                onDismissError={() => setError("")}
                subtitle="Shared TUI palettes for your workspace, terminals, and agent indicators."
                title="Set the mood."
                wide
              >
                <RadioGroup.Root
                  {...stylex.props(s.segmented)}
                  aria-label="Color mode"
                  onValueChange={(nextMode) => updateSettings({ mode: nextMode })}
                  value={settings.mode}
                >
                  {(
                    [
                      { icon: Laptop, label: "System", value: "system" },
                      { icon: Sun, label: "Light", value: "light" },
                      { icon: Moon, label: "Dark", value: "dark" },
                    ] as const
                  ).map((item) => (
                    <RadioGroup.Item
                      key={item.value}
                      {...stylex.props(s.segment, settings.mode === item.value && s.segmentActive)}
                      value={item.value}
                    >
                      <item.icon size={14} />
                      {item.label}
                    </RadioGroup.Item>
                  ))}
                </RadioGroup.Root>
                <Input
                  {...stylex.props(s.input)}
                  aria-label="Search themes"
                  placeholder="Search themes…"
                  value={themeQuery}
                  onChange={(event) => setThemeQuery(event.target.value)}
                />
                {(["light", "dark"] as const).map((m) => (
                  <div key={m}>
                    <div {...stylex.props(s.sectionTitle)}>
                      {m === "light" ? "When it’s light" : "When it’s dark"}
                    </div>
                    <RadioGroup.Root
                      {...stylex.props(s.themeGrid)}
                      aria-label={`${m === "light" ? "Light" : "Dark"} palette`}
                      onValueChange={(id) =>
                        updateSettings(
                          m === "light"
                            ? { lightTheme: id as Settings["lightTheme"] }
                            : { darkTheme: id as Settings["darkTheme"] },
                        )
                      }
                      value={m === "light" ? settings.lightTheme : settings.darkTheme}
                    >
                      {themes
                        .filter(
                          (t) =>
                            t.mode === m && t.name.toLowerCase().includes(themeQuery.toLowerCase()),
                        )
                        .map((t) => {
                          const selected =
                            (m === "light" ? settings.lightTheme : settings.darkTheme) === t.id;
                          return (
                            <RadioGroup.Item
                              key={t.id}
                              {...stylex.props(s.themeCard, selected && s.themeSelected)}
                              aria-label={`${t.name} ${m} theme`}
                              value={t.id}
                            >
                              <div
                                aria-hidden="true"
                                {...stylex.props(s.swatch)}
                                style={{ backgroundImage: t.frameGradient }}
                              >
                                <div {...stylex.props(s.swatchTop)}>
                                  <span
                                    style={{
                                      backgroundImage: t.tabSurface,
                                      borderRadius: 8,
                                      boxShadow: t.tabShadow,
                                      height: 9,
                                      width: "42%",
                                    }}
                                  />
                                </div>
                                <span
                                  {...stylex.props(s.swatchLine)}
                                  style={{
                                    backgroundColor: t.accent,
                                    width: "45%",
                                  }}
                                />
                                <span
                                  {...stylex.props(s.swatchLine)}
                                  style={{
                                    backgroundColor: t.text,
                                    width: "70%",
                                  }}
                                />
                                <span
                                  {...stylex.props(s.swatchLine)}
                                  style={{
                                    backgroundColor: t.muted,
                                    width: "55%",
                                  }}
                                />
                                <span
                                  {...stylex.props(s.swatchLine)}
                                  style={{
                                    backgroundColor: t.accent,
                                    width: "30%",
                                  }}
                                />
                              </div>
                              <div {...stylex.props(s.themeLabel)}>
                                {t.name}
                                <span {...stylex.props(s.checkSlot)}>
                                  <AnimatePresence initial={false}>
                                    {selected && (
                                      <StateIcon key="selected">
                                        <Check size={14} />
                                      </StateIcon>
                                    )}
                                  </AnimatePresence>
                                </span>
                              </div>
                            </RadioGroup.Item>
                          );
                        })}
                    </RadioGroup.Root>
                  </div>
                ))}
                <div {...stylex.props(s.row)} style={{ border: 0, marginTop: 14 }}>
                  <label htmlFor="font-size" {...stylex.props(s.subtle)}>
                    Terminal text size
                  </label>
                  <div style={{ alignItems: "center", display: "flex", gap: 12 }}>
                    <Input
                      id="font-size"
                      max="22"
                      min="11"
                      onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                      type="range"
                      value={settings.fontSize}
                    />
                    <span {...stylex.props(s.subtle, s.numeric)}>{settings.fontSize} px</span>
                  </div>
                </div>
                <p {...stylex.props(s.subtle)}>
                  System follows your Mac. Your light and dark palettes are remembered separately.
                </p>
              </Modal>
            )}
            {modal === "background" && (
              <Modal
                error={error}
                key="background"
                onClose={closeModal}
                onDismissError={() => setError("")}
                subtitle="Hidden from your workspace. Running on your Mac."
                title="Still at work."
              >
                {background.length === 0 ? (
                  <div {...stylex.props(s.empty)}>
                    <Layers size={26} style={{ marginBottom: 10, opacity: 0.5 }} />
                    <div>No background sessions yet.</div>
                    <div>Hide a tab or pane to keep it running here.</div>
                  </div>
                ) : (
                  background.map((t) => (
                    <div key={t.id} {...stylex.props(s.sessionRow)}>
                      <span {...stylex.props(s.glyph)}>
                        <Terminal size={14} />
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div {...stylex.props(s.sessionName)}>{t.name}</div>
                        <div {...stylex.props(s.subtle)}>
                          {leaves(t.layout).length}{" "}
                          {leaves(t.layout).length === 1 ? "terminal" : "terminals"} ·{" "}
                          {leaves(t.layout).every((id) => workspace?.panes[id].status === "exited")
                            ? "exited"
                            : "running"}
                        </div>
                      </div>
                      {terminateId === t.id ? (
                        <div {...stylex.props(s.confirmation)}>
                          <p {...stylex.props(s.subtle)}>
                            End this session and all its processes? This cannot be undone.
                          </p>
                          <Button
                            {...stylex.props(s.textButton)}
                            onClick={() => setTerminateId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            {...stylex.props(s.textButton, s.danger)}
                            onClick={async () => {
                              const result = await run({
                                tabId: t.id,
                                type: "terminate",
                              });
                              if (result) {
                                setTerminateId(null);
                              }
                            }}
                          >
                            End processes
                          </Button>
                        </div>
                      ) : (
                        <>
                          <Button
                            {...stylex.props(s.iconButton)}
                            aria-label={`Terminate ${t.name}`}
                            onClick={() => setTerminateId(t.id)}
                            title="Terminate this session and its processes"
                          >
                            <Trash2 size={14} />
                          </Button>
                          <Button
                            {...stylex.props(s.primary)}
                            onClick={async () => {
                              const result = await run({
                                tabId: t.id,
                                type: "restore",
                              });
                              if (result) {
                                closeModal();
                              }
                            }}
                          >
                            Restore <ArrowUpRight size={13} />
                          </Button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </Modal>
            )}
            {modal === "commands" && (
              <Modal
                error={error}
                key="commands"
                onClose={closeModal}
                onDismissError={() => setError("")}
                title="Command palette"
                variant="command"
              >
                <CommandPalette
                  groups={[
                    {
                      items: commandList.map((command) => ({
                        disabled: command.disabled,
                        hint: command.hint,
                        icon: <command.icon size={16} />,
                        label: command.label,
                        onSelect: () => {
                          closeModal();
                          command.fn();
                        },
                        value: command.label,
                      })),
                      label: "Commands",
                    },
                    {
                      items: ordered.map((tab) => ({
                        hint: tab.id === active?.id ? <Check size={14} /> : undefined,
                        icon: <Terminal size={16} />,
                        label: tab.customName
                          ? tab.name
                          : `${tab.name} — ${workspace?.panes[leaves(tab.layout)[0]]?.command || "zsh"}`,
                        onSelect: () => {
                          select(tab.id);
                          closeModal();
                        },
                        value: tab.id,
                      })),
                      label: "Open tabs",
                    },
                  ]}
                  onQueryChange={setQuery}
                  query={query}
                  status={
                    connection === "paired"
                      ? `${machine?.name || "This Mac"} · Connected locally`
                      : connection === "unpaired"
                        ? "Pair this browser to connect to your Mac."
                        : "Companion offline. Start it on this Mac to reconnect."
                  }
                />
              </Modal>
            )}
            {modal === "shortcuts" && (
              <Modal
                error={error}
                key="shortcuts"
                onClose={closeModal}
                onDismissError={() => setError("")}
                subtitle="A few small shortcuts. A lot less clicking."
                title="Keep your hands on the keys."
              >
                {shortcuts.map(([label, key]) => (
                  <div key={label} {...stylex.props(s.row)}>
                    <span style={{ fontSize: 12 }}>{label}</span>
                    <kbd {...stylex.props(s.key)}>{key}</kbd>
                  </div>
                ))}
                <p {...stylex.props(s.subtle)} style={{ marginTop: 16 }}>
                  Your shell keeps its Control shortcuts. Double-click a divider to balance panes,
                  or use its arrow keys to resize and Home to balance. Use Alt + arrow keys on a tab
                  to reorder it.
                </p>
              </Modal>
            )}
            {modal === "rename" && (
              <Modal
                error={error}
                key="rename"
                onClose={closeModal}
                onDismissError={() => setError("")}
                subtitle="Make this little corner of your workspace easy to find."
                title="Give it a name."
              >
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (!rename.trim()) {
                      setRenameError("Enter a name for this tab.");
                      return;
                    }
                    if (rename.trim()) {
                      setBusy(true);
                      const result = await run({
                        name: rename.trim(),
                        tabId: renameId,
                        type: "rename",
                      });
                      setBusy(false);
                      if (result) {
                        closeModal();
                      }
                    }
                  }}
                >
                  <TextField
                    error={renameError}
                    id="tab-name"
                    label="Tab name"
                    maxLength={80}
                    onValueChange={setRename}
                    value={rename}
                  />
                  <Button
                    type="submit"
                    {...stylex.props(s.primary)}
                    disabled={busy}
                    style={{ marginTop: 16 }}
                  >
                    {busy ? "Saving name…" : "Save name"} <Check size={14} />
                  </Button>
                </form>
              </Modal>
            )}
          </AnimatePresence>
          <div role="status" {...stylex.props(s.srOnly)}>
            {toast}
          </div>
          <div {...stylex.props(s.toastPosition)}>
            <AnimatePresence initial={false}>
              {!modal && (error || toast) && (
                <motion.div
                  key="toast"
                  role="img"
                  {...stylex.props(s.toast)}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: 7 }}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 7 }}
                >
                  <span>{error || toast}</span>
                  <Button
                    {...stylex.props(s.iconButton, s.tinyButton)}
                    aria-label="Dismiss notification"
                    onClick={() => {
                      setError("");
                      setToast("");
                    }}
                  >
                    <X size={15} />
                  </Button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </OverlayContainer.Provider>
    </MotionConfig>
  );
}
