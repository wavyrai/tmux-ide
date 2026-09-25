/* @jsxImportSource @opentui/solid */
import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal, terminalDisplayWidth } from "../terminal-text.ts";

/** Read-only information row: primary label left, secondary detail aligned right. */
export function DetailRow(props: {
  theme: SemanticThemeSnapshot;
  width: number;
  label: string;
  detail?: string;
  description?: string;
  attention?: boolean;
}) {
  const detailWidth = () =>
    props.detail
      ? Math.min(terminalDisplayWidth(props.detail), Math.floor(Math.max(0, props.width) / 2))
      : 0;
  const labelWidth = () => Math.max(0, props.width - detailWidth() - (detailWidth() ? 1 : 0));
  return (
    <box
      width={props.width}
      height={props.description ? 2 : 1}
      flexShrink={0}
      flexDirection="column"
      overflow="hidden"
    >
      <box width={props.width} height={1} flexShrink={0} flexDirection="row">
        <text
          width={labelWidth()}
          height={1}
          fg={props.attention ? props.theme.colors.status.blocked : props.theme.roles.text.primary}
        >
          {clipTerminal(props.label, labelWidth())}
        </text>
        <box flexGrow={1} />
        <text
          width={detailWidth()}
          height={1}
          fg={props.attention ? props.theme.colors.status.blocked : props.theme.roles.text.muted}
        >
          {clipTerminal(props.detail ?? "", detailWidth())}
        </text>
      </box>
      {props.description ? (
        <text width={props.width} height={1} fg={props.theme.roles.text.muted}>
          {clipTerminal(props.description, props.width)}
        </text>
      ) : null}
    </box>
  );
}
