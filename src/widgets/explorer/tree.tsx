import { createMemo, createEffect, For, Show } from "solid-js";
import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import type { TreeNode } from "./tree-model.ts";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

function getStatusLabel(status: string): string {
  switch (status) {
    case "M":
      return " M";
    case "A":
      return " A";
    case "D":
      return " D";
    case "?":
      return " ?";
    default:
      return "";
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

function getNameColor(
  name: string,
  isDir: boolean,
  isSelected: boolean,
  isIgnored: boolean,
  theme: WidgetTheme,
): { r: number; g: number; b: number; a: number } {
  if (isSelected) return theme.selectedText;
  if (isIgnored) return theme.ignored;
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
  onActivate: (node: TreeNode) => void;
  onInputModeChange: (mode: "keyboard" | "mouse") => void;
}

export function FileTree(props: FileTreeProps) {
  let scroll: ScrollBoxRenderable | undefined;

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
          const icon = node.entry.isDir ? "> " : "  ";
          const nameColor = () =>
            getNameColor(
              node.entry.name,
              node.entry.isDir,
              isSelected(),
              node.entry.ignored,
              props.theme,
            );
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
              paddingLeft={1}
              paddingRight={1}
              onMouseMove={() => {
                props.onInputModeChange("mouse");
                props.onSelect(index());
              }}
              onMouseDown={() => props.onSelect(index())}
              onMouseUp={() => {
                props.onActivate(node);
              }}
            >
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
                  {getStatusLabel(node.gitStatus!)}
                </text>
              </Show>
              <Show when={isSelected() && !node.entry.isDir}>
                <text fg={toRGBA(props.theme.fgMuted)} flexShrink={0} wrapMode="none">
                  {" c: send to claude code"}
                </text>
              </Show>
            </box>
          );
        }}
      </For>
    </scrollbox>
  );
}
