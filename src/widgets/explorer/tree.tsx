import { createMemo, createEffect, For, Show } from "solid-js";
import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import type { TreeNode } from "./tree-model.ts";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

function getStatusDot(status: string): string {
  switch (status) {
    case "M":
      return "●";
    case "A":
      return "●";
    case "D":
      return "●";
    case "?":
      return "◌";
    default:
      return " ";
  }
}

function getStatusColor(
  status: string,
  theme: WidgetTheme,
): { r: number; g: number; b: number; a: number } {
  switch (status) {
    case "M":
      return theme.gitModified;
    case "A":
      return theme.gitAdded;
    case "D":
      return theme.gitDeleted;
    case "?":
      return theme.gitUntracked;
    default:
      return theme.fgMuted;
  }
}

function getFileIcon(name: string, isDir: boolean, expanded: boolean): string {
  if (isDir) return expanded ? "▾ " : "▸ ";

  const ext = name.includes(".") ? name.split(".").pop()?.toLowerCase() : "";
  switch (ext) {
    case "ts":
    case "tsx":
      return " ";
    case "js":
    case "jsx":
      return " ";
    case "json":
      return " ";
    case "md":
    case "mdx":
      return " ";
    case "yml":
    case "yaml":
      return " ";
    case "css":
    case "scss":
      return " ";
    case "html":
      return " ";
    case "sh":
    case "bash":
    case "zsh":
      return " ";
    case "toml":
      return " ";
    case "lock":
      return " ";
    case "gitignore":
    case "git":
      return " ";
    case "env":
      return " ";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "ico":
      return " ";
    default:
      return " ";
  }
}

function getNameColor(
  name: string,
  isDir: boolean,
  isSelected: boolean,
  theme: WidgetTheme,
): { r: number; g: number; b: number; a: number } {
  if (isSelected) return theme.selectedText;
  if (isDir) return theme.dirName;
  if (name.endsWith(".lock") || name.startsWith(".") || name === "LICENSE") {
    return theme.fgMuted;
  }
  return theme.fg;
}

interface FileTreeProps {
  nodes: TreeNode[];
  selected: number;
  theme: WidgetTheme;
  inputMode: "keyboard" | "mouse";
  onSelect: (index: number) => void;
  onToggleDir: (node: TreeNode) => void;
  onInputModeChange: (mode: "keyboard" | "mouse") => void;
}

export function FileTree(props: FileTreeProps) {
  let scroll: ScrollBoxRenderable | undefined;

  // Auto-scroll to keep selection visible
  createEffect(() => {
    const idx = props.selected;
    if (!scroll) return;
    const children = scroll.getChildren();
    const target = children[idx];
    if (!target) return;
    const y = target.y - scroll.y;
    if (y >= scroll.height) scroll.scrollBy(y - scroll.height + 1);
    if (y < 0) scroll.scrollBy(y);
  });

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => (scroll = r)}
      flexGrow={1}
      verticalScrollbarOptions={{
        trackOptions: {
          backgroundColor: toRGBA(props.theme.bg),
          foregroundColor: toRGBA(props.theme.accent),
        },
      }}
    >
      <For each={props.nodes}>
        {(node, index) => {
          const isSelected = createMemo(() => index() === props.selected);
          const indent = node.depth > 0 ? "│ ".repeat(node.depth) : "";
          const icon = getFileIcon(node.entry.name, node.entry.isDir, node.expanded);
          const nameColor = () =>
            getNameColor(node.entry.name, node.entry.isDir, isSelected(), props.theme);
          const rowBg = () =>
            isSelected()
              ? toRGBA(props.theme.selected)
              : index() % 2 === 1
                ? toRGBA(props.theme.rowAlt)
                : TRANSPARENT;

          return (
            <box
              id={String(index())}
              backgroundColor={rowBg()}
              flexDirection="row"
              onMouseMove={() => {
                props.onInputModeChange("mouse");
              }}
              onMouseDown={() => {
                props.onSelect(index());
              }}
              onMouseUp={() => {
                if (node.entry.isDir) {
                  props.onToggleDir(node);
                }
              }}
              onMouseOver={() => {
                if (props.inputMode !== "mouse") return;
                props.onSelect(index());
              }}
            >
              <Show when={node.depth > 0}>
                <text fg={toRGBA(props.theme.indentGuide)} wrapMode="none">
                  {indent}
                </text>
              </Show>
              <text fg={toRGBA(nameColor())} wrapMode="none" flexGrow={1}>
                {icon}
                {node.entry.name}
                {node.entry.isDir ? "/" : ""}
              </text>
              <Show when={node.gitStatus}>
                <text
                  fg={toRGBA(getStatusColor(node.gitStatus!, props.theme))}
                  flexShrink={0}
                  wrapMode="none"
                >
                  {getStatusDot(node.gitStatus!)}
                </text>
              </Show>
            </box>
          );
        }}
      </For>
    </scrollbox>
  );
}
