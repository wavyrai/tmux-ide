import "@opentui/solid/runtime-plugin-support";
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { render, useTerminalDimensions } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { createSignal, Switch, Match } from "solid-js";
import { createTheme, type RGBA as RGBAType } from "../lib/theme.ts";
import { detectStack } from "../../detect.ts";
import { readConfig, writeConfig } from "../../lib/yaml-io.ts";
import {
  PRESETS,
  flattenConfigTree,
  updateConfigAtPath,
  addPane,
  removePane,
  validateSetupConfig,
  type LayoutPreset,
  type TreeNode,
} from "./setup-model.ts";
import type { IdeConfig } from "../../schemas/ide-config.ts";
import { DetectPanel, type DetectedStackInfo } from "./detect-panel.tsx";
import { LayoutPicker } from "./layout-picker.tsx";
import { AgentNaming } from "./agent-naming.tsx";
import { ConfigTree } from "./config-tree.tsx";
import { FieldEditor, type FieldType } from "./field-editor.tsx";
import { Footer, type ViewKind, type FooterActions } from "./footer.tsx";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    theme: { type: "string" },
    wizard: { type: "boolean" },
    edit: { type: "boolean" },
  },
});

const dir = values.dir ?? process.cwd();
const themeConfig = values.theme ? JSON.parse(values.theme) : undefined;
const forceWizard = values.wizard ?? false;
const forceEdit = values.edit ?? false;

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

// Determine field type from path for the field editor
function inferFieldType(path: string[]): { type: FieldType; enumValues?: string[] } {
  const last = path[path.length - 1];
  if (last === "role") return { type: "enum", enumValues: ["lead", "teammate", "planner"] };
  if (last === "type")
    return {
      type: "enum",
      enumValues: ["explorer", "changes", "preview", "tasks", "costs", "config", "mission-control"],
    };
  if (last === "dispatch_mode") return { type: "enum", enumValues: ["tasks", "goals"] };
  if (
    last === "focus" ||
    last === "enabled" ||
    last === "auto_dispatch" ||
    last === "cleanup_on_done" ||
    last === "widgets"
  )
    return { type: "boolean" };
  if (last === "size") return { type: "size" };
  return { type: "string" };
}

// Get current value at a path from config
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

type View =
  | { kind: "detect" }
  | { kind: "layout-picker" }
  | { kind: "agent-naming"; config: IdeConfig }
  | { kind: "orchestrator" }
  | { kind: "review"; config: IdeConfig }
  | { kind: "editor-tree" }
  | { kind: "editor-field"; path: string[] };

