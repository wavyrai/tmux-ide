import "@opentui/solid/runtime-plugin-support";
import { parseArgs } from "node:util";
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { RGBA, TextAttributes } from "@opentui/core";
import { createSignal, createMemo, Show } from "solid-js";
import { createTheme, type RGBA as RGBAType, type WidgetTheme } from "../lib/theme.ts";
import {
  flattenConfigTree,
  updateConfigAtPath,
  addPane,
  removePane,
  addRow,
  removeRow,
  validateSetupConfig,
  type TreeNode,
} from "../lib/config-model.ts";
import { readConfig, writeConfig } from "../../lib/yaml-io.ts";
import { hasSession } from "../../lib/tmux.ts";
import type { IdeConfig } from "../../schemas/ide-config.ts";
import { ConfigTree } from "../setup/config-tree.tsx";
import { FieldEditor, type FieldType } from "../setup/field-editor.tsx";

const { values } = parseArgs({
  options: {
    session: { type: "string" },
    dir: { type: "string" },
    theme: { type: "string" },
  },
});

const dir = values.dir ?? process.cwd();
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

type Tab = "layout" | "team" | "orchestrator" | "theme";
const TABS: { id: Tab; label: string }[] = [
  { id: "layout", label: "Layout" },
  { id: "team", label: "Team" },
  { id: "orchestrator", label: "Orch." },
  { id: "theme", label: "Theme" },
];

function inferFieldType(path: string[]): { type: FieldType; enumValues?: string[] } {
  const last = path[path.length - 1] ?? "";

  // Boolean fields
  if (["focus", "enabled", "auto_dispatch", "cleanup_on_done", "widgets"].includes(last)) {
    return { type: "boolean" };
  }

  // Enum fields
  if (last === "role") return { type: "enum", enumValues: ["lead", "teammate", "planner"] };
  if (last === "type")
    return {
      type: "enum",
      enumValues: ["explorer", "changes", "preview", "tasks", "costs", "config", "mission-control"],
    };
  if (last === "dispatch_mode") return { type: "enum", enumValues: ["tasks", "goals"] };

  // Size fields
  if (last === "size") return { type: "size" };

  // Number fields rendered as string (will be coerced)
  return { type: "string" };
}

function coerceValue(raw: unknown, path: string[]): unknown {
  if (typeof raw !== "string") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const last = path[path.length - 1] ?? "";
  if (["stall_timeout", "poll_interval", "max_concurrent_agents", "priority"].includes(last)) {
    const num = parseInt(raw, 10);
    if (!isNaN(num)) return num;
  }
  return raw;
}

