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
    <box flexShrink={0} paddingTop={1} paddingLeft={1}>
      <text fg={toRGBA(props.theme.fgMuted)}>Enter:open c:claude o:edit H:hidden q:quit</text>
    </box>
  );
}
