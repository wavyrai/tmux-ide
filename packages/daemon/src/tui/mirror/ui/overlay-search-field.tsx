/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminalEnd } from "../terminal-text.ts";

/** Search presentation only; the existing dialog owner handles editing and focus. */
export function OverlaySearchField(props: {
  theme: SemanticThemeSnapshot;
  width: number;
  query?: string;
  placeholder: string;
}) {
  const inset = () => (props.width >= 4 ? 1 : 0);
  return (
    <box
      width={props.width}
      height={1}
      flexShrink={0}
      backgroundColor={props.theme.roles.surfaces.panel}
      paddingLeft={inset()}
      paddingRight={inset()}
      overflow="hidden"
    >
      <text
        height={1}
        width={Math.max(1, props.width - inset() * 2)}
        fg={props.query ? props.theme.roles.text.primary : props.theme.roles.text.muted}
        content={clipTerminalEnd(
          props.query ? `${props.query}▏` : props.placeholder,
          Math.max(1, props.width - inset() * 2),
        )}
      />
    </box>
  );
}