function getValueAtPath(config: IdeConfig, path: string[]): string {
  let current: unknown = config;
  for (const key of path) {
    if (current === null || current === undefined) return "";
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return "";
    }
  }
  return current === null || current === undefined ? "" : String(current);
}

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();

    // Load config
    let initialConfig: IdeConfig;
    try {
      const result = readConfig(dir);
      initialConfig = result.config;
    } catch {
      console.error("No ide.yml found. Run 'tmux-ide init' first.");
      process.exit(1);
    }

    const [config, setConfig] = createSignal<IdeConfig>(initialConfig);
    const [savedConfig, setSavedConfig] = createSignal(JSON.stringify(initialConfig));
    const [activeTab, setActiveTab] = createSignal<Tab>("layout");
    const [editingField, setEditingField] = createSignal<string[] | null>(null);
    const [statusMsg, setStatusMsg] = createSignal<string | null>(null);

    const dirty = createMemo(() => JSON.stringify(config()) !== savedConfig());
    const validation = createMemo(() => validateSetupConfig(config()));

    function handleSave() {
      writeConfig(dir, config());
      setSavedConfig(JSON.stringify(config()));
      setStatusMsg("Saved");
      setTimeout(() => setStatusMsg(null), 2000);
    }

    function handleEditField(path: string[]) {
      setEditingField(path);
    }

    function handleFieldSave(path: string[], value: unknown) {
      const coerced = coerceValue(value, path);
      setConfig(updateConfigAtPath(config(), path, coerced));
      setEditingField(null);
    }

    function handleAddPane(rowIdx: number) {
      setConfig(addPane(config(), rowIdx));
    }

    function handleDelete(path: string[]) {
      // Handle row deletion
      if (path.length === 2 && path[0] === "rows" && /^\d+$/.test(path[1]!)) {
        setConfig(removeRow(config(), parseInt(path[1]!, 10)));
        return;
      }
      // Handle pane deletion
      if (path.length >= 4 && path[0] === "rows" && path[2] === "panes") {
        const rowIdx = parseInt(path[1]!, 10);
        const paneIdx = parseInt(path[3]!, 10);
        if (!isNaN(rowIdx) && !isNaN(paneIdx)) {
          setConfig(removePane(config(), rowIdx, paneIdx));
        }
      }
    }

    function handleConfigChange(newConfig: IdeConfig) {
      setConfig(newConfig);
    }

    // Tab-level keyboard handling (when not editing a field)
    useKeyboard((evt) => {
      if (editingField() !== null) return; // Let field editor handle keys

      if (evt.name === "tab") {
        const tabs = TABS.map((t) => t.id);
        const idx = tabs.indexOf(activeTab());
        setActiveTab(tabs[(idx + 1) % tabs.length]!);
        evt.preventDefault();
      } else if (evt.name === "q") {
        if (dirty()) {
          setStatusMsg("Unsaved changes! Ctrl+S to save, then q to quit.");
          setTimeout(() => setStatusMsg(null), 3000);
        } else {
          process.exit(0);
        }
        evt.preventDefault();
      } else if (evt.ctrl && evt.name === "s") {
        handleSave();
        evt.preventDefault();
      } else if (evt.ctrl && evt.name === "r") {
        handleSave();
        const sessionName = config().name ?? dir.split("/").pop() ?? "ide";
        if (hasSession(sessionName)) {
          const { execFileSync } = require("node:child_process");
          try {
            execFileSync("tmux-ide", ["restart"], { cwd: dir, stdio: "inherit" });
          } catch {
            /* restart may close our pane */
          }
        }
        process.exit(0);
      } else if (evt.name === "1") {
        setActiveTab("layout");
        evt.preventDefault();
      } else if (evt.name === "2") {
        setActiveTab("team");
        evt.preventDefault();
      } else if (evt.name === "3") {
        setActiveTab("orchestrator");
        evt.preventDefault();
      } else if (evt.name === "4") {
        setActiveTab("theme");
        evt.preventDefault();
      }
    });

    // Team panel: simple form for team config
    function TeamPanel() {
      const cfg = config();
      const teamEnabled = !!cfg.team;
      const teamName = cfg.team?.name ?? "";

      const panes: { row: number; pane: number; title: string; role: string | undefined }[] = [];
      cfg.rows.forEach((row, ri) => {
        row.panes.forEach((p, pi) => {
          panes.push({ row: ri, pane: pi, title: p.title ?? `Row ${ri} Pane ${pi}`, role: p.role });
        });
      });

      return (
        <box paddingLeft={1}>
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            Team Configuration
          </text>
          <box paddingTop={1}>
            <text fg={toRGBA(theme.fg)}>
              Team: {teamEnabled ? `enabled (${teamName})` : "disabled"}
            </text>
          </box>
          <box paddingTop={1}>
            <text fg={toRGBA(theme.fgMuted)}>
              {teamEnabled
                ? "Use 'tmux-ide config disable-team' to disable"
                : "Use 'tmux-ide config enable-team --name <N>' to enable"}
            </text>
          </box>
          <box paddingTop={1}>
            <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
              Pane Roles
            </text>
          </box>
          {panes.map((p) => (
            <box paddingLeft={1}>
              <text fg={toRGBA(theme.fg)}>
                {p.title}: {p.role ?? "none"}
              </text>
            </box>
          ))}
        </box>
      );
    }

    // Orchestrator panel: display orchestrator settings
    function OrchestratorPanel() {
      const cfg = config();
      const orch = cfg.orchestrator;
      const fields: [string, string][] = [
        ["enabled", String(orch?.enabled ?? false)],
        ["auto_dispatch", String(orch?.auto_dispatch ?? true)],
        ["dispatch_mode", orch?.dispatch_mode ?? "tasks"],
        ["poll_interval", String(orch?.poll_interval ?? 5000)],
        ["stall_timeout", String(orch?.stall_timeout ?? 300000)],
        ["max_concurrent_agents", String(orch?.max_concurrent_agents ?? 10)],
        ["worktree_root", orch?.worktree_root ?? ".worktrees/"],
        ["cleanup_on_done", String(orch?.cleanup_on_done ?? false)],
        ["widgets", String(orch?.widgets ?? false)],
      ];

      return (
        <box paddingLeft={1}>
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            Orchestrator Settings
          </text>
          <box paddingTop={1}>
            {fields.map(([key, val]) => (
              <box flexDirection="row" gap={1}>
                <text fg={toRGBA(theme.fgMuted)}>{key!.padEnd(24)}</text>
                <text fg={toRGBA(theme.fg)}>{val}</text>
              </box>
            ))}
          </box>
          <box paddingTop={1}>
            <text fg={toRGBA(theme.fgMuted)}>
              Edit via Layout tab or: tmux-ide config set orchestrator.enabled true
            </text>
          </box>
        </box>
      );
    }

    // Theme panel: display theme settings
    function ThemePanel() {
      const cfg = config();
      const t = cfg.theme;
      const fields: [string, string][] = [
        ["accent", t?.accent ?? "(default)"],
        ["border", t?.border ?? "(default)"],
        ["bg", t?.bg ?? "(default)"],
        ["fg", t?.fg ?? "(default)"],
      ];

      return (
        <box paddingLeft={1}>
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            Theme Colors
          </text>
          <box paddingTop={1}>
            {fields.map(([key, val]) => (
              <box flexDirection="row" gap={1}>
                <text fg={toRGBA(theme.fgMuted)}>{key!.padEnd(12)}</text>
                <text fg={toRGBA(theme.fg)}>{val}</text>
              </box>
            ))}
          </box>
          <box paddingTop={1}>
            <text fg={toRGBA(theme.fgMuted)}>
              Edit via Layout tab or: tmux-ide config set theme.accent colour75
            </text>
          </box>
        </box>
      );
    }

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
        flexDirection="column"
      >
        {/* Title bar */}
        <box
          flexShrink={0}
          flexDirection="row"
          justifyContent="space-between"
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
            Settings
          </text>
          <box flexDirection="row" gap={2}>
            {dirty() ? <text fg={toRGBA(theme.gitModified)}>unsaved</text> : null}
            <text fg={toRGBA(theme.fgMuted)}>Ctrl+S:save</text>
          </box>
        </box>

        {/* Main content */}
        <box flexGrow={1} flexDirection="row">
          {/* Tab sidebar */}
          <box flexShrink={0} width={10} paddingLeft={1}>
            {TABS.map((tab) => {
              const isActive = () => activeTab() === tab.id;
              return (
                <box
                  flexShrink={0}
                  backgroundColor={isActive() ? toRGBA(theme.selected) : undefined}
                  onMouseUp={() => setActiveTab(tab.id)}
                >
                  <text
                    fg={toRGBA(isActive() ? theme.accent : theme.fgMuted)}
                    attributes={isActive() ? TextAttributes.BOLD : 0}
                  >
                    {isActive() ? ">" : " "} {tab.label}
                  </text>
                </box>
              );
            })}
          </box>

          {/* Content area */}
          <box flexGrow={1}>
            <Show
              when={editingField() !== null}
              fallback={
                <>
                  <Show when={activeTab() === "layout"}>
                    <ConfigTree
                      config={config()}
                      onEditField={handleEditField}
                      onAddPane={handleAddPane}
                      onDelete={handleDelete}
                      onSave={handleSave}
                      onConfigChange={handleConfigChange}
                      theme={theme}
                    />
                  </Show>
                  <Show when={activeTab() === "team"}>
                    <TeamPanel />
                  </Show>
                  <Show when={activeTab() === "orchestrator"}>
                    <OrchestratorPanel />
                  </Show>
                  <Show when={activeTab() === "theme"}>
                    <ThemePanel />
                  </Show>
                </>
              }
            >
              <FieldEditor
                path={editingField()!}
                value={getValueAtPath(config(), editingField()!)}
                fieldType={inferFieldType(editingField()!).type}
                enumValues={inferFieldType(editingField()!).enumValues}
                onSave={handleFieldSave}
                onCancel={() => setEditingField(null)}
                theme={theme}
              />
            </Show>
          </box>
        </box>

        {/* Status bar */}
        <box flexShrink={0} paddingLeft={1} paddingRight={1}>
          <box flexShrink={0} height={1}>
            <text fg={toRGBA(theme.border)} wrapMode="none">
              {"─".repeat(Math.max(1, dimensions().width - 2))}
            </text>
          </box>
          <box flexDirection="row" gap={2}>
            {validation().valid ? (
              <text fg={toRGBA(theme.gitAdded)}>Valid</text>
            ) : (
              <text fg={toRGBA(theme.gitDeleted)}>Invalid</text>
            )}
            {statusMsg() ? <text fg={toRGBA(theme.accent)}>{statusMsg()}</text> : null}
            <text fg={toRGBA(theme.fgMuted)}>Tab:switch</text>
            <text fg={toRGBA(theme.fgMuted)}>1-4:tabs</text>
            <text fg={toRGBA(theme.fgMuted)}>Ctrl+R:restart</text>
            <text fg={toRGBA(theme.fgMuted)}>q:quit</text>
          </box>
        </box>
      </box>
    );
  },
  {
    targetFps: 30,
    exitOnCtrlC: true,
    useKittyKeyboard: {},
    autoFocus: false,
  },
);
