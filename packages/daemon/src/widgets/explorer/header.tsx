import { RGBA, TextAttributes } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface HeaderProps {
  branch: string | null;
  fileCount: number;
  theme: WidgetTheme;
}

export function Header(props: HeaderProps) {
  return (
    <box flexShrink={0} flexDirection="row" gap={1} paddingLeft={1} paddingBottom={1}>
      <text fg={toRGBA(props.theme.accent)} attributes={TextAttributes.BOLD}>
        {props.branch ? `⎇ ${props.branch}` : "FILES"}
      </text>
      <text fg={toRGBA(props.theme.fgMuted)}>{props.fileCount}</text>
    </box>
  );
}
