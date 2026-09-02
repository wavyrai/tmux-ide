/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { overlayFrameSize, type OverlayPlacement } from "./overlay-model.ts";

export interface OverlayFrameProps {
  theme: SemanticThemeSnapshot;
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
  title?: string;
  footer?: string;
  placement?: OverlayPlacement;
  anchor?: Readonly<{ x: number; y: number }>;
  modal?: boolean;
  active?: boolean;
  zIndex?: number;
  dismissOnOutsidePress?: boolean;
  onDismiss?: () => void;
  children?: JSX.Element;
}

/** Owns modal geometry and pointer capture without owning commands or renderer lifecycle. */
export function OverlayFrame(props: OverlayFrameProps) {
  const viewportWidth = () => Math.max(1, Math.floor(props.viewportWidth));
  const viewportHeight = () => Math.max(1, Math.floor(props.viewportHeight));
  const size = () =>
    overlayFrameSize({
      viewportWidth: viewportWidth(),
      viewportHeight: viewportHeight(),
      preferredWidth: props.width,
      preferredHeight: props.height,
    });
  const width = () => size().width;
  const height = () => size().height;
  const innerWidth = () => Math.max(1, width() - 2);
  const left = () => {
    if (props.placement === "anchor")
      return Math.max(0, Math.min(props.anchor?.x ?? 0, viewportWidth() - width()));
    if (props.placement === "top-right") return Math.max(0, viewportWidth() - width() - 1);
    return Math.max(0, Math.floor((viewportWidth() - width()) / 2));
  };
  const top = () => {
    if (props.placement === "anchor")
      return Math.max(0, Math.min(props.anchor?.y ?? 0, viewportHeight() - height()));
    if (props.placement === "top-right") return Math.min(1, viewportHeight() - height());
    return Math.max(0, Math.floor((viewportHeight() - height()) / 2));
  };
  const frame = () => (
    <box
      id="ui-overlay-frame"
      position="absolute"
      left={left()}
      top={top()}
      width={width()}
      height={height()}
      zIndex={props.zIndex ?? 100}
      border
      borderStyle="rounded"
      borderColor={props.theme.roles.borders.focused}
      backgroundColor={props.theme.roles.surfaces.panelRaised}
      flexDirection="column"
      paddingLeft={1}
      overflow="hidden"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {props.title ? (
        <text
          width={innerWidth()}
          fg={props.theme.roles.text.primary}
          bg={props.theme.roles.surfaces.panelRaised}
          overflow="hidden"
        >
          <strong>{clipTerminal(props.title, innerWidth())}</strong>
        </text>
      ) : null}
      {props.children}
      {props.footer ? (
        <text
          width={innerWidth()}
          fg={props.theme.roles.text.muted}
          bg={props.theme.roles.surfaces.panelRaised}
          overflow="hidden"
        >
          {clipTerminal(props.footer, innerWidth())}
        </text>
      ) : null}
    </box>
  );
  if (props.modal === false) return frame();
  return (
    <box
      id="ui-overlay-frame-host"
      position="absolute"
      left={0}
      top={0}
      width={viewportWidth()}
      height={viewportHeight()}
      zIndex={props.zIndex ?? 100}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (props.active !== false && props.dismissOnOutsidePress !== false) props.onDismiss?.();
      }}
    >
      {frame()}
    </box>
  );
}
