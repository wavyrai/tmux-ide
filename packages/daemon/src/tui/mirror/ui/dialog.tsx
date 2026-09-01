/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";

export interface DialogProps {
  theme: SemanticThemeSnapshot;
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
  title?: string;
  footer?: string;
  onDismiss: () => void;
  children?: JSX.Element;
}

export function Dialog(props: DialogProps) {
  const width = () => Math.max(1, Math.min(props.width, props.viewportWidth));
  const height = () => Math.max(3, Math.min(props.height, props.viewportHeight));
  const innerWidth = () => Math.max(1, width() - 2);
  return (
    <box
      id="ui-dialog-overlay"
      position="absolute"
      left={0}
      top={0}
      width={props.viewportWidth}
      height={props.viewportHeight}
      zIndex={100}
      onMouseDown={(event) => {
        event.stopPropagation();
        props.onDismiss();
      }}
    >
      <box
        id="ui-dialog-content"
        position="absolute"
        left={Math.max(0, Math.floor((props.viewportWidth - width()) / 2))}
        top={Math.max(0, Math.floor((props.viewportHeight - height()) / 2))}
        width={width()}
        height={height()}
        border
        borderStyle="rounded"
        borderColor={props.theme.roles.borders.focused}
        backgroundColor={props.theme.roles.surfaces.panelRaised}
        flexDirection="column"
        paddingLeft={1}
        overflow="hidden"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {props.title ? (
          <text width={innerWidth()} fg={props.theme.roles.text.primary} overflow="hidden">
            <strong>{clipTerminal(props.title, innerWidth())}</strong>
          </text>
        ) : null}
        {props.children}
        {props.footer ? (
          <text
            width={innerWidth()}
            fg={props.theme.roles.text.muted}
            overflow="hidden"
            content={clipTerminal(props.footer, innerWidth())}
          />
        ) : null}
      </box>
    </box>
  );
}
