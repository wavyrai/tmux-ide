import { createMemo, createEffect, For, Show } from "solid-js";
import { RGBA, type ScrollBoxRenderable } from "@opentui/core";
import type { TreeNode } from "./tree-model.ts";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

const TRANSPARENT = RGBA.fromInts(0, 0, 0, 0);

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

interface FileTreeProps {
  nodes: TreeNode[];
  selected: number;
  theme: WidgetTheme;
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
          const indent = "  ".repeat(node.depth);
          const icon = node.entry.isDir ? (node.expanded ? "▾ " : "▸ ") : "  ";

          return (
            <box
              id={String(index())}
              backgroundColor={isSelected() ? toRGBA(props.theme.selected) : TRANSPARENT}
              flexDirection="row"
              justifyContent="space-between"
            >
              <text
                fg={isSelected() ? toRGBA(props.theme.selectedText) : toRGBA(props.theme.fg)}
                wrapMode="none"
                flexGrow={1}
              >
                {indent}
                {icon}
                {node.entry.name}
                {node.entry.isDir ? "/" : ""}
              </text>
              <Show when={node.gitStatus}>
                <text fg={toRGBA(getStatusColor(node.gitStatus!, props.theme))} flexShrink={0}>
                  {" "}
                  {node.gitStatus}
                </text>
              </Show>
            </box>
          );
        }}
      </For>
    </scrollbox>
  );
}
