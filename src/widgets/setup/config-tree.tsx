import { createSignal, createMemo } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import { flattenConfigTree, validateSetupConfig, addPane, type TreeNode } from "./setup-model.ts";
import type { IdeConfig } from "../../schemas/ide-config.ts";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface ConfigTreeProps {
  config: IdeConfig;
  onEditField: (path: string[]) => void;
  onAddPane: (rowIdx: number) => void;
  onDelete: (path: string[]) => void;
  onSave: (config: IdeConfig) => void;
  onConfigChange: (config: IdeConfig) => void;
  theme: WidgetTheme;
}

/** Check if a path is a row-level container (e.g. ["rows", "0"]). */
function isRowPath(path: string[]): boolean {
  return path.length === 2 && path[0] === "rows" && /^\d+$/.test(path[1]!);
}

/** Extract row index from a pane-level path (e.g. ["rows","0","panes","1","title"] → 0). */
function rowIndexFromPath(path: string[]): number | null {
  if (path.length >= 2 && path[0] === "rows" && /^\d+$/.test(path[1]!)) {
    return parseInt(path[1]!, 10);
  }
  return null;
}

export function ConfigTree(props: ConfigTreeProps) {
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [inputMode, setInputMode] = createSignal<"keyboard" | "mouse">("keyboard");

  const theme = props.theme;

  const allNodes = createMemo(() => flattenConfigTree(props.config));

  // Filter out children of collapsed nodes
  const visibleNodes = createMemo(() => {
    const all = allNodes();
    const collapsedSet = collapsed();
    const result: TreeNode[] = [];
    for (const node of all) {
      // Check if any ancestor is collapsed
      let hidden = false;
      for (let len = 1; len < node.path.length; len++) {
        const ancestorKey = node.path.slice(0, len).join(".");
        if (collapsedSet.has(ancestorKey)) {
          hidden = true;
          break;
        }
      }
      if (!hidden) result.push(node);
    }
    return result;
  });

  const validation = createMemo(() => validateSetupConfig(props.config));

  function toggleCollapse(node: TreeNode) {
    const key = node.path.join(".");
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function isCollapsed(node: TreeNode): boolean {
    return collapsed().has(node.path.join("."));
  }

  useKeyboard((evt) => {
    setInputMode("keyboard");

    // Delete confirmation mode
    if (confirmDelete() !== null) {
      if (evt.name === "y") {
        const pathStr = confirmDelete()!;
        setConfirmDelete(null);
        props.onDelete(pathStr.split("."));
        evt.preventDefault();
        return;
      }
      setConfirmDelete(null);
      evt.preventDefault();
      return;
    }

    const nodes = visibleNodes();

    if (evt.name === "k" || evt.name === "up") {
      setSelectedIndex((i) => Math.max(0, i - 1));
      evt.preventDefault();
    } else if (evt.name === "j" || evt.name === "down") {
      setSelectedIndex((i) => Math.min(nodes.length - 1, i + 1));
      evt.preventDefault();
    } else if (evt.name === "return") {
      const node = nodes[selectedIndex()];
      if (!node) return;
      if (node.expandable) {
        toggleCollapse(node);
      } else {
        props.onEditField(node.path);
      }
      evt.preventDefault();
    } else if (evt.name === "a") {
      const node = nodes[selectedIndex()];
      if (!node) return;
      const rowIdx = rowIndexFromPath(node.path);
      if (rowIdx !== null) {
        props.onAddPane(rowIdx);
      }
      evt.preventDefault();
    } else if (evt.name === "d") {
      const node = nodes[selectedIndex()];
      if (!node) return;
      setConfirmDelete(node.path.join("."));
      evt.preventDefault();
    } else if (evt.ctrl && evt.name === "s") {
      props.onSave(props.config);
      evt.preventDefault();
    }
  });

  function nodeLabel(node: TreeNode): string {
    const indent = "  ".repeat(node.depth);
    const prefix = node.expandable ? (isCollapsed(node) ? "▸ " : "▾ ") : "  ";
    if (node.value !== null) {
      return `${indent}${prefix}${node.label}: ${node.value}`;
    }
    return `${indent}${prefix}${node.label}`;
  }

  return (
    <box paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box flexShrink={0} flexDirection="row" justifyContent="space-between" paddingBottom={1}>
        <text fg={toRGBA(theme.accent)} attributes={TextAttributes.BOLD}>
          Config Editor
        </text>
        <text fg={toRGBA(theme.fgMuted)} onMouseUp={() => props.onSave(props.config)}>
          Ctrl+S:save
        </text>
      </box>

      {/* Tree */}
      <box flexGrow={1}>
        {visibleNodes().map((node, index) => {
          const isSelected = () => selectedIndex() === index;
          const isRow = isRowPath(node.path);
          return (
            <box
              flexShrink={0}
              backgroundColor={isSelected() ? toRGBA(theme.selected) : undefined}
              onMouseMove={() => {
                setInputMode("mouse");
                setSelectedIndex(index);
              }}
              onMouseDown={() => setSelectedIndex(index)}
              onMouseUp={() => {
                if (node.expandable) toggleCollapse(node);
                else props.onEditField(node.path);
              }}
            >
              <box flexDirection="row">
                <text
                  fg={toRGBA(
                    isSelected() ? theme.accent : node.expandable ? theme.fg : theme.fgMuted,
                  )}
                  attributes={isSelected() ? TextAttributes.BOLD : 0}
                  wrapMode="none"
                >
                  {nodeLabel(node)}
                </text>
                {isSelected() && isRow ? (
                  <text fg={toRGBA(theme.fgMuted)}> [a:add pane]</text>
                ) : null}
              </box>
            </box>
          );
        })}
      </box>

      {/* Delete confirmation */}
      {confirmDelete() !== null ? (
        <box flexShrink={0} paddingTop={1}>
          <text fg={toRGBA(theme.gitDeleted)} attributes={TextAttributes.BOLD}>
            Delete {confirmDelete()}? y/n
          </text>
        </box>
      ) : null}

      {/* Validation status */}
      <box flexShrink={0} paddingTop={1}>
        {validation().valid ? (
          <text fg={toRGBA(theme.gitAdded)}>Config valid</text>
        ) : (
          <box>
            <text fg={toRGBA(theme.gitDeleted)} attributes={TextAttributes.BOLD}>
              Validation errors:
            </text>
            {(validation() as { valid: false; errors: string[] }).errors.slice(0, 3).map((err) => (
              <text fg={toRGBA(theme.gitDeleted)}> {err}</text>
            ))}
          </box>
        )}
      </box>

      {/* Footer */}
      <box flexShrink={0}>
        <box flexShrink={0} height={1}>
          <text fg={toRGBA(theme.border)} wrapMode="none">
            {"─".repeat(40)}
          </text>
        </box>
        <box flexDirection="row" gap={2}>
          <text fg={toRGBA(theme.fgMuted)}>j/k:nav</text>
          <text fg={toRGBA(theme.fgMuted)}>Enter:edit/toggle</text>
          <text fg={toRGBA(theme.fgMuted)}>a:add pane</text>
          <text fg={toRGBA(theme.fgMuted)}>d:delete</text>
          <text fg={toRGBA(theme.fgMuted)}>Ctrl+S:save</text>
        </box>
      </box>
    </box>
  );
}
