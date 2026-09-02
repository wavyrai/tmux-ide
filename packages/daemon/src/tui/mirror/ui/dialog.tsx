/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";

import type { SemanticThemeSnapshot } from "../theme.ts";
import { OverlayFrame } from "./overlay-frame.tsx";
import type { OverlayPlacement } from "./overlay-model.ts";

export interface DialogProps {
  theme: SemanticThemeSnapshot;
  viewportWidth: number;
  viewportHeight: number;
  width: number;
  height: number;
  title?: string;
  footer?: string;
  placement?: OverlayPlacement;
  active?: boolean;
  zIndex?: number;
  dismissOnOutsidePress?: boolean;
  onDismiss: () => void;
  children?: JSX.Element;
}

export function Dialog(props: DialogProps) {
  return (
    <OverlayFrame
      theme={props.theme}
      viewportWidth={props.viewportWidth}
      viewportHeight={props.viewportHeight}
      width={props.width}
      height={props.height}
      {...(props.title ? { title: props.title } : {})}
      {...(props.footer ? { footer: props.footer } : {})}
      {...(props.placement ? { placement: props.placement } : {})}
      {...(props.active !== undefined ? { active: props.active } : {})}
      {...(props.zIndex !== undefined ? { zIndex: props.zIndex } : {})}
      {...(props.dismissOnOutsidePress !== undefined
        ? { dismissOnOutsidePress: props.dismissOnOutsidePress }
        : {})}
      onDismiss={props.onDismiss}
    >
      {props.children}
    </OverlayFrame>
  );
}
