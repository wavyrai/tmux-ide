/* @jsxImportSource @opentui/solid */
import { Portal, useTerminalDimensions, type JSX } from "@opentui/solid";
import { type BoxRenderable } from "@opentui/core";

import { MODAL_BACKDROP, type SemanticThemeSnapshot } from "../theme.ts";
import { clipTerminal } from "../terminal-text.ts";
import { overlayFrameSize, overlaySurfacePadding, type OverlayPlacement } from "./overlay-model.ts";

export interface OverlayFrameProps {
  theme: SemanticThemeSnapshot;
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
  title?: string;
  /** Filled, padded surface without a drawn border. */
  surface?: boolean;
  footer?: string;
  placement?: OverlayPlacement;
  anchor?: Readonly<{ x: number; y: number }>;
  /** Lift an anchored workspace menu into the full application overlay plane. */
  viewportOrigin?: Readonly<{ x: number; y: number }>;
  modal?: boolean;
  active?: boolean;
  zIndex?: number;
  dismissOnOutsidePress?: boolean;
  onDismiss?: () => void;
  children?: JSX.Element;
}

/** Owns modal geometry and pointer capture without owning commands or renderer lifecycle. */
export function OverlayFrame(props: OverlayFrameProps) {
  const dimensions = useTerminalDimensions();
  const viewportWidth = () =>
    Math.max(1, Math.floor(props.viewportOrigin ? dimensions().width : props.viewportWidth));
  const viewportHeight = () =>
    Math.max(1, Math.floor(props.viewportOrigin ? dimensions().height : props.viewportHeight));
  const size = () =>
    overlayFrameSize({
      viewportWidth: viewportWidth(),
      viewportHeight: viewportHeight(),
      preferredWidth: props.width,
      preferredHeight: props.height,
    });
  const width = () => size().width;
  const height = () => size().height;
  // Empty border sides below keep OpenTUI border styling from enabling a frame.
  const bordered = () => props.surface === false && width() >= 4 && height() >= 3;
  const padding = () => overlaySurfacePadding(width(), height());
  const innerWidth = () =>
    Math.max(
      1,
      width() - (props.surface !== false ? padding().horizontal * 2 : bordered() ? 2 : 0),
    );
  const left = () => {
    if (props.placement === "anchor")
      return Math.max(
        0,
        Math.min(
          (props.anchor?.x ?? 0) + (props.viewportOrigin?.x ?? 0),
          viewportWidth() - width(),
        ),
      );
    if (props.placement === "top-right") return Math.max(0, viewportWidth() - width() - 1);
    return Math.max(0, Math.floor((viewportWidth() - width()) / 2));
  };
  const top = () => {
    if (props.placement === "anchor")
      return Math.max(
        0,
        Math.min(
          (props.anchor?.y ?? 0) + (props.viewportOrigin?.y ?? 0),
          viewportHeight() - height(),
        ),
      );
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
      border={bordered() ? true : []}
      borderStyle="rounded"
      borderColor={props.theme.roles.borders.focused}
      backgroundColor={
        props.surface !== false
          ? props.theme.roles.surfaces.command
          : props.theme.roles.surfaces.panelRaised
      }
      flexDirection="column"
      paddingLeft={props.surface !== false ? padding().horizontal : bordered() ? 1 : 0}
      paddingRight={props.surface !== false ? padding().horizontal : 0}
      paddingTop={props.surface !== false ? padding().vertical : 0}
      paddingBottom={props.surface !== false ? padding().vertical : 0}
      overflow="hidden"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {props.title && height() >= 4 ? (
        <box width={innerWidth()} height={1} flexShrink={0} flexDirection="row">
          <text
            width={Math.max(
              1,
              innerWidth() - (props.surface !== false && innerWidth() >= 20 ? 4 : 0),
            )}
            fg={props.theme.roles.text.primary}
            overflow="hidden"
          >
            <strong>
              {clipTerminal(
                props.title,
                Math.max(1, innerWidth() - (props.surface !== false && innerWidth() >= 20 ? 4 : 0)),
              )}
            </strong>
          </text>
          {props.surface !== false && innerWidth() >= 20 ? (
            <text
              width={4}
              fg={props.theme.roles.text.muted}
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.button === 0 && props.active !== false) props.onDismiss?.();
              }}
            >
              {" "}
              esc
            </text>
          ) : null}
        </box>
      ) : null}
      {props.children}
      {props.footer && height() >= 5 ? (
        <text
          width={innerWidth()}
          height={1}
          flexShrink={0}
          fg={props.theme.roles.text.muted}
          bg={
            props.surface !== false
              ? props.theme.roles.surfaces.command
              : props.theme.roles.surfaces.panelRaised
          }
          overflow="hidden"
        >
          {clipTerminal(props.footer, innerWidth())}
        </text>
      ) : null}
    </box>
  );
  if (props.modal === false) return frame();
  const host = () => (
    <box
      id="ui-overlay-frame-host"
      position="absolute"
      left={0}
      top={0}
      width={viewportWidth()}
      height={viewportHeight()}
      zIndex={props.zIndex ?? 100}
      backgroundColor={props.active === false ? undefined : MODAL_BACKDROP}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (props.active !== false && props.dismissOnOutsidePress !== false) props.onDismiss?.();
      }}
    >
      {frame()}
    </box>
  );
  return props.viewportOrigin ? (
    <Portal
      ref={(node) => {
        const container = node as BoxRenderable;
        container.position = "absolute";
        container.left = 0;
        container.top = 0;
        container.width = "100%";
        container.height = "100%";
        container.zIndex = props.zIndex ?? 100;
      }}
    >
      {host()}
    </Portal>
  ) : (
    host()
  );
}
