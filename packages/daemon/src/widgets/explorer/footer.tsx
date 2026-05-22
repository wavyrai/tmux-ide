import { RGBA } from "@opentui/core";
import type { WidgetTheme } from "../lib/theme.ts";

function toRGBA(c: { r: number; g: number; b: number; a: number }): RGBA {
  return RGBA.fromInts(c.r, c.g, c.b, c.a);
}

interface FooterProps {
  theme: WidgetTheme;
}

export function Footer(props: FooterProps) {
  return (
    <box flexShrink={0} paddingLeft={1} paddingTop={1}>
      <text fg={toRGBA(props.theme.fgMuted)} wrapMode="none">
        ↑↓:nav ⏎:enter ⌫:back /:search []:changes c:claude o:edit q:quit
      </text>
    </box>
  );
}
