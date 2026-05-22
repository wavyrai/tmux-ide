import { For, Show, createMemo } from "solid-js";
import { RGBA, TextAttributes } from "@opentui/core";
import { relative, basename, join } from "node:path";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface BreadcrumbsProps {
  projectRoot: string;
  currentDir: string;
  branch: string | null;
  theme: WidgetTheme;
  onNavigate: (absolutePath: string) => void;
}

interface BreadcrumbSegment {
  name: string;
  absolutePath: string;
  isLast: boolean;
}

export function Breadcrumbs(props: BreadcrumbsProps) {
  const segments = createMemo(() => {
    const rel = relative(props.projectRoot, props.currentDir);
    const parts = rel ? rel.split("/") : [];
    const result: BreadcrumbSegment[] = [
      {
        name: basename(props.projectRoot),
        absolutePath: props.projectRoot,
        isLast: parts.length === 0,
      },
    ];
    let currentPath = props.projectRoot;
    for (let i = 0; i < parts.length; i++) {
      currentPath = join(currentPath, parts[i]!);
      result.push({
        name: parts[i]!,
        absolutePath: currentPath,
        isLast: i === parts.length - 1,
      });
    }
    return result;
  });

  return (
    <box flexShrink={0} paddingLeft={1} paddingBottom={1} flexDirection="row" gap={0}>
      <Show when={props.branch}>
        <text fg={toRGBA(props.theme.accent)} attributes={TextAttributes.BOLD}>
          {"⎇ "}
          {props.branch}{" "}
        </text>
      </Show>
      <For each={segments()}>
        {(seg) => (
          <box flexDirection="row">
            <text
              fg={seg.isLast ? toRGBA(props.theme.fg) : toRGBA(props.theme.fgMuted)}
              attributes={seg.isLast ? TextAttributes.BOLD : undefined}
              onMouseUp={() => {
                if (!seg.isLast) {
                  props.onNavigate(seg.absolutePath);
                }
              }}
            >
              {seg.name}
            </text>
            <Show when={!seg.isLast}>
              <text fg={toRGBA(props.theme.border)}>{" / "}</text>
            </Show>
          </box>
        )}
      </For>
    </box>
  );
}
