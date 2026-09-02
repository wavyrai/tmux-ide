/* @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid";
import { For, createEffect, createMemo, onCleanup } from "solid-js";

import {
  createOverlayFocusCoordinator,
  overlayEscapeTarget,
  overlayZIndex,
  type OverlayDismissReason,
} from "./overlay-host.ts";
import { useKeyboardRoute } from "./keyboard-router.tsx";

export interface OverlayLayerContext {
  readonly active: boolean;
  readonly zIndex: number;
}

export interface OverlayLayer {
  readonly id: string;
  readonly modal?: boolean;
  readonly dismissOnEscape?: boolean;
  readonly render: (context: OverlayLayerContext) => JSX.Element;
}

export interface OverlayHostProps {
  readonly width: number;
  readonly height: number;
  readonly layers: readonly OverlayLayer[];
  readonly ownsEscape?: boolean;
  readonly onDismiss: (id: string, reason: OverlayDismissReason) => void;
  readonly captureFocus?: () => string | null;
  readonly isFocusMounted?: (focusId: string) => boolean;
  readonly restoreFocus?: (focusId: string) => void;
}

/** One stack boundary for overlay ordering, keyboard admission, and focus restoration. */
export function OverlayHost(props: OverlayHostProps) {
  const layers = createMemo(() => props.layers);
  const focus = createOverlayFocusCoordinator({
    capture: () => props.captureFocus?.() ?? null,
    mounted: (id) => props.isFocusMounted?.(id) ?? false,
    restore: (id) => props.restoreFocus?.(id),
  });
  createEffect(() =>
    focus.sync(
      layers()
        .filter(({ modal }) => modal !== false)
        .map(({ id }) => id),
    ),
  );
  onCleanup(() => focus.dispose());
  useKeyboardRoute((event) => {
    if (props.ownsEscape === false) return false;
    const id = overlayEscapeTarget(layers(), event.name);
    if (!id) return false;
    event.preventDefault();
    event.stopPropagation();
    props.onDismiss(id, "escape");
    return true;
  });
  return (
    <For each={layers()}>
      {(layer, index) =>
        layer.render({
          active: index() === layers().length - 1,
          zIndex: overlayZIndex(index()),
        })
      }
    </For>
  );
}
