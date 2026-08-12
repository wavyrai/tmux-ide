/* @jsxImportSource @opentui/solid */
import type { SyntaxStyle } from "@opentui/core";
import { Dynamic } from "@opentui/solid";
import { For, Show, type JSX } from "solid-js";

import type { RichPreviewPublication } from "../features/rich-preview/contract.ts";
import type { RichPlacementProjection } from "../rich-placement-projection.ts";
import type { SemanticThemeSnapshot } from "../theme.ts";
import type { TuiRichWidgetSurfaceProps } from "../widget-surface.tsx";

export interface RichPreviewOverlayProps {
  readonly placementIds: readonly string[];
  readonly placementFor: (renderableId: string) => RichPlacementProjection | null;
  readonly publicationFor: (renderableId: string) => RichPreviewPublication | undefined;
  readonly surfaceComponent: ((props: TuiRichWidgetSurfaceProps) => JSX.Element) | undefined;
  readonly theme: SemanticThemeSnapshot;
  readonly syntaxStyle: SyntaxStyle | null;
  readonly wrapperRef?: (renderableId: string, wrapper: object) => void;
}

/** Stable production overlay seam: string IDs own wrapper identity; publications only update leaves. */
export function RichPreviewOverlay(props: RichPreviewOverlayProps): JSX.Element {
  return (
    <For each={props.placementIds}>
      {(renderableId) => (
        <Show when={props.placementFor(renderableId)}>
          {(placement) => (
            <Show when={props.publicationFor(renderableId) && props.surfaceComponent}>
              <box
                id={renderableId}
                ref={(wrapper: object) => props.wrapperRef?.(renderableId, wrapper)}
                position="absolute"
                left={placement().hostRect!.left}
                top={placement().hostRect!.top}
                width={placement().hostRect!.width}
                height={placement().hostRect!.height}
                overflow="hidden"
              >
                <Dynamic
                  component={props.surfaceComponent!}
                  surface={props.publicationFor(renderableId)!.resolution.surface}
                  theme={props.theme}
                  syntaxStyle={props.syntaxStyle}
                  width={placement().hostRect!.width}
                  height={placement().hostRect!.height}
                />
              </box>
            </Show>
          )}
        </Show>
      )}
    </For>
  );
}
