/* @jsxImportSource @opentui/solid */
import { Dynamic } from "@opentui/solid";
import { Show } from "solid-js";

import type { PaletteFeatureSession } from "../features/palette/contract.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { ApplicationOptionalFeatures } from "./application-optional-features.ts";
import type { PaletteProductionLoadState } from "./palette-production-controller.ts";

export interface PaletteProductionOverlayProps {
  readonly open: boolean;
  readonly width: number;
  readonly height: number;
  readonly overlayWidth: number;
  readonly loadState: PaletteProductionLoadState;
  readonly loadError: string;
  readonly feature?: ApplicationOptionalFeatures["palette"];
  readonly session?: PaletteFeatureSession;
  readonly theme: SemanticThemeSnapshot;
}

/** The production palette overlay mounted by application-root. */
export function PaletteProductionOverlay(props: PaletteProductionOverlayProps) {
  return (
    <Show when={props.open}>
      <Show
        when={props.feature && props.session}
        fallback={
          <box
            position="absolute"
            left={Math.max(0, Math.floor((props.width - props.overlayWidth) / 2))}
            top={Math.max(1, Math.floor(props.height / 6))}
            width={props.overlayWidth}
            flexDirection="column"
            backgroundColor={props.theme.roles.surfaces.command}
            border
            borderColor={
              props.loadState === "error"
                ? props.theme.roles.statusTone.danger
                : props.theme.roles.borders.focused
            }
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg={props.theme.roles.text.link} attributes={1}>
              {props.loadState === "error" ? "Unable to open Navigator" : "Opening Navigator…"}
            </text>
            <text fg={props.theme.roles.text.secondary}>
              {props.loadState === "error" ? props.loadError : "Loading command catalog"}
            </text>
            <text fg={props.theme.roles.text.muted}>
              {props.loadState === "error" ? "r retry · esc cancel" : "esc cancel"}
            </text>
          </box>
        }
      >
        <Dynamic
          component={props.feature!.PaletteFeatureSurface}
          session={props.session!}
          theme={props.theme}
        />
      </Show>
    </Show>
  );
}