render(
  () => {
    const theme = createTheme(themeConfig);
    const dimensions = useTerminalDimensions();

    // Detect project stack once
    const detected = detectStack(dir);
    const detectedInfo: DetectedStackInfo = {
      packageManager: detected.packageManager,
      language: detected.language,
      frameworks: detected.frameworks,
      devCommand: detected.devCommand,
    };

    // Determine initial view
    const hasConfig = existsSync(join(dir, "ide.yml"));
    const initialView: View =
      forceEdit && hasConfig
        ? { kind: "editor-tree" }
        : forceWizard || !hasConfig
          ? { kind: "detect" }
          : { kind: "editor-tree" };

    const [view, setView] = createSignal<View>(initialView);

    // Config state — loaded from file for editor mode, built from wizard flow
    const initialConfig: IdeConfig = hasConfig
      ? readConfig(dir).config
      : { name: dir.split("/").pop() ?? "project", rows: [{ panes: [{ title: "Shell" }] }] };
    const [config, setConfig] = createSignal<IdeConfig>(initialConfig);

    function viewKind(): ViewKind {
      return view().kind;
    }

    function footerActions(): FooterActions {
      const quit = () => process.exit(0);
      const kind = view().kind;

      switch (kind) {
        case "detect":
          return {
            onConfirm: () => setView({ kind: "layout-picker" }),
            onQuit: quit,
          };
        case "layout-picker":
          return { onQuit: quit };
        case "agent-naming":
          return {
            onBack: () => setView({ kind: "layout-picker" }),
            onQuit: quit,
          };
        case "orchestrator":
          return {
            onBack: () => setView({ kind: "agent-naming", config: config() }),
            onQuit: quit,
          };
        case "review":
          return {
            onBack: () => setView({ kind: "agent-naming", config: config() }),
            onQuit: quit,
          };
        case "editor-tree":
          return {
            onSave: () => handleSaveOnly(config()),
            onQuit: quit,
          };
        case "editor-field":
          return {
            onBack: () => {
              if (hasConfig && !forceWizard) {
                setView({ kind: "editor-tree" });
              } else {
                setView({ kind: "review", config: config() });
              }
            },
          };
        default:
          return { onQuit: quit };
      }
    }

    function handleSaveAndLaunch(cfg: IdeConfig) {
      writeConfig(dir, cfg);
      try {
        execFileSync("tmux-ide", [], { cwd: dir, stdio: "inherit" });
      } catch {
        // tmux-ide may not be in PATH when running as widget
      }
      process.exit(0);
    }

    function handleSaveOnly(cfg: IdeConfig) {
      writeConfig(dir, cfg);
      process.exit(0);
    }

    return (
      <box
        width={dimensions().width}
        height={dimensions().height}
        backgroundColor={toRGBA(theme.bg)}
      >
        <box flexGrow={1}>
          <Switch>
            {/* Wizard flow */}
            <Match when={view().kind === "detect"}>
              <DetectPanel
                detected={detectedInfo}
                onContinue={() => setView({ kind: "layout-picker" })}
                theme={theme}
              />
            </Match>

            <Match when={view().kind === "layout-picker"}>
              <LayoutPicker
                presets={PRESETS}
                onSelect={(preset: LayoutPreset) => {
                  const name = dir.split("/").pop() ?? "project";
                  const cfg = preset.buildConfig(name, {
                    devCommand: detected.devCommand,
                    packageManager: detected.packageManager,
                  });
                  setConfig(cfg);

                  // If preset has claude panes, go to agent naming
                  const hasClaude = cfg.rows.some((r) =>
                    r.panes.some((p) => p.command === "claude"),
                  );
                  if (hasClaude) {
                    setView({ kind: "agent-naming", config: cfg });
                  } else {
                    setView({ kind: "review", config: cfg });
                  }
                }}
                theme={theme}
              />
            </Match>

            <Match when={view().kind === "agent-naming"}>
              <AgentNaming
                config={config()}
                onContinue={(names: string[]) => {
                  let cfg = config();
                  let nameIdx = 0;
                  // Apply names to claude panes
                  for (let ri = 0; ri < cfg.rows.length; ri++) {
                    for (let pi = 0; pi < cfg.rows[ri]!.panes.length; pi++) {
                      if (cfg.rows[ri]!.panes[pi]!.command === "claude" && nameIdx < names.length) {
                        cfg = updateConfigAtPath(
                          cfg,
                          ["rows", String(ri), "panes", String(pi), "title"],
                          names[nameIdx],
                        );
                        nameIdx++;
                      }
                    }
                  }
                  setConfig(cfg);
                  setView({ kind: "review", config: cfg });
                }}
                theme={theme}
              />
            </Match>

            <Match when={view().kind === "review"}>
              <ConfigTree
                config={config()}
                onEditField={(path) => setView({ kind: "editor-field", path })}
                onAddPane={(rowIdx) => {
                  setConfig(addPane(config(), rowIdx));
                }}
                onDelete={(path) => {
                  // Handle pane deletion: path like ["rows","0","panes","1"]
                  if (path.length === 4 && path[0] === "rows" && path[2] === "panes") {
                    const rowIdx = parseInt(path[1]!, 10);
                    const paneIdx = parseInt(path[3]!, 10);
                    setConfig(removePane(config(), rowIdx, paneIdx));
                  }
                }}
                onSave={(cfg) => handleSaveAndLaunch(cfg)}
                onConfigChange={(cfg) => setConfig(cfg)}
                theme={theme}
              />
            </Match>

            {/* Editor flow */}
            <Match when={view().kind === "editor-tree"}>
              <ConfigTree
                config={config()}
                onEditField={(path) => setView({ kind: "editor-field", path })}
                onAddPane={(rowIdx) => {
                  setConfig(addPane(config(), rowIdx));
                }}
                onDelete={(path) => {
                  if (path.length === 4 && path[0] === "rows" && path[2] === "panes") {
                    const rowIdx = parseInt(path[1]!, 10);
                    const paneIdx = parseInt(path[3]!, 10);
                    setConfig(removePane(config(), rowIdx, paneIdx));
                  }
                }}
                onSave={(cfg) => handleSaveOnly(cfg)}
                onConfigChange={(cfg) => setConfig(cfg)}
                theme={theme}
              />
            </Match>

            <Match when={view().kind === "editor-field"}>
              {(() => {
                const v = view() as Extract<View, { kind: "editor-field" }>;
                const fieldInfo = inferFieldType(v.path);
                return (
                  <FieldEditor
                    path={v.path}
                    value={getValueAtPath(config(), v.path)}
                    fieldType={fieldInfo.type}
                    enumValues={fieldInfo.enumValues}
                    onSave={(path, newValue) => {
                      setConfig(updateConfigAtPath(config(), path, newValue));
                      // Return to appropriate tree view
                      const prev = view();
                      // Check if we came from editor or wizard review
                      if (hasConfig && !forceWizard) {
                        setView({ kind: "editor-tree" });
                      } else {
                        setView({ kind: "review", config: config() });
                      }
                    }}
                    onCancel={() => {
                      if (hasConfig && !forceWizard) {
                        setView({ kind: "editor-tree" });
                      } else {
                        setView({ kind: "review", config: config() });
                      }
                    }}
                    theme={theme}
                  />
                );
              })()}
            </Match>
          </Switch>
        </box>

        <Footer viewKind={viewKind()} theme={theme} actions={footerActions()} />
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
