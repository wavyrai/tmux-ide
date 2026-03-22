import { RGBA } from "@opentui/core";
import type { WidgetTheme, RGBA as RGBAType } from "../lib/theme.ts";

function toRGBA(c: RGBAType): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

export type ViewKind =
  | "detect"
  | "layout-picker"
  | "agent-naming"
  | "orchestrator"
  | "review"
  | "editor-tree"
  | "editor-field";

interface FooterProps {
  viewKind: ViewKind;
  theme: WidgetTheme;
}

const HINTS: Record<ViewKind, string> = {
  "detect": "Enter:continue  q:quit",
  "layout-picker": "j/k:navigate  Enter:select  q:quit",
  "agent-naming": "Tab:next field  Enter:continue  Esc:back  q:quit",
  "orchestrator": "Space:toggle  Enter:continue  Esc:back  q:quit",
  "review": "Enter:save & launch  e:edit  Esc:back  q:quit",
  "editor-tree": "j/k:nav  Enter:edit  a:add pane  d:delete  Ctrl+S:save  q:quit",
  "editor-field": "Enter:save  Esc:cancel",
};

export function Footer(props: FooterProps) {
  const theme = props.theme;
  return (
    <box flexShrink={0}>
      <box flexShrink={0} height={1}>
        <text fg={toRGBA(theme.border)} wrapMode="none">
          {"─".repeat(60)}
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={toRGBA(theme.fgMuted)} wrapMode="none">
          {HINTS[props.viewKind] ?? ""}
        </text>
      </box>
    </box>
  );
}
